// Phase 1 proof: create → buy → bulk-buy fee → refund → fund → graduate → maker withdraw → resale → redeem.
// Resumable: progress is saved to keys/<network>/lifecycle-state.json, so a failed step can be re-run.
// Pass --fresh to start a new campaign.
import fs from 'fs'
import path from 'path'
import BN from 'bn.js'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  createMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DynamicBondingCurveClient,
  SwapMode,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { getConnection, getNetwork, explorerAccount } from '../network'
import { keysDir, loadWallets } from '../wallets'
import { send } from '../tx'
import { MIGRATION_FEE_OPTION, PROOF_CAMPAIGN, proofConfig } from '../campaign'

const USDC = 1_000_000 // 6 decimals
const usdc = (n: number) => new BN(Math.round(n * USDC))
const fmt = (bn: BN, decimals = 6) => (Number(bn.toString()) / 10 ** decimals).toFixed(4)

type State = {
  usdcMint?: string
  config?: string
  baseMint?: string
  pool?: string
  steps: Record<string, string | boolean>
}

const statePath = () => path.join(keysDir(), 'lifecycle-state.json')
const loadState = (): State => (fs.existsSync(statePath()) ? JSON.parse(fs.readFileSync(statePath(), 'utf8')) : { steps: {} })
const saveState = (s: State) => fs.writeFileSync(statePath(), JSON.stringify(s, null, 2))

async function main() {
  if (getNetwork().name !== 'devnet') throw new Error('lifecycle proof runs on devnet only')
  const connection = getConnection()
  const client = new DynamicBondingCurveClient(connection, 'confirmed')
  const w = loadWallets()
  const backers = [w.backer1, w.backer2, w.backer3]

  if (process.argv.includes('--fresh') && fs.existsSync(statePath())) {
    const prev = loadState()
    saveState({ usdcMint: prev.usdcMint, steps: { mockUsdc: prev.steps.mockUsdc ?? false } })
  }
  const s = loadState()

  const step = async (key: string, title: string, fn: () => Promise<string | boolean | void>) => {
    if (s.steps[key]) return console.log(`• ${title} (done)`)
    console.log(`• ${title}`)
    s.steps[key] = (await fn()) ?? true
    saveState(s)
  }

  // 1. Mock USDC ------------------------------------------------------------
  await step('mockUsdc', '1. Mock USDC mint + 150 USDC to each backer', async () => {
    if (!s.usdcMint) {
      const mint = await createMint(connection, w.platform, w.platform.publicKey, null, 6)
      s.usdcMint = mint.toBase58()
      saveState(s)
    }
    const mint = new PublicKey(s.usdcMint)
    const tx = new Transaction()
    for (const b of backers) {
      const ata = getAssociatedTokenAddressSync(mint, b.publicKey)
      tx.add(createAssociatedTokenAccountIdempotentInstruction(w.platform.publicKey, ata, b.publicKey, mint))
      tx.add(createMintToInstruction(mint, ata, w.platform.publicKey, 150 * USDC))
    }
    return send(connection, tx, [w.platform], 'mint mock USDC to backers')
  })
  const usdcMint = new PublicKey(s.usdcMint!)

  // 2+3. Config + pool in one transaction -----------------------------------
  await step('createPool', '2. Create config + pool in one tx (platform = partner, maker = creator)', async () => {
    const config = Keypair.generate()
    const baseMint = Keypair.generate()
    const params = proofConfig()
    const tx = await client.partner.createConfigAndPool({
      ...params,
      config: config.publicKey,
      feeClaimer: w.platform.publicKey,
      leftoverReceiver: w.platform.publicKey,
      quoteMint: usdcMint,
      payer: w.platform.publicKey,
      preCreatePoolParam: {
        name: PROOF_CAMPAIGN.name,
        symbol: PROOF_CAMPAIGN.symbol,
        uri: 'https://example.com/proof-hoodie.json',
        poolCreator: w.maker.publicKey,
        baseMint: baseMint.publicKey,
      },
    })
    const sig = await send(connection, tx, [w.platform, config, baseMint, w.maker], 'createConfigAndPool')
    s.config = config.publicKey.toBase58()
    s.baseMint = baseMint.publicKey.toBase58()
    s.pool = deriveDbcPoolAddress(usdcMint, baseMint.publicKey, config.publicKey).toBase58()
    console.log(`    config ${explorerAccount(s.config)}\n    pool   ${explorerAccount(s.pool)}`)
    const threshold = await client.state.getPoolMigrationQuoteThreshold(s.pool)
    console.log(`    goal (on-chain threshold): ${fmt(threshold)} USDC`)
    return sig
  })
  const pool = new PublicKey(s.pool!)
  const baseMint = new PublicKey(s.baseMint!)

  const currentPoint = async () => {
    const slot = await connection.getSlot()
    return new BN((await connection.getBlockTime(slot))!)
  }
  const quoteBuy = async (amount: number) => {
    const virtualPool = (await client.state.getPool(pool))!
    const config = (await client.state.getPoolConfig(virtualPool.poolState.config))!
    return client.pool.swapQuote({
      virtualPool,
      config,
      swapBaseForQuote: false,
      amountIn: usdc(amount),
      slippageBps: 100,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: await currentPoint(),
    })
  }
  const buy = async (buyer: Keypair, amount: number, label: string) => {
    const tx = await client.pool.swap2({
      owner: buyer.publicKey,
      pool,
      swapBaseForQuote: false,
      referralTokenAccount: null,
      swapMode: SwapMode.PartialFill,
      amountIn: usdc(amount),
      minimumAmountOut: new BN(0),
    })
    return send(connection, tx, [buyer], label)
  }
  const voucherBalance = async (owner: PublicKey) => {
    try {
      return new BN((await getAccount(connection, getAssociatedTokenAddressSync(baseMint, owner))).amount.toString())
    } catch {
      return new BN(0)
    }
  }

  // 4. Rate limiter proof ----------------------------------------------------
  await step('dropWindow', '3. Drop-bot window: quote a 2 USDC buy at launch, then after the window', async () => {
    const pct = (fee: BN, amt: number) => ((Number(fee.toString()) / (amt * USDC)) * 100).toFixed(2)
    const atLaunch = await quoteBuy(2)
    console.log(`    at launch      → fee ${fmt(atLaunch.tradingFee)} USDC (${pct(atLaunch.tradingFee, 2)}%)`)
    const waitMs = (PROOF_CAMPAIGN.dropWindowSec + 5) * 1000
    console.log(`    waiting ${waitMs / 1000}s for the window to close…`)
    await new Promise((r) => setTimeout(r, waitMs))
    const after = await quoteBuy(2)
    console.log(`    after window   → fee ${fmt(after.tradingFee)} USDC (${pct(after.tradingFee, 2)}%)`)
    return `launch ${pct(atLaunch.tradingFee, 2)}% / after ${pct(after.tradingFee, 2)}%`
  })

  // 5. First backers ---------------------------------------------------------
  await step('firstBuys', '4. backer1 and backer2 back the campaign (3 USDC each)', async () => {
    await buy(w.backer1, 3, 'backer1 buys 3 USDC')
    const sig = await buy(w.backer2, 3, 'backer2 buys 3 USDC')
    console.log(`    backer1 vouchers: ${fmt(await voucherBalance(w.backer1.publicKey))}`)
    return sig
  })

  // 6. Refund = sell back on the curve --------------------------------------
  await step('refund', '5. backer1 asks for a refund (sells all vouchers back)', async () => {
    const amount = await voucherBalance(w.backer1.publicKey)
    const usdcAta = getAssociatedTokenAddressSync(usdcMint, w.backer1.publicKey)
    const before = new BN((await getAccount(connection, usdcAta)).amount.toString())
    const tx = await client.pool.swap({
      owner: w.backer1.publicKey,
      pool,
      amountIn: amount,
      minimumAmountOut: new BN(0),
      swapBaseForQuote: true,
      referralTokenAccount: null,
    })
    const sig = await send(connection, tx, [w.backer1], 'backer1 sells vouchers back')
    const after = new BN((await getAccount(connection, usdcAta)).amount.toString())
    console.log(`    paid 3.0000 USDC, refunded ${fmt(after.sub(before))} USDC`)
    return sig
  })

  // 7. Fund the goal ---------------------------------------------------------
  await step('graduate', '6. Backers fund the rest of the goal in 5 USDC buys', async () => {
    let i = 0
    while ((await client.state.getPoolQuoteTokenCurveProgress(pool)) < 1) {
      const buyer = backers[i % backers.length]
      await buy(buyer, PROOF_CAMPAIGN.buySizeUsdc,`buy #${i + 1} (${Object.keys(w).find((k) => (w as any)[k] === buyer)})`)
      const progress = await client.state.getPoolQuoteTokenCurveProgress(pool)
      console.log(`    progress ${(progress * 100).toFixed(1)}%`)
      if (++i > 40) throw new Error('goal not reached after 40 buys')
    }
    return 'progress 100%'
  })

  // 8. Migrate to DAMM v2 ----------------------------------------------------
  await step('migrate', '7. Graduate: migrate to DAMM v2 (resale market)', async () => {
    const virtualPool = (await client.state.getPool(pool))!
    if (virtualPool.poolState.isMigrated) return 'already migrated by keeper'
    const { transaction, firstPositionNftKeypair, secondPositionNftKeypair } = await client.migration.migrateToDammV2({
      payer: w.platform.publicKey,
      pool,
      dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION],
    })
    return send(connection, transaction, [w.platform, firstPositionNftKeypair, secondPositionNftKeypair], 'migrateToDammV2')
  })
  const dammPool = deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION], baseMint, usdcMint)
  console.log(`    resale pool ${explorerAccount(dammPool)}`)

  // 9. Maker withdraws production budget ------------------------------------
  await step('makerWithdraw', '8. Maker withdraws the production budget (migration fee)', async () => {
    const makerAta = await getOrCreateAssociatedTokenAccount(connection, w.platform, usdcMint, w.maker.publicKey)
    const before = new BN(makerAta.amount.toString())
    const tx = await client.creator.creatorWithdrawMigrationFee({ pool, sender: w.maker.publicKey })
    const sig = await send(connection, tx, [w.maker], 'creatorWithdrawMigrationFee')
    const after = new BN((await getAccount(connection, makerAta.address)).amount.toString())
    console.log(`    maker received ${fmt(after.sub(before))} USDC`)
    return sig
  })

  // 10. Resale swap on DAMM v2 ----------------------------------------------
  await step('resale', '9. backer2 resells 1 voucher on the DAMM v2 pool', async () => {
    const cpAmm = new CpAmm(connection)
    const poolState = await cpAmm.fetchPoolState(dammPool)
    const slot = await connection.getSlot()
    const quote = cpAmm.getQuote({
      inAmount: usdc(1), // 1 voucher (6 decimals)
      inputTokenMint: baseMint,
      slippage: 1,
      poolState,
      currentTime: (await connection.getBlockTime(slot))!,
      currentSlot: slot,
      tokenADecimal: 6,
      tokenBDecimal: 6,
    })
    console.log(`    quote: 1 voucher → ${fmt(quote.swapOutAmount)} USDC (fee ${fmt(quote.totalFee)})`)
    const tx = await cpAmm.swap({
      payer: w.backer2.publicKey,
      pool: dammPool,
      inputTokenMint: baseMint,
      outputTokenMint: usdcMint,
      amountIn: usdc(1),
      minimumAmountOut: quote.minSwapOutAmount,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    })
    return send(connection, tx, [w.backer2], 'resale swap on DAMM v2')
  })

  // 11. Redeem = burn one whole voucher -------------------------------------
  await step('redeem', '10. backer3 redeems: burns 1 whole voucher', async () => {
    const ata = getAssociatedTokenAddressSync(baseMint, w.backer3.publicKey)
    const tx = new Transaction().add(createBurnInstruction(ata, baseMint, w.backer3.publicKey, 1 * USDC))
    const sig = await send(connection, tx, [w.backer3], 'burn 1 voucher')
    console.log(`    backer3 vouchers left: ${fmt(await voucherBalance(w.backer3.publicKey))}`)
    return sig
  })

  console.log('\nLifecycle complete. State:', statePath())
}

main().catch((e) => {
  console.error('\nFAILED:', e.stack ?? e)
  process.exit(1)
})
