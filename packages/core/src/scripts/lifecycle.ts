// Devnet proof of the whole campaign lifecycle, built on the campaign engine:
// trust tier → create → drop-bot fee → back → sell back → fund → graduate → maker withdraw → resale → redeem.
// Resumable: progress is saved to keys/devnet/lifecycle-state.json. Pass --fresh for a new campaign.
import fs from 'fs'
import path from 'path'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getOrCreateAssociatedTokenAccount,
} from '@solana/spl-token'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { explorerAccount, getConnection, getNetwork, trustRpcUrl } from '../network'
import { keysDir, loadWallets } from '../wallets'
import { send } from '../tx'
import { trustTier, type TrustTierName } from '../trust'
import { VOUCHER_DECIMALS, type Campaign } from '../engine'
import {
  buildBuyTx,
  buildCreateCampaignTx,
  buildMakerWithdrawTx,
  buildMigrateTx,
  buildRedeemTx,
  buildSellBackTx,
  dbcClient,
  getUsdcMint,
  resolveResalePool,
  saveMockUsdcMint,
  toUsdcRaw,
} from '../chain'

const TRUST_RPC = trustRpcUrl()
const fmt = (bn: BN | bigint, decimals = 6) => (Number(bn.toString()) / 10 ** decimals).toFixed(4)

// Small numbers so devnet can graduate it: goal ≈ 3·√(4·5) + 4·√(5·6) ≈ 35.3 USDC.
const proofCampaign = (makerSharePct: number): Campaign => ({
  name: 'Proof Hoodie',
  symbol: 'PHOOD',
  uri: 'https://example.com/proof-hoodie.json',
  plan: {
    tiers: [
      { units: 3, startPrice: 4 },
      { units: 4, startPrice: 5 },
    ],
    finalPrice: 6,
    makerSharePct,
  },
  dropBot: { startFeeBps: 5000, windowSec: 60 },
  normalFeeBps: 100,
})

type State = {
  tier?: TrustTierName
  makerSharePct?: number
  config?: string
  baseMint?: string
  pool?: string
  steps: Record<string, string | boolean>
}
const statePath = () => path.join(keysDir(), 'lifecycle-state.json')
const loadState = (): State => (fs.existsSync(statePath()) ? JSON.parse(fs.readFileSync(statePath(), 'utf8')) : { steps: {} })
const saveState = (s: State) => fs.writeFileSync(statePath(), JSON.stringify(s, null, 2))

async function balanceOf(connection: Connection, mint: PublicKey, owner: PublicKey) {
  try {
    return new BN((await getAccount(connection, getAssociatedTokenAddressSync(mint, owner))).amount.toString())
  } catch {
    return new BN(0)
  }
}

async function main() {
  if (getNetwork().name !== 'devnet') throw new Error('lifecycle proof runs on devnet only')
  const connection = getConnection()
  const client = dbcClient(connection)
  const w = loadWallets()
  const backers = [w.backer1, w.backer2, w.backer3]
  const name = (kp: Keypair) => Object.keys(w).find((k) => (w as any)[k] === kp)

  if (process.argv.includes('--fresh')) saveState({ steps: {} })
  const s = loadState()
  const step = async (key: string, title: string, fn: () => Promise<string | boolean | void>) => {
    if (s.steps[key]) return console.log(`• ${title} (done)`)
    console.log(`• ${title}`)
    s.steps[key] = (await fn()) ?? true
    saveState(s)
  }

  // Mock USDC (reused across runs) ------------------------------------------
  let usdcMint: PublicKey
  try {
    usdcMint = getUsdcMint()
  } catch {
    usdcMint = await createMint(connection, w.platform, w.platform.publicKey, null, 6)
    saveMockUsdcMint(usdcMint)
  }
  await step('topUp', `1. Top up backers to 150 mock USDC (${usdcMint.toBase58()})`, async () => {
    const tx = new Transaction()
    for (const b of backers) {
      const ata = getAssociatedTokenAddressSync(usdcMint, b.publicKey)
      const bal = await balanceOf(connection, usdcMint, b.publicKey)
      tx.add(createAssociatedTokenAccountIdempotentInstruction(w.platform.publicKey, ata, b.publicKey, usdcMint))
      const need = toUsdcRaw(150).sub(bal)
      if (need.gtn(0)) tx.add(createMintToInstruction(usdcMint, ata, w.platform.publicKey, BigInt(need.toString())))
    }
    return send(connection, tx, [w.platform], 'top up backers')
  })

  // Trust tier from the maker wallet's MAINNET history ----------------------
  await step('trust', '2. Maker trust tier (mainnet history of the maker wallet)', async () => {
    const r = await trustTier(new Connection(TRUST_RPC, 'confirmed'), w.maker.publicKey)
    r.reasons.forEach((x) => console.log(`    ${x}`))
    console.log(`    → tier ${r.tier} (score ${r.score}), maker share capped at ${r.maxMakerSharePct}%`)
    s.tier = r.tier
    s.makerSharePct = r.maxMakerSharePct
    return `tier ${r.tier}`
  })

  // Create ------------------------------------------------------------------
  await step('create', '3. Create campaign: config + pool in one tx', async () => {
    const built = await buildCreateCampaignTx({
      connection,
      campaign: proofCampaign(s.makerSharePct!),
      tier: s.tier!,
      platform: w.platform.publicKey,
      maker: w.maker.publicKey,
      usdcMint,
    })
    built.fields.forEach((f) => console.log(`    ${f.input.padEnd(16)} ${f.value.padEnd(38)} → ${f.dbcField}`))
    const sig = await send(connection, built.tx, [w.platform, ...built.extraSigners, w.maker], 'createConfigAndPool')
    s.config = built.config.toBase58()
    s.baseMint = built.baseMint.toBase58()
    s.pool = built.pool.toBase58()
    const threshold = await client.state.getPoolMigrationQuoteThreshold(built.pool)
    console.log(`    pool ${explorerAccount(built.pool)}`)
    console.log(`    goal: planned ${built.pricing.goalUsdc.toFixed(4)} USDC, on-chain ${fmt(threshold)} USDC`)
    return sig
  })
  const pool = new PublicKey(s.pool!)
  const baseMint = new PublicKey(s.baseMint!)

  const quoteBuy = async (usdc: number) => {
    const virtualPool = (await client.state.getPool(pool))!
    const config = (await client.state.getPoolConfig(virtualPool.poolState.config))!
    const slot = await connection.getSlot()
    return client.pool.swapQuote({
      virtualPool,
      config,
      swapBaseForQuote: false,
      amountIn: toUsdcRaw(usdc),
      slippageBps: 100,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN((await connection.getBlockTime(slot))!),
    })
  }
  const buy = async (buyer: Keypair, usdc: number) =>
    send(connection, await buildBuyTx(connection, buyer.publicKey, pool, usdc), [buyer], `${name(buyer)} backs ${usdc} USDC`)

  // Drop-bot window ---------------------------------------------------------
  await step('dropWindow', '4. Drop-bot fee: quote at launch, then after the window', async () => {
    const pct = (fee: BN, usdc: number) => ((Number(fee.toString()) / (usdc * 1e6)) * 100).toFixed(2)
    const atLaunch = await quoteBuy(2)
    console.log(`    at launch    → fee ${pct(atLaunch.tradingFee, 2)}%`)
    await new Promise((r) => setTimeout(r, 65_000))
    const after = await quoteBuy(2)
    console.log(`    after window → fee ${pct(after.tradingFee, 2)}%`)
    return `launch ${pct(atLaunch.tradingFee, 2)}% / after ${pct(after.tradingFee, 2)}%`
  })

  // Back + sell back --------------------------------------------------------
  await step('back', '5. backer1 and backer2 back 4 USDC each', async () => {
    await buy(w.backer1, 4)
    return buy(w.backer2, 4)
  })
  await step('sellBack', '6. backer1 exits: sells all vouchers back on the curve', async () => {
    const vouchers = await balanceOf(connection, baseMint, w.backer1.publicKey)
    const before = await balanceOf(connection, usdcMint, w.backer1.publicKey)
    const sig = await send(connection, await buildSellBackTx(connection, w.backer1.publicKey, pool, vouchers), [w.backer1], 'sell back')
    const after = await balanceOf(connection, usdcMint, w.backer1.publicKey)
    console.log(`    sold ${fmt(vouchers)} vouchers for ${fmt(after.sub(before))} USDC (paid 4.0000)`)
    return sig
  })

  // Fund the goal -----------------------------------------------------------
  await step('fund', '7. Backers fund the rest of the goal in 5 USDC buys', async () => {
    let i = 0
    while ((await client.state.getPoolQuoteTokenCurveProgress(pool)) < 1) {
      await buy(backers[i % backers.length], 5)
      console.log(`    progress ${((await client.state.getPoolQuoteTokenCurveProgress(pool)) * 100).toFixed(1)}%`)
      if (++i > 30) throw new Error('goal not reached after 30 buys')
    }
  })

  // Graduate ----------------------------------------------------------------
  await step('migrate', '8. Graduate to the DAMM v2 resale pool', async () => {
    if ((await client.state.getPool(pool))!.poolState.isMigrated) return 'migrated by keeper'
    const { tx, extraSigners } = await buildMigrateTx(connection, w.platform.publicKey, pool)
    const sig = await send(connection, tx, [w.platform, ...extraSigners], 'migrateToDammV2')
    const supply = (await getMint(connection, baseMint)).supply
    console.log(`    voucher supply after graduation: ${fmt(supply)} units (fixed supply: nothing minted or burned)`)
    return sig
  })
  const resalePool = await resolveResalePool(connection, { config: s.config!, baseMint: baseMint.toBase58(), usdcMint: usdcMint.toBase58() })
  console.log(`    resale pool ${explorerAccount(resalePool)}`)

  await step('withdraw', '9. Maker withdraws the production budget', async () => {
    const ata = await getOrCreateAssociatedTokenAccount(connection, w.platform, usdcMint, w.maker.publicKey)
    const before = new BN(ata.amount.toString())
    const sig = await send(connection, await buildMakerWithdrawTx(connection, w.maker.publicKey, pool), [w.maker], 'creatorWithdrawMigrationFee')
    const after = await balanceOf(connection, usdcMint, w.maker.publicKey)
    console.log(`    maker received ${fmt(after.sub(before))} USDC`)
    return sig
  })

  // Resale ------------------------------------------------------------------
  await step('resale', '10. A backer resells half a voucher on the resale pool', async () => {
    const seller = backers[1]
    const cpAmm = new CpAmm(connection)
    const poolState = await cpAmm.fetchPoolState(resalePool)
    const slot = await connection.getSlot()
    const amountIn = new BN(10 ** VOUCHER_DECIMALS / 2)
    const quote = cpAmm.getQuote({
      inAmount: amountIn,
      inputTokenMint: baseMint,
      slippage: 1,
      poolState,
      currentTime: (await connection.getBlockTime(slot))!,
      currentSlot: slot,
      tokenADecimal: 6,
      tokenBDecimal: 6,
    })
    console.log(`    0.5 voucher → ${fmt(quote.swapOutAmount)} USDC (fee ${fmt(quote.totalFee)})`)
    const tx = await cpAmm.swap({
      payer: seller.publicKey,
      pool: resalePool,
      inputTokenMint: baseMint,
      outputTokenMint: usdcMint,
      amountIn,
      minimumAmountOut: quote.minSwapOutAmount,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null,
    })
    return send(connection, tx, [seller], 'resale swap')
  })

  // Redeem ------------------------------------------------------------------
  await step('redeem', '11. Redeem: the backer holding the most vouchers burns 1', async () => {
    const holdings = await Promise.all(backers.map(async (b) => ({ b, v: await balanceOf(connection, baseMint, b.publicKey) })))
    const top = holdings.sort((x, y) => y.v.cmp(x.v))[0]
    if (top.v.lt(new BN(10 ** VOUCHER_DECIMALS))) throw new Error('no backer holds a whole voucher')
    const sig = await send(connection, buildRedeemTx(top.b.publicKey, baseMint), [top.b], `${name(top.b)} burns 1 voucher`)
    console.log(`    ${name(top.b)} vouchers: ${fmt(top.v)} → ${fmt(await balanceOf(connection, baseMint, top.b.publicKey))}`)
    return sig
  })

  console.log('\nLifecycle complete.')
}

main().catch((e) => {
  console.error('\nFAILED:', e.stack ?? e)
  process.exit(1)
})
