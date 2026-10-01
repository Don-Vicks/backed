// Curve swaps against the mainnet DBC program on a local validator (pnpm core:test:localnet):
// quote-derived minimums, sandwich protection, referral resolution and the capped last buy.
// Uses fresh keypairs and a fresh mock USDC mint, so it can share a validator with other runs.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createFreezeAccountInstruction,
  createMint,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { getNetwork } from '../../network'
import { send } from '../../tx'
import type { Campaign } from '../../engine'
import { buildBuyTx, buildCreateCampaignTx, buildSellBackTx, dbcClient, toUsdcRaw } from '../../chain'
import { quoteBuy, quoteSell } from '../../live'
import { SwapError, resolveReferral } from '../../swaps'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
const conn = new Connection(getNetwork({ ...process.env, NETWORK: 'localnet' }).rpcUrl, 'confirmed')

const SWAP2_DISCRIMINATOR = Buffer.from([65, 75, 63, 76, 235, 91, 91, 136])
const SLIPPAGE_ERROR = 6002 // DBC ExceededSlippage

// Goal ≈ 40·√(4·6) + 40·√(6·8) ≈ 473 USDC: small enough to fill, steep enough to sandwich.
const campaign: Campaign = {
  name: 'Swap Test Hoodie',
  symbol: 'SWAP',
  uri: 'https://example.com/swap.json',
  plan: { tiers: [{ units: 40, startPrice: 4 }, { units: 40, startPrice: 6 }], finalPrice: 8, makerSharePct: 10 },
  dropBot: { startFeeBps: 1500, windowSec: 60 },
  normalFeeBps: 100,
}

const platform = Keypair.generate()
const maker = Keypair.generate()
const [backer1, backer2, backer3] = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
let usdcMint: PublicKey
let pool: PublicKey
let baseMint: PublicKey

async function airdrop(pk: PublicKey) {
  const sig = await conn.requestAirdrop(pk, 10 * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

async function balance(mint: PublicKey, owner: PublicKey) {
  const account = await getAccount(conn, getAssociatedTokenAddressSync(mint, owner, true)).catch(() => null)
  return new BN((account?.amount ?? BigInt(0)).toString())
}

async function fundUsdc(owner: PublicKey, usdc: number) {
  const ata = getAssociatedTokenAddressSync(usdcMint, owner, true)
  const tx = new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, owner, usdcMint))
  if (usdc > 0) tx.add(createMintToInstruction(usdcMint, ata, platform.publicKey, BigInt(toUsdcRaw(usdc).toString())))
  await send(conn, tx, [platform], `fund ${owner.toBase58().slice(0, 4)} with ${usdc} USDC`)
  return ata
}

// The DBC swap2 instruction: discriminator, amount_0 u64, amount_1 u64, swap_mode u8.
function swap2Args(tx: Transaction) {
  const ix = tx.instructions.find((i) => i.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
  assert.ok(ix, 'no DBC instruction')
  assert.deepEqual(ix.data.subarray(0, 8), SWAP2_DISCRIMINATOR)
  return { amount0: new BN(ix.data.readBigUInt64LE(8).toString()), amount1: new BN(ix.data.readBigUInt64LE(16).toString()), mode: ix.data[24] }
}

async function simulationError(tx: Transaction, signer: Keypair) {
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash
  tx.feePayer = signer.publicKey
  tx.sign(signer)
  const sim = await conn.simulateTransaction(tx)
  return sim.value.err
}

before(async () => {
  if (skip) return
  process.env.NETWORK = 'localnet' // explorer links in the send() log
  process.env.PLATFORM_FEE_CLAIMER = platform.publicKey.toBase58()
  await Promise.all([platform, maker, backer1, backer2, backer3].map((k) => airdrop(k.publicKey)))
  // Freeze authority on, so a frozen referral account can be tested.
  usdcMint = await createMint(conn, platform, platform.publicKey, platform.publicKey, 6)
  for (const b of [backer1, backer2, backer3]) await fundUsdc(b.publicKey, 2000)
  const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: 'C', maker: maker.publicKey, usdcMint })
  await send(conn, built.tx, [maker, ...built.extraSigners], 'createConfigAndPool')
  pool = built.pool
  baseMint = built.baseMint
})

test('a buy carries the quote-derived minimum in its swap2 data', { skip }, async () => {
  const { tx, quote } = await buildBuyTx(conn, backer1.publicKey, pool, 20)
  const args = swap2Args(tx)
  assert.equal(args.mode, SwapMode.PartialFill)
  assert.ok(args.amount0.eq(toUsdcRaw(20)))
  assert.ok(args.amount1.gtn(0), 'minimumAmountOut must not be 0')
  assert.ok(args.amount1.eq(quote.minimumAmountOut!))
  // 100 bps below the expected output.
  assert.ok(quote.outputAmount.muln(9900).divn(10000).eq(quote.minimumAmountOut!))
  await send(conn, tx, [backer1], 'backer1 backs 20 USDC')
  assert.ok((await balance(baseMint, backer1.publicKey)).gte(quote.minimumAmountOut!))
})

test('one build reads the pool and its config once, for both the quote and swap2', { skip }, async () => {
  const reads = new Map<string, number>()
  const counted = new Proxy(conn, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      if (prop !== 'getAccountInfo' && prop !== 'getAccountInfoAndContext') return value.bind(target)
      return (key: PublicKey, ...rest: unknown[]) => {
        reads.set(key.toBase58(), (reads.get(key.toBase58()) ?? 0) + 1)
        return value.call(target, key, ...rest)
      }
    },
  })
  await buildBuyTx(counted, backer1.publicKey, pool, 1)
  const config = (await dbcClient(conn).state.getPool(pool))!.poolState.config
  assert.equal(reads.get(pool.toBase58()), 1)
  assert.equal(reads.get(config.toBase58()), 1)
})

test('a front-run between build and send makes the victim fail with ExceededSlippage', { skip }, async () => {
  const victim = await buildBuyTx(conn, backer2.publicKey, pool, 100)
  // Control: the same buy with no minimum would still fill, at the attacker's worse price.
  const unprotected = await dbcClient(conn).pool.swap2({
    owner: backer2.publicKey,
    pool,
    swapBaseForQuote: false,
    referralTokenAccount: null,
    swapMode: SwapMode.PartialFill,
    amountIn: toUsdcRaw(100),
    minimumAmountOut: new BN(0),
  })
  await send(conn, (await buildBuyTx(conn, backer3.publicKey, pool, 150)).tx, [backer3], 'attacker front-runs with 150 USDC')
  assert.equal(await simulationError(unprotected, backer2), null)
  const usdcBefore = await balance(usdcMint, backer2.publicKey)
  await assert.rejects(send(conn, victim.tx, [backer2], 'victim buy'), new RegExp(`"Custom":${SLIPPAGE_ERROR}`))
  assert.ok((await balance(usdcMint, backer2.publicKey)).eq(usdcBefore), 'victim keeps their USDC')
  // Rebuilt after the move, the victim's buy goes through at the new price.
  await send(conn, (await buildBuyTx(conn, backer2.publicKey, pool, 100)).tx, [backer2], 'victim retries')
})

test('a referrer without a USDC account is dropped and the buy succeeds', { skip }, async () => {
  const referrer = Keypair.generate().publicKey
  const ata = getAssociatedTokenAddressSync(usdcMint, referrer, true)
  // Control: naming the missing account fails the swap (AccountNotInitialized).
  const broken = await buildBuyTx(conn, backer1.publicKey, pool, 5, { referral: ata })
  const swapIndex = broken.tx.instructions.findIndex((i) => i.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID))
  assert.deepEqual(await simulationError(broken.tx, backer1), { InstructionError: [swapIndex, { Custom: 3012 }] })

  const referral = await resolveReferral(conn, usdcMint, referrer.toBase58(), backer1.publicKey)
  assert.equal(referral, null)
  await send(conn, (await buildBuyTx(conn, backer1.publicKey, pool, 5, { referral })).tx, [backer1], 'buy with an unfunded ref')
  assert.equal(await conn.getAccountInfo(ata), null, 'the buyer did not create the referrer account')
})

test('a referrer with a USDC account earns the referral fee', { skip }, async () => {
  const referrer = Keypair.generate().publicKey
  const ata = await fundUsdc(referrer, 0)
  const referral = await resolveReferral(conn, usdcMint, referrer.toBase58(), backer1.publicKey)
  assert.ok(referral?.equals(ata))
  const { tx, quote } = await buildBuyTx(conn, backer1.publicKey, pool, 20, { referral })
  assert.ok(quote.referralFee.gtn(0))
  await send(conn, tx, [backer1], 'buy with a funded ref')
  assert.ok((await balance(usdcMint, referrer)).gtn(0))
})

test('self-referral and frozen referral accounts are ignored', { skip }, async () => {
  assert.equal(await resolveReferral(conn, usdcMint, backer1.publicKey.toBase58(), backer1.publicKey), null)
  assert.equal(await resolveReferral(conn, usdcMint, 'not-a-wallet', backer1.publicKey), null)
  const referrer = Keypair.generate().publicKey
  const ata = await fundUsdc(referrer, 0)
  await send(conn, new Transaction().add(createFreezeAccountInstruction(ata, usdcMint, platform.publicKey)), [platform], 'freeze referrer account')
  assert.equal(await resolveReferral(conn, usdcMint, referrer.toBase58(), backer1.publicKey), null)
})

test('exit sells the chosen amount with a quote-derived minimum', { skip }, async () => {
  const held = await balance(baseMint, backer1.publicKey)
  const amount = held.divn(2)
  const preview = await quoteSell(conn, pool.toBase58(), Number(amount.toString()) / 1e6)
  const { tx, quote } = await buildSellBackTx(conn, backer1.publicKey, pool, amount)
  const args = swap2Args(tx)
  assert.equal(args.mode, SwapMode.ExactIn)
  assert.ok(args.amount0.eq(amount))
  assert.ok(args.amount1.gtn(0) && args.amount1.eq(quote.minimumAmountOut!))
  assert.ok(Math.abs(preview.usdc - Number(quote.outputAmount.toString()) / 1e6) < 0.01, 'preview matches the built quote')
  const usdcBefore = await balance(usdcMint, backer1.publicKey)
  await send(conn, tx, [backer1], 'backer1 exits half')
  assert.ok((await balance(baseMint, backer1.publicKey)).eq(held.sub(amount)), 'only the chosen amount was sold')
  assert.ok((await balance(usdcMint, backer1.publicKey)).sub(usdcBefore).gte(quote.minimumAmountOut!))
})

test('a 1000 USDC buy near the goal is quoted as capped and spends only what is left', { skip }, async () => {
  const client = dbcClient(conn)
  const threshold = await client.state.getPoolMigrationQuoteThreshold(pool)
  const preview = await quoteBuy(conn, pool.toBase58(), 1000)
  assert.equal(preview.capped, true)
  assert.ok(preview.spentUsdc < 1000)

  const { tx, quote } = await buildBuyTx(conn, backer3.publicKey, pool, 1000)
  assert.ok(!quote.amountLeft.isZero())
  const before = await balance(usdcMint, backer3.publicKey)
  await send(conn, tx, [backer3], 'last buy reaches the goal')
  const spent = before.sub(await balance(usdcMint, backer3.publicKey))
  const state = (await client.state.getPool(pool))!.poolState
  // At the goal, give or take the program's 1-unit rounding.
  assert.ok(state.quoteReserve.gte(threshold) && state.quoteReserve.sub(threshold).lten(1), `reserve ${state.quoteReserve} vs goal ${threshold}`)
  assert.ok((await client.state.getPoolQuoteTokenCurveProgress(pool)) >= 1)
  // Exactly what was left to the goal, plus the fee at execution time. The drop-bot fee only falls,
  // so that is at most what the quote said.
  assert.ok(spent.gte(quote.excludedFeeInputAmount), `spent ${spent} < remaining ${quote.excludedFeeInputAmount}`)
  assert.ok(spent.lte(quote.includedFeeInputAmount), `spent ${spent} > quoted ${quote.includedFeeInputAmount}`)

  // Once the goal is reached, quotes and buys answer 409 instead of building a failing transaction.
  await assert.rejects(quoteBuy(conn, pool.toBase58(), 10), (e: unknown) => e instanceof SwapError && e.status === 409)
  await assert.rejects(buildBuyTx(conn, backer1.publicKey, pool, 10), (e: unknown) => e instanceof SwapError && e.status === 409)
})
