// Back by whole units end to end on the local validator (mainnet DBC binary): ExactOut delivers
// exactly N vouchers, its maximumAmountIn guards against a front-run, a fractional balance tops up to
// a whole voucher, the last whole-unit buy sweeps the 0.000001 dust so the goal is reached, and a
// front-run never shrinks that last buy below the units asked for.
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import { buildBuyTx, buildCreateCampaignTx } from '../../chain'
import type { Campaign } from '../../engine'
import { readCampaignLive } from '../../live'
import { getNetwork } from '../../network'
import type { CampaignRecord } from '../../store'
import { send } from '../../tx'
import { buildBuyUnitsTx, buildTopUpTx, quoteBuyUnits, quoteTopUp, readCurve, unitsLeftRaw, unitsReferral } from '../../units'
import { UnitsError, maxUnitsLeft } from '../../voucher-units'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
Object.assign(process.env, { NETWORK: 'localnet' })

const POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')

let conn: Connection
const [platform, maker, alice, bob, carol, referrer] = Array.from({ length: 6 }, () => Keypair.generate())
let usdcMint: PublicKey
let record: CampaignRecord
let pool: PublicKey
let baseMint: PublicKey

async function airdrop(pk: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

async function balance(mint: PublicKey, owner: PublicKey) {
  const a = await getAccount(conn, getAssociatedTokenAddressSync(mint, owner)).catch(() => null)
  return new BN(a ? a.amount.toString() : '0')
}

function neededSigners(tx: Transaction, keys: Keypair[]) {
  return keys.filter((k) => tx.instructions.some((ix) => ix.keys.some((m) => m.isSigner && m.pubkey.equals(k.publicKey))))
}

async function simulate(tx: Transaction, signer: Keypair) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.feePayer = signer.publicKey
  tx.sign(signer)
  return (await conn.simulateTransaction(tx)).value
}

const campaign: Campaign = {
  name: 'Units Tee',
  symbol: 'UTEE',
  uri: 'https://example.com/utee.json',
  plan: { tiers: [{ units: 5, startPrice: 4 }, { units: 6, startPrice: 5 }], finalPrice: 6, makerSharePct: 20 },
  dropBot: { startFeeBps: 500, windowSec: 10 },
  normalFeeBps: 100,
  shipDays: 30,
}

before(async () => {
  if (skip) return
  conn = new Connection(getNetwork().rpcUrl, 'confirmed')
  if ((await conn.getBalance(POOL_AUTHORITY)) < 1 * LAMPORTS_PER_SOL) await airdrop(POOL_AUTHORITY, 5)
  for (const k of [platform, maker, alice, bob, carol, referrer]) await airdrop(k.publicKey, 20)
  process.env.PLATFORM_FEE_CLAIMER = platform.publicKey.toBase58()
  usdcMint = await createMint(conn, platform, platform.publicKey, null, 6)
  const fund = new Transaction()
  for (const k of [alice, bob, carol, referrer]) {
    const ata = getAssociatedTokenAddressSync(usdcMint, k.publicKey)
    fund.add(createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, k.publicKey, usdcMint), createMintToInstruction(usdcMint, ata, platform.publicKey, 1_000_000_000n))
  }
  await send(conn, fund, [platform], 'mint test USDC')

  const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: 'A', platform: platform.publicKey, maker: maker.publicKey, usdcMint })
  await send(conn, built.tx, [...neededSigners(built.tx, [maker, platform]), ...built.extraSigners], 'create units campaign')
  pool = built.pool
  baseMint = built.baseMint
  record = {
    pool: pool.toBase58(),
    config: built.config.toBase58(),
    baseMint: baseMint.toBase58(),
    usdcMint: usdcMint.toBase58(),
    maker: maker.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    createSignature: '',
    campaign,
    trust: { tier: 'A', score: 80, reasons: [], maxMakerSharePct: 40 },
    goalUsdc: built.onChain.goalUsdc,
    totalUnits: built.onChain.totalUnits,
    fields: [],
  }
})

// Each curve segment is sized a few raw units over its tier (CURVE_MARGIN_RAW), so the curve sells at
// least the planned units despite DBC rounding swap output down.
test('the curve sells at least the planned units, plus a few raw units of margin', { skip }, async () => {
  const left = unitsLeftRaw(await readCurve(conn, pool))
  assert.ok(left >= BigInt(11_000_000) && left < BigInt(11_000_000 + 100), `left ${left}`)
})

test('buyUnits(1) leaves a balance of exactly 1_000_000, within the quoted maximum', { skip, timeout: 60_000 }, async () => {
  const quote = await quoteBuyUnits(conn, pool, 1)
  assert.equal(quote.mode, 'exactOut')
  assert.equal(quote.vouchers, 1)
  assert.equal(quote.maxUnits, maxUnitsLeft(unitsLeftRaw(await readCurve(conn, pool))))
  assert.ok(quote.maxUsdc > quote.usdc && quote.maxUsdc <= quote.usdc * 1.0101, `${quote.maxUsdc} vs ${quote.usdc}`)
  const usdcBefore = await balance(usdcMint, alice.publicKey)
  const { tx, plan } = await buildBuyUnitsTx(conn, alice.publicKey, pool, 1)
  await send(conn, tx, [alice], 'alice backs 1 unit (ExactOut)')
  assert.equal((await balance(baseMint, alice.publicKey)).toString(), '1000000')
  const spent = usdcBefore.sub(await balance(usdcMint, alice.publicKey))
  assert.ok(spent.lte(plan.maxAmountIn), `spent ${spent} > max ${plan.maxAmountIn}`)
  assert.ok(spent.gtn(0))
})

test('a referral to an account that exists pays the referrer; a missing one is dropped', { skip, timeout: 60_000 }, async () => {
  assert.equal(await unitsReferral(conn, usdcMint, alice.publicKey.toBase58(), alice.publicKey), null, 'self-referral')
  assert.equal(await unitsReferral(conn, usdcMint, maker.publicKey.toBase58(), alice.publicKey), null, 'no USDC account')
  assert.equal(await unitsReferral(conn, usdcMint, 'not-a-key', alice.publicKey), null)
  const referral = await unitsReferral(conn, usdcMint, referrer.publicKey.toBase58(), alice.publicKey)
  assert.ok(referral)
  const before = await balance(usdcMint, referrer.publicKey)
  const { tx } = await buildBuyUnitsTx(conn, alice.publicKey, pool, 1, { referral })
  await send(conn, tx, [alice], 'alice backs 1 more unit with a referral')
  assert.equal((await balance(baseMint, alice.publicKey)).toString(), '2000000')
  assert.ok((await balance(usdcMint, referrer.publicKey)).gt(before), 'referrer earned a fee')
})

test('a front-run between build and send makes the ExactOut buy fail on its maximum', { skip, timeout: 60_000 }, async () => {
  const victim = await buildBuyUnitsTx(conn, carol.publicKey, pool, 1)
  // Bob takes 2 units first; the price rises by more than the 1% the victim allowed.
  const front = await buildBuyUnitsTx(conn, bob.publicKey, pool, 2)
  await send(conn, front.tx, [bob], 'bob front-runs 2 units')
  const sim = await simulate(victim.tx, carol)
  assert.ok(sim.err, 'victim swap should fail')
  assert.match((sim.logs ?? []).join('\n'), /ExceededSlippage|slippage/i)
})

test('a fractional balance from a USDC-amount buy tops up to exactly the next whole voucher', { skip, timeout: 60_000 }, async () => {
  await send(conn, await buildBuyTx(conn, carol.publicKey, pool, 2), [carol], 'carol backs $2 (fractional)')
  const frac = await balance(baseMint, carol.publicKey)
  assert.ok(frac.gtn(0) && frac.ltn(1_000_000), `fraction ${frac}`)
  const quote = await quoteTopUp(conn, pool, carol.publicKey, baseMint)
  assert.equal(quote.vouchers, (1_000_000 - frac.toNumber()) / 1e6)
  const { tx } = await buildTopUpTx(conn, carol.publicKey, pool, baseMint)
  await send(conn, tx, [carol], 'carol tops up to 1')
  assert.equal((await balance(baseMint, carol.publicKey)).toString(), '1000000')
  await assert.rejects(buildTopUpTx(conn, carol.publicKey, pool, baseMint), (e: unknown) => e instanceof UnitsError && e.status === 400)
})

test('backing 2 units (the Blink default) simulates, and more units than are left is refused', { skip, timeout: 60_000 }, async () => {
  const left = await quoteBuyUnits(conn, pool, 1)
  assert.ok(left.maxUnits >= 3, `max ${left.maxUnits}`)
  const { tx, quote } = await buildBuyUnitsTx(conn, bob.publicKey, pool, 2)
  assert.equal(quote.vouchers, 2)
  const sim = await simulate(tx, bob)
  assert.equal(sim.err, null, (sim.logs ?? []).join('\n'))
  await assert.rejects(quoteBuyUnits(conn, pool, left.maxUnits + 1), (e: unknown) => e instanceof UnitsError && e.status === 409)
})

test('a near-goal buyUnits sweeps the rest and completes the pool (progress = 1)', { skip, timeout: 60_000 }, async () => {
  const curve = await readCurve(conn, pool)
  const remaining = unitsLeftRaw(curve)
  const max = (await quoteBuyUnits(conn, pool, 1)).maxUnits
  const quote = await quoteBuyUnits(conn, pool, max)
  assert.equal(quote.mode, 'sweep')
  assert.equal(quote.completesGoal, true)
  assert.equal(quote.vouchers, Number(remaining) / 1e6)
  const before = await balance(baseMint, bob.publicKey)
  const { tx } = await buildBuyUnitsTx(conn, bob.publicKey, pool, max)
  await send(conn, tx, [bob], `bob backs the last ${max} units (sweep)`)
  const got = (await balance(baseMint, bob.publicKey)).sub(before)
  assert.ok(got.gte(new BN(max).muln(1_000_000)), `got ${got}`)
  assert.equal(got.toString(), remaining.toString())
  const live = await readCampaignLive(conn, record)
  assert.equal(live.status, 'funded')
  assert.equal(live.progress, 1)
  await assert.rejects(quoteBuyUnits(conn, pool, 1), (e: unknown) => e instanceof UnitsError && e.status === 409 && /goal/.test(e.message))
})

// A fresh 2 + 2 unit campaign, for tests that need the whole curve to themselves.
const smallPlan = { tiers: [{ units: 2, startPrice: 3 }, { units: 2, startPrice: 4 }], finalPrice: 5, makerSharePct: 10 }

async function createSmall(small: Campaign) {
  const built = await buildCreateCampaignTx({ connection: conn, campaign: small, tier: 'A', platform: platform.publicKey, maker: maker.publicKey, usdcMint })
  await send(conn, built.tx, [...neededSigners(built.tx, [maker, platform]), ...built.extraSigners], `create ${small.symbol}`)
  return built
}

test('whole-unit buys alone reach the goal of a fresh campaign', { skip, timeout: 120_000 }, async () => {
  const small: Campaign = { ...campaign, name: 'Units Cap', symbol: 'UCAP', plan: smallPlan }
  const built = await createSmall(small)
  const smallRecord: CampaignRecord = { ...record, pool: built.pool.toBase58(), config: built.config.toBase58(), baseMint: built.baseMint.toBase58(), campaign: small, goalUsdc: built.onChain.goalUsdc, totalUnits: built.onChain.totalUnits }
  const backers = [alice, bob, carol, referrer]
  let buys = 0
  while ((await readCampaignLive(conn, smallRecord)).status === 'funding') {
    assert.ok(buys < 4, 'four 1-unit buys must be enough for a 4-unit plan')
    const who = backers[buys++]
    const { tx, quote } = await buildBuyUnitsTx(conn, who.publicKey, built.pool, 1)
    await send(conn, tx, [who], `${quote.mode === 'sweep' ? 'last' : 'next'} unit (${quote.mode})`)
    const held = await balance(built.baseMint, who.publicKey)
    assert.ok(held.gten(1_000_000), 'every backer holds at least one whole voucher')
    // The last backer takes only the margin on top, not most of another voucher.
    assert.ok(held.ltn(1_001_000), `backer holds ${held}`)
  }
  assert.equal(buys, 4)
  assert.equal((await readCampaignLive(conn, smallRecord)).progress, 1)
})

test('a front-run before the last buy makes the sweep fail rather than deliver a fraction', { skip, timeout: 120_000 }, async () => {
  const built = await createSmall({ ...campaign, name: 'Units Race', symbol: 'URACE', plan: smallPlan })
  await send(conn, (await buildBuyUnitsTx(conn, alice.publicKey, built.pool, 3)).tx, [alice], 'alice backs 3 of 4 units')
  // Carol's "Back 1" takes the rest (1.00001x left) and must get at least the unit she asked for.
  const victim = await buildBuyUnitsTx(conn, carol.publicKey, built.pool, 1)
  assert.equal(victim.plan.mode, 'sweep')
  assert.ok(victim.plan.minAmountOut.gten(1_000_000), `min out ${victim.plan.minAmountOut}`)
  // A few cents bought first would leave her about 0.993 of a voucher; the swap fails instead.
  await send(conn, await buildBuyTx(conn, bob.publicKey, built.pool, 0.03), [bob], 'bob buys $0.03 first')
  assert.ok(unitsLeftRaw(await readCurve(conn, built.pool)) < BigInt(1_000_000), 'the front-run cut into the last unit')
  const sim = await simulate(victim.tx, carol)
  assert.ok(sim.err, 'victim sweep should fail')
  assert.match((sim.logs ?? []).join('\n'), /ExceededSlippage|slippage/i)
  // Re-quoted, the buy says plainly that it takes less than a whole voucher.
  const again = await quoteBuyUnits(conn, built.pool, 1)
  assert.equal(again.completesGoal, true)
  assert.ok(again.vouchers < 1, `vouchers ${again.vouchers}`)
})
