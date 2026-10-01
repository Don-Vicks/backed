// Maker-set resale royalty end to end on the local validator (mainnet DBC + DAMM v2 binaries): a
// Customizable resale pool with ship-window vesting, and an older fixed-2% campaign that still resolves.
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
import { CpAmm, getUnClaimLpFee, type PoolState } from '@meteora-ag/cp-amm-sdk'
import {
  DEFAULT_MIGRATED_POOL_FEE_PARAMS,
  DEFAULT_MIGRATED_POOL_MARKET_CAP_FEE_SCHEDULER_PARAMS,
  MigrationFeeOption,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  buildBuyTx,
  buildCreateCampaignTx,
  buildMigrateTx,
  dbcClient,
  readResaleConfig,
  resalePoolAddress,
  resolveResalePool,
} from '../../chain'
import { LEGACY_MIGRATION_FEE_OPTION, campaignToConfig, type Campaign } from '../../engine'
import { readCampaignLive } from '../../live'
import { getNetwork } from '../../network'
import { buildMakerClaimTx, buildResaleSwapTx, quoteResale, readResale } from '../../resale'
import type { CampaignRecord } from '../../store'
import { send } from '../../tx'
import { buildMakerUnlockTx, chainUnixTime } from '../../unlock'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
// Read at call time by getNetwork() and campaignToConfig(); the override only applies on localnet.
const SCHEDULE = { cliffSec: 20, periods: 2, periodSec: 10, bpsPerPeriod: 2500 }
Object.assign(process.env, { NETWORK: 'localnet', VESTING_SCHEDULE_OVERRIDE: JSON.stringify(SCHEDULE) })

const POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let conn: Connection
const [platform, maker, backer, reseller] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()]
let usdcMint: PublicKey
let record: CampaignRecord
let damm: PublicKey

async function airdrop(pk: PublicKey, sol: number) {
  const sig = await conn.requestAirdrop(pk, sol * LAMPORTS_PER_SOL)
  await conn.confirmTransaction({ signature: sig, ...(await conn.getLatestBlockhash()) }, 'confirmed')
}

async function balance(mint: PublicKey | string, owner: PublicKey) {
  const a = await getAccount(conn, getAssociatedTokenAddressSync(new PublicKey(mint), owner)).catch(() => null)
  return new BN(a ? a.amount.toString() : '0')
}

// Signs with whichever of the given keys the transaction actually needs (the payer of the create
// transaction is being moved from the platform to the maker in another change).
function neededSigners(tx: Transaction, keys: Keypair[]) {
  return keys.filter((k) => tx.instructions.some((ix) => ix.keys.some((m) => m.isSigner && m.pubkey.equals(k.publicKey))))
}

async function waitForChainTime(t: number) {
  while ((await chainUnixTime(conn)) < t) await sleep(1000)
}

// Unclaimed LP fees of every position an owner holds in the resale pool, raw, per side.
async function unclaimed(pool: PoolState, owner: PublicKey) {
  let a = new BN(0)
  let b = new BN(0)
  for (const p of await new CpAmm(conn).getUserPositionByPool(damm, owner)) {
    const fee = getUnClaimLpFee(pool, p.positionState)
    a = a.add(fee.feeTokenA)
    b = b.add(fee.feeTokenB)
  }
  return { a, b }
}

const toRecord = (built: { pool: PublicKey; config: PublicKey; baseMint: PublicKey; onChain: { goalUsdc: number; totalUnits: number } }, campaign: Campaign): CampaignRecord => ({
  pool: built.pool.toBase58(),
  config: built.config.toBase58(),
  baseMint: built.baseMint.toBase58(),
  usdcMint: usdcMint.toBase58(),
  maker: maker.publicKey.toBase58(),
  createdAt: new Date().toISOString(),
  createSignature: '',
  campaign,
  trust: { tier: 'A', score: 80, reasons: [], maxMakerSharePct: 40 },
  goalUsdc: built.onChain.goalUsdc,
  totalUnits: built.onChain.totalUnits,
  fields: [],
})

const campaign = (name: string, symbol: string, resaleRoyaltyBps?: number): Campaign => ({
  name,
  symbol,
  uri: `https://example.com/${symbol.toLowerCase()}.json`,
  plan: { tiers: [{ units: 3, startPrice: 4 }, { units: 4, startPrice: 5 }], finalPrice: 6, makerSharePct: 20 },
  dropBot: { startFeeBps: 500, windowSec: 10 },
  normalFeeBps: 100,
  shipDays: 30,
  resaleRoyaltyBps,
})

async function fundAndGraduate(pool: PublicKey, goalUsdc: number) {
  await send(conn, await buildBuyTx(conn, backer.publicKey, pool, goalUsdc * 1.3), [backer], 'buy to the goal')
  const mig = await buildMigrateTx(conn, platform.publicKey, pool)
  await send(conn, mig.tx, [platform, ...mig.extraSigners], 'migrateToDammV2')
}

before(async () => {
  if (skip) return
  conn = new Connection(getNetwork().rpcUrl, 'confirmed')
  if ((await conn.getBalance(POOL_AUTHORITY)) < 1 * LAMPORTS_PER_SOL) await airdrop(POOL_AUTHORITY, 5)
  for (const k of [platform, maker, backer, reseller]) await airdrop(k.publicKey, 20)
  process.env.PLATFORM_FEE_CLAIMER = platform.publicKey.toBase58()
  usdcMint = await createMint(conn, platform, platform.publicKey, null, 6)
  const fund = new Transaction()
  for (const k of [backer, reseller]) {
    const ata = getAssociatedTokenAddressSync(usdcMint, k.publicKey)
    fund.add(createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, k.publicKey, usdcMint), createMintToInstruction(usdcMint, ata, platform.publicKey, 1_000_000_000n))
  }
  await send(conn, fund, [platform], 'mint test USDC')
})

test('a 5% royalty campaign graduates into its Customizable resale pool, with vesting', { skip, timeout: 120_000 }, async () => {
  const c = campaign('Royalty Tee', 'RTEE', 500)
  const built = await buildCreateCampaignTx({ connection: conn, campaign: c, tier: 'A', platform: platform.publicKey, maker: maker.publicKey, usdcMint })
  assert.equal(built.onChain.migrationFeeOption, MigrationFeeOption.Customizable)
  await send(conn, built.tx, [...neededSigners(built.tx, [maker, platform]), ...built.extraSigners], 'create royalty campaign')
  record = { ...toRecord(built, c), migrationFeeOption: built.onChain.migrationFeeOption }
  assert.deepEqual(await readResaleConfig(conn, built.config), { migrationFeeOption: MigrationFeeOption.Customizable, poolFeeBps: 500, dynamicFee: true })

  await fundAndGraduate(built.pool, built.onChain.goalUsdc)
  damm = await resolveResalePool(conn, record)
  assert.ok(damm.equals(resalePoolAddress(built.baseMint, usdcMint, MigrationFeeOption.Customizable)))
  assert.equal((await readCampaignLive(conn, record)).resalePool, damm.toBase58())

  const pool = await new CpAmm(conn).fetchPoolState(damm)
  assert.ok(pool.tokenAMint.equals(built.baseMint))
  assert.equal(pool.collectFeeMode, 1, 'fees in token B (USDC) only')
  assert.equal(pool.poolFees.dynamicFee.initialized, 1, 'volatility fee on')
  // Ship-window vesting and the Customizable pool together: the maker's position carries the schedule.
  const [m] = await new CpAmm(conn).getUserPositionByPool(damm, maker.publicKey)
  assert.ok(m.positionState.vestedLiquidity.gtn(0) && m.positionState.permanentLockedLiquidity.gtn(0))
  assert.equal(m.positionState.innerVesting.periodFrequency.toNumber(), SCHEDULE.periodSec)
})

test('a 3 USDC resale buy pays a 0.15 USDC fee, split by liquidity after Meteora’s protocol share', { skip }, async () => {
  const quote = await quoteResale(conn, record, 'buy', 3)
  assert.ok(Math.abs(quote.feeUsdcEquivalent - 0.15) < 1e-6, `quoted fee ${quote.feeUsdcEquivalent}`)
  const before = await new CpAmm(conn).fetchPoolState(damm)
  const usdc0 = await balance(usdcMint, reseller.publicKey)
  await send(conn, await buildResaleSwapTx(conn, record, reseller.publicKey, 'buy', 3), [reseller], 'resale buy 3 USDC')
  assert.ok(usdc0.sub(await balance(usdcMint, reseller.publicKey)).eq(new BN(3_000_000)))

  const pool = await new CpAmm(conn).fetchPoolState(damm)
  const protocolPct = pool.poolFees.protocolFeePercent
  const protocol = pool.protocolBFee.sub(before.protocolBFee)
  const [mk, pf] = [await unclaimed(pool, maker.publicKey), await unclaimed(pool, platform.publicKey)]
  console.log(`    fee: protocol ${protocolPct}% = ${protocol} raw, maker ${mk.b} raw, platform ${pf.b} raw`)
  assert.ok(protocolPct > 0 && protocolPct < 100)
  assert.ok(mk.a.isZero() && pf.a.isZero() && pool.protocolAFee.eq(before.protocolAFee), 'no voucher-side fees')
  const total = protocol.add(mk.b).add(pf.b).toNumber()
  assert.ok(Math.abs(total - 150_000) <= 2, `total fee ${total} raw, expected 150000`)
  assert.ok(Math.abs(protocol.toNumber() - (150_000 * protocolPct) / 100) <= 1)

  // The LP fee is split by liquidity: the maker's 95% (vesting + permanent) and the platform's 5%.
  const view = (await readResale(conn, record))!
  const r = view.royalty!
  assert.deepEqual({ fee: r.poolFeeBps, dyn: r.dynamicFee, protocol: r.protocolFeePct }, { fee: 500, dyn: true, protocol: protocolPct })
  assert.ok(Math.abs(r.makerLiquidityBps - 9500) <= 1, `maker share ${r.makerLiquidityBps}`)
  const makerShare = mk.b.toNumber() / mk.b.add(pf.b).toNumber()
  assert.ok(Math.abs(makerShare - r.makerLiquidityBps / 10_000) < 1e-3, `maker fee share ${makerShare}`)
  assert.ok(Math.abs(mk.b.toNumber() / 3_000_000 - r.makerRoyaltyBps / 10_000) < 1e-5, `maker earned ${mk.b} vs ${r.makerRoyaltyBps} bps`)
  assert.ok(Math.abs(view.maker.resaleFeesUnclaimedUsdc - mk.b.toNumber() / 1e6) < 1e-9)
  assert.ok(!('resaleFeesUnclaimedVouchers' in view.maker))
})

test('a resale sell also pays its fee in USDC', { skip }, async () => {
  const pool0 = await new CpAmm(conn).fetchPoolState(damm)
  const before = await unclaimed(pool0, maker.publicKey)
  await send(conn, await buildResaleSwapTx(conn, record, reseller.publicKey, 'sell', 0.2), [reseller], 'resale sell 0.2 vouchers')
  const pool = await new CpAmm(conn).fetchPoolState(damm)
  const after = await unclaimed(pool, maker.publicKey)
  assert.ok(after.a.isZero() && pool.protocolAFee.isZero())
  assert.ok(after.b.gt(before.b))
})

test('once fully unlocked, the maker keeps 75% of the LP fee: a 3% royalty on a 5% pool', { skip, timeout: 90_000 }, async () => {
  const [m] = await new CpAmm(conn).getUserPositionByPool(damm, maker.publicKey)
  await waitForChainTime(m.positionState.innerVesting.cliffPoint.toNumber() + SCHEDULE.periods * SCHEDULE.periodSec)
  const unlock = (await buildMakerUnlockTx(conn, record, maker.publicKey))!
  assert.ok(unlock, 'vesting released on the Customizable pool')
  const usdc0 = await balance(usdcMint, maker.publicKey)
  await send(conn, unlock.tx, [maker], 'unlock production funds')
  assert.ok((await balance(usdcMint, maker.publicKey)).sub(usdc0).gte(unlock.minUsdc))

  const r = (await readResale(conn, record))!.royalty!
  assert.ok(Math.abs(r.makerLiquidityBps - 7500) <= 1, `maker share ${r.makerLiquidityBps}`)
  // 500 bps × (1 − 20% protocol) × 75% = 300 bps
  assert.ok(Math.abs(r.makerRoyaltyBps - (500 * (100 - r.protocolFeePct) * 0.75) / 100) < 0.1, `royalty ${r.makerRoyaltyBps}`)

  const claim = await buildMakerClaimTx(conn, record)
  assert.ok(claim, 'fees to claim')
  const usdc1 = await balance(usdcMint, maker.publicKey)
  await send(conn, claim!, [maker], 'claim resale royalties')
  assert.ok((await balance(usdcMint, maker.publicKey)).gt(usdc1))
})

test('an older fixed-2% campaign (no migrationFeeOption on its record) still migrates and resolves', { skip, timeout: 120_000 }, async () => {
  // Build the config as campaigns did before the maker-set royalty: FixedBps200, no migrated pool fee.
  const c = campaign('Legacy Mug', 'LMUG')
  const { params, onChain } = campaignToConfig(c, 'A')
  Object.assign(params, {
    migrationFeeOption: MigrationFeeOption.FixedBps200,
    migratedPoolFee: DEFAULT_MIGRATED_POOL_FEE_PARAMS,
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: DEFAULT_MIGRATED_POOL_MARKET_CAP_FEE_SCHEDULER_PARAMS,
    compoundingFeeBps: 0,
  })
  const [config, baseMint] = [Keypair.generate(), Keypair.generate()]
  const tx = await dbcClient(conn).partner.createConfigAndPool({
    ...params,
    config: config.publicKey,
    feeClaimer: platform.publicKey,
    leftoverReceiver: platform.publicKey,
    quoteMint: usdcMint,
    payer: platform.publicKey,
    preCreatePoolParam: { name: c.name, symbol: c.symbol, uri: c.uri, poolCreator: maker.publicKey, baseMint: baseMint.publicKey },
  })
  await send(conn, tx, [platform, maker, config, baseMint], 'create legacy campaign')
  const pool = deriveDbcPoolAddress(usdcMint, baseMint.publicKey, config.publicKey)
  const legacy = toRecord({ pool, config: config.publicKey, baseMint: baseMint.publicKey, onChain }, c)
  assert.equal(legacy.migrationFeeOption, undefined)
  assert.deepEqual(await readResaleConfig(conn, config.publicKey), { migrationFeeOption: LEGACY_MIGRATION_FEE_OPTION, poolFeeBps: 200, dynamicFee: true })

  await fundAndGraduate(pool, onChain.goalUsdc)
  const resale = await resolveResalePool(conn, legacy)
  assert.ok(resale.equals(resalePoolAddress(baseMint.publicKey, usdcMint, MigrationFeeOption.FixedBps200)))
  const view = (await readResale(conn, legacy))!
  assert.equal(view.pool, resale.toBase58())
  assert.equal(view.royalty!.poolFeeBps, 200)
  const quote = await quoteResale(conn, legacy, 'buy', 3)
  assert.ok(Math.abs(quote.feeUsdcEquivalent - 0.06) < 1e-6, `quoted fee ${quote.feeUsdcEquivalent}`)

  // Without a readable config, the stored option, else the fixed 2%, stands in.
  const unreadable = { ...legacy, config: Keypair.generate().publicKey.toBase58() }
  assert.ok((await resolveResalePool(conn, unreadable)).equals(resale))
  const stored = await resolveResalePool(conn, { ...unreadable, migrationFeeOption: MigrationFeeOption.Customizable })
  assert.ok(stored.equals(resalePoolAddress(baseMint.publicKey, usdcMint, MigrationFeeOption.Customizable)))
})
