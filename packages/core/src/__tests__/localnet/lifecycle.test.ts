// The whole campaign lifecycle against the mainnet DBC and DAMM v2 programs on a local validator
// (pnpm core:test:localnet): create → back → exit → PartialFill to the goal → graduate → maker
// withdraws the budget → resale buy and sell → maker claims fees → a backer redeems a voucher.
// Every step asserts the balances it moves; graduation also asserts the DAMM v2 positions.
// The world comes from seedLocalnet() in a temp PREORDER_ROOT: fresh keys and mint, so it can share
// a validator with other suites.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync, getMint, getOrCreateAssociatedTokenAccount } from '@solana/spl-token'
import { getNetwork } from '../../network'
import { send } from '../../tx'
import { closeDb } from '../../db'
import type { Campaign } from '../../engine'
import type { CampaignRecord } from '../../store'
import {
  buildBuyTx,
  buildCreateCampaignTx,
  buildMakerWithdrawTx,
  buildMigrateTx,
  buildRedeemTx,
  buildSellBackTx,
  dbcClient,
  resalePoolAddress,
} from '../../chain'
import { buildMakerClaimTx, buildResaleSwapTx, readMakerEarnings } from '../../resale'
import { listRedemptions, saveRedemption, verifyBurn } from '../../redemptions'
import { inspectDbcPool, type PoolView } from '../../inspect'
import { SEED_BACKER_USDC, seedLocalnet, type Seeded } from '../../localnet'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
const net = getNetwork({ ...process.env, NETWORK: 'localnet' })
const conn = new Connection(net.rpcUrl, 'confirmed')

const USDC = 1_000_000 // raw units per USDC, and per voucher (both 6 decimals)
const MAKER_SHARE_PCT = 10

// Goal ≈ 3·√(4·5) + 4·√(5·6) ≈ 35.3 USDC.
const campaign: Campaign = {
  name: 'Lifecycle Hoodie',
  symbol: 'LHOOD',
  uri: 'http://127.0.0.1:3201/m/lifecycle',
  plan: { tiers: [{ units: 3, startPrice: 4 }, { units: 4, startPrice: 5 }], finalPrice: 6, makerSharePct: MAKER_SHARE_PCT },
  dropBot: { startFeeBps: 1500, windowSec: 60 },
  normalFeeBps: 100,
}

let seeded: Seeded
let w: Seeded['wallets']
let usdcMint: PublicKey
let record: CampaignRecord
let pool: PublicKey
let baseMint: PublicKey
let goalRaw: BN

const raw = async (mint: PublicKey, owner: PublicKey) => {
  const account = await getAccount(conn, getAssociatedTokenAddressSync(mint, owner)).catch(() => null)
  return new BN((account?.amount ?? BigInt(0)).toString())
}
const usdcOf = (kp: Keypair) => raw(usdcMint, kp.publicKey)
const vouchersOf = (kp: Keypair) => raw(baseMint, kp.publicKey)
// The swap builders return a Transaction today and { tx, quote } once swaps carry quote-derived minimums.
const txOf = (built: Transaction | { tx: Transaction }) => ('tx' in built ? built.tx : built)
const inspect = (): Promise<PoolView> => inspectDbcPool(conn, pool)

before(async () => {
  if (skip) return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-localnet-lifecycle-'))
  process.env.NETWORK = 'localnet'
  process.env.DATA_DIR = path.join(root, 'data')
  closeDb()
  seeded = await seedLocalnet(conn, root)
  w = seeded.wallets
  usdcMint = seeded.usdcMint
  process.env.PLATFORM_FEE_CLAIMER = w.platform.publicKey.toBase58()
})

test('seed: wallets, mock USDC with the platform as mint authority, env file', { skip }, async () => {
  const mint = await getMint(conn, usdcMint)
  assert.ok(mint.mintAuthority?.equals(w.platform.publicKey))
  for (const b of [w.backer1, w.backer2, w.backer3]) assert.equal((await usdcOf(b)).toString(), String(SEED_BACKER_USDC * USDC))
  assert.equal((await usdcOf(w.referrer)).toString(), '0', 'the referrer starts without a USDC account')
  const env = fs.readFileSync(seeded.envFile, 'utf8')
  assert.match(env, /^NETWORK=localnet$/m)
  assert.match(env, new RegExp(`^USDC_MINT=${usdcMint.toBase58()}$`, 'm'))
  assert.ok(fs.existsSync(path.join(seeded.root, 'keys', 'localnet', 'platform.json')))
})

test('create: config and pool in one transaction, on the terms the engine computed', { skip }, async () => {
  // The maker is the payer here, so this signs the same way before and after the maker-pays change.
  const args = { connection: conn, campaign, tier: 'C' as const, platform: w.maker.publicKey, maker: w.maker.publicKey, usdcMint }
  const built = await buildCreateCampaignTx(args)
  const sig = await send(conn, built.tx, [w.maker, ...built.extraSigners], 'create')
  pool = built.pool
  baseMint = built.baseMint
  console.log(`    pool ${pool.toBase58()} (pnpm --filter @preorder/core inspect <pool>)`)
  goalRaw = await dbcClient(conn).state.getPoolMigrationQuoteThreshold(pool)
  record = {
    pool: pool.toBase58(),
    config: built.config.toBase58(),
    baseMint: baseMint.toBase58(),
    usdcMint: usdcMint.toBase58(),
    maker: w.maker.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    createSignature: sig,
    campaign,
    trust: { tier: 'C', score: 0, reasons: [], maxMakerSharePct: MAKER_SHARE_PCT },
    goalUsdc: built.onChain.goalUsdc,
    totalUnits: built.onChain.totalUnits,
    fields: built.fields,
  }

  const view = await inspect()
  assert.equal(view.creator, w.maker.publicKey.toBase58())
  assert.equal(view.migrated, false)
  assert.equal(view.config.feeClaimer, w.platform.publicKey.toBase58(), 'PLATFORM_FEE_CLAIMER is the partner')
  assert.equal(view.config.leftoverReceiver, w.platform.publicKey.toBase58())
  assert.equal(view.config.quoteMint, usdcMint.toBase58())
  assert.equal(view.config.migrationOption, 'MET_DAMM_V2')
  assert.equal(view.config.migrationFee.pct, MAKER_SHARE_PCT)
  assert.equal(view.config.migrationFee.creatorPct, 100)
  assert.equal(view.config.baseFee.startBps, campaign.dropBot.startFeeBps)
  assert.equal(view.config.goalUsdc, built.onChain.goalUsdc)
  const lp = view.config.lp
  assert.equal(lp.partnerPct + lp.partnerLockedPct + lp.creatorPct + lp.creatorLockedPct + view.config.creatorVesting.vestingPercentage + view.config.partnerVesting.vestingPercentage, 100)
})

test('back: a buy spends exactly the USDC sent and mints vouchers', { skip }, async () => {
  const before = await usdcOf(w.backer1)
  await send(conn, txOf(await buildBuyTx(conn, w.backer1.publicKey, pool, 5)), [w.backer1], 'backer1 backs 5')
  assert.equal(before.sub(await usdcOf(w.backer1)).toString(), String(5 * USDC))
  assert.ok((await vouchersOf(w.backer1)).gtn(0))
})

test('exit: selling every voucher back returns USDC, less than was paid', { skip }, async () => {
  const vouchers = await vouchersOf(w.backer1)
  const before = await usdcOf(w.backer1)
  await send(conn, txOf(await buildSellBackTx(conn, w.backer1.publicKey, pool, vouchers)), [w.backer1], 'backer1 sells back')
  const got = (await usdcOf(w.backer1)).sub(before)
  assert.equal((await vouchersOf(w.backer1)).toString(), '0')
  assert.ok(got.gtn(0) && got.ltn(5 * USDC), `got ${got} raw USDC back for a 5 USDC buy`)
})

test('fund: a PartialFill buy larger than what is left stops exactly at the goal', { skip }, async () => {
  await send(conn, txOf(await buildBuyTx(conn, w.backer3.publicKey, pool, 6)), [w.backer3], 'backer3 backs 6')
  const before = await usdcOf(w.backer2)
  await send(conn, txOf(await buildBuyTx(conn, w.backer2.publicKey, pool, 100)), [w.backer2], 'backer2 backs 100 (capped)')
  const spent = before.sub(await usdcOf(w.backer2))
  assert.ok(spent.gtn(0) && spent.lt(new BN(100 * USDC)), `spent ${spent} raw USDC of 100`)
  const state = (await dbcClient(conn).state.getPool(pool))!.poolState
  assert.ok(state.quoteReserve.gte(goalRaw), `reserve ${state.quoteReserve} reaches the goal ${goalRaw}`)
  assert.equal(await dbcClient(conn).state.getPoolQuoteTokenCurveProgress(pool), 1)
  await assert.rejects(
    async () => send(conn, txOf(await buildBuyTx(conn, w.backer1.publicKey, pool, 1)), [w.backer1], 'buy after the goal'),
    'the curve is closed once the goal is reached',
  )
})

test('graduate: DAMM v2 resale pool with locked maker and partner positions, buffer burned', { skip }, async () => {
  const { tx, extraSigners } = await buildMigrateTx(conn, w.backer3.publicKey, pool)
  await send(conn, tx, [w.backer3, ...extraSigners], 'migrate')
  const view = await inspect()
  assert.equal(view.migrated, true)
  assert.ok(view.resale, 'resale pool exists')
  assert.equal(view.resale.address, resalePoolAddress(baseMint, usdcMint).toBase58())
  assert.equal((await getMint(conn, baseMint)).supply.toString(), view.config.supply.postMigration, 'unused swap buffer burned')

  const byRole = (role: string) => view.resale!.positions.filter((p) => p.role === role)
  const [maker] = byRole('creator')
  const [partner] = byRole('partner')
  assert.ok(maker, 'the maker holds a position')
  assert.ok(partner, 'the partner (fee claimer) holds a position')
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.02
  assert.ok(near(maker.permanentLockedPct, view.config.lp.creatorLockedPct), `maker permanently locked ${maker.permanentLockedPct}%`)
  assert.ok(near(partner.permanentLockedPct, view.config.lp.partnerLockedPct), `partner permanently locked ${partner.permanentLockedPct}%`)
  const total = view.resale.positions.reduce((a, p) => a + p.sharePct, 0)
  assert.ok(near(total, 100), `positions hold ${total}% of the pool`)
})

test('withdraw: the maker receives exactly the configured share of the goal', { skip }, async () => {
  await getOrCreateAssociatedTokenAccount(conn, w.platform, usdcMint, w.maker.publicKey)
  await send(conn, await buildMakerWithdrawTx(conn, w.maker.publicKey, pool), [w.maker], 'maker withdraws budget')
  const expected = goalRaw.muln(MAKER_SHARE_PCT).divn(100)
  const got = await usdcOf(w.maker)
  assert.ok(got.sub(expected).abs().lten(1), `maker got ${got}, expected ${expected}`)
  assert.ok(((await inspect()).migrationFeeWithdrawStatus & 0b10) !== 0, 'creator withdraw bit set')
  await assert.rejects(async () => send(conn, await buildMakerWithdrawTx(conn, w.maker.publicKey, pool), [w.maker], 'second withdraw'))
})

test('resale: buy and sell vouchers on the DAMM v2 pool', { skip }, async () => {
  const usdcBefore = await usdcOf(w.backer1)
  await send(conn, await buildResaleSwapTx(conn, record, w.backer1.publicKey, 'buy', 10), [w.backer1], 'resale buy 10 USDC')
  assert.equal(usdcBefore.sub(await usdcOf(w.backer1)).toString(), String(10 * USDC))
  assert.ok((await vouchersOf(w.backer1)).gtn(USDC), 'more than one voucher for 10 USDC near a $6 final price')

  const vouchersBefore = await vouchersOf(w.backer2)
  const usdc2 = await usdcOf(w.backer2)
  await send(conn, await buildResaleSwapTx(conn, record, w.backer2.publicKey, 'sell', 0.5), [w.backer2], 'resale sell 0.5')
  assert.equal(vouchersBefore.sub(await vouchersOf(w.backer2)).toString(), String(USDC / 2))
  assert.ok((await usdcOf(w.backer2)).gt(usdc2))
})

test('claim: one transaction pays the maker curve fees and resale fees', { skip }, async () => {
  const earned = await readMakerEarnings(conn, record)
  assert.ok(earned.curveFeesUnclaimedUsdc > 0, 'curve trading fees accrued')
  assert.ok(earned.resaleFeesUnclaimedUsdc > 0, 'resale fees accrued on the locked position')
  const tx = await buildMakerClaimTx(conn, record)
  assert.ok(tx)
  const before = await usdcOf(w.maker)
  await send(conn, tx, [w.maker], 'maker claims')
  const got = Number((await usdcOf(w.maker)).sub(before).toString()) / USDC
  const expected = earned.curveFeesUnclaimedUsdc + earned.resaleFeesUnclaimedUsdc
  assert.ok(Math.abs(got - expected) <= 2e-6, `claimed ${got} USDC, expected ${expected}`)
  const after = await readMakerEarnings(conn, record)
  assert.equal(after.curveFeesUnclaimedUsdc, 0)
  assert.equal(after.resaleFeesUnclaimedUsdc, 0)
  assert.equal(await buildMakerClaimTx(conn, record), null, 'nothing left to claim')
})

test('redeem: burning one voucher is verified on-chain and recorded once', { skip }, async () => {
  const holder = w.backer2
  const vouchers = await vouchersOf(holder)
  const supply = (await getMint(conn, baseMint)).supply
  assert.ok(vouchers.gten(USDC), 'backer2 holds a whole voucher')
  const sig = await send(conn, buildRedeemTx(holder.publicKey, baseMint), [holder], 'backer2 burns 1 voucher')
  assert.equal(vouchers.sub(await vouchersOf(holder)).toString(), String(USDC))
  assert.equal(supply - (await getMint(conn, baseMint)).supply, BigInt(USDC))

  assert.equal(await verifyBurn(conn, record, sig, holder.publicKey), 1)
  await assert.rejects(verifyBurn(conn, record, sig, w.backer1.publicKey), /does not burn a whole voucher/)
  const shipping = { name: 'Ada Lovelace', email: 'ada@example.com', address: '12 Analytical Way', country: 'UK' }
  const redemption = { pool: record.pool, signature: sig, wallet: holder.publicKey.toBase58(), units: 1, shipping, createdAt: new Date().toISOString() }
  saveRedemption(redemption)
  assert.throws(() => saveRedemption(redemption), /already submitted/)
  const [listed] = listRedemptions(record.pool)
  assert.deepEqual(listed.shipping, shipping)
})
