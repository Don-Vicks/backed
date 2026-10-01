// Ship-window LP vesting end to end on the local validator (mainnet DBC + DAMM v2 binaries):
// create with a seconds-scale localnet schedule, fund, graduate, then "Unlock production funds".
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import { CpAmm } from '@meteora-ag/cp-amm-sdk'
import { buildBuyTx, buildCreateCampaignTx, buildMigrateTx, createCampaignSteps, resalePoolAddress, resolveResalePool } from '../../chain'
import { DROP_BOT_START_FEE_BPS } from '../../campaign-input'
import type { Campaign } from '../../engine'
import { getNetwork } from '../../network'
import { buildMakerClaimTx, buildResaleSwapTx, readMakerEarnings } from '../../resale'
import type { CampaignRecord } from '../../store'
import { verifyRedeemBurn } from '../../redemptions'
import { send } from '../../tx'
import { buildMakerUnlockTx, onChainCreator, readBackerFloor, readLpTerms } from '../../unlock'
import { chainNow } from '../../swaps'

const skip = process.env.LOCALNET !== '1' && 'set LOCALNET=1 with a validator running'
// Read at call time by getNetwork() and campaignToConfig(); the override only applies on localnet.
const SCHEDULE = { cliffSec: 20, periods: 2, periodSec: 10, bpsPerPeriod: 2500 } // 50% at the cliff, 25% per period
Object.assign(process.env, { NETWORK: 'localnet', VESTING_SCHEDULE_OVERRIDE: JSON.stringify(SCHEDULE) })

const POOL_AUTHORITY = new PublicKey('FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let conn: Connection
const [platform, maker, backer, reseller] = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()]
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

const supply = async () => new BN((await getMint(conn, new PublicKey(record.baseMint))).supply.toString())

// Maker-paid create: one transaction, or createConfig then createPool when it doesn't fit.
async function sendCreate(built: Parameters<typeof createCampaignSteps>[0], label: string) {
  for (const step of createCampaignSteps(built, maker.publicKey)) await send(conn, step.tx, [maker, ...step.signers], label)
}

async function makerPosition() {
  const [p] = await new CpAmm(conn).getUserPositionByPool(damm, maker.publicKey)
  return p
}

async function waitForChainTime(t: number) {
  while ((await chainNow(conn)) < t) await sleep(1000)
}

before(async () => {
  if (skip) return
  conn = new Connection(getNetwork().rpcUrl, 'confirmed')
  if ((await conn.getBalance(POOL_AUTHORITY)) < 1 * LAMPORTS_PER_SOL) await airdrop(POOL_AUTHORITY, 5)
  for (const k of [platform, maker, backer, reseller]) await airdrop(k.publicKey, 20)
  process.env.PLATFORM_FEE_CLAIMER = platform.publicKey.toBase58()
})

test('vesting campaign: create, fund and graduate', { skip, timeout: 120_000 }, async () => {
  const usdcMint = await createMint(conn, platform, platform.publicKey, null, 6)
  const fund = new Transaction()
  for (const k of [backer, reseller]) {
    const ata = getAssociatedTokenAddressSync(usdcMint, k.publicKey)
    fund.add(createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, k.publicKey, usdcMint), createMintToInstruction(usdcMint, ata, platform.publicKey, 1_000_000_000n))
  }
  await send(conn, fund, [platform], 'mint test USDC')

  const campaign: Campaign = {
    name: 'Vesting Tee',
    symbol: 'VTEE',
    uri: 'https://example.com/v.json',
    plan: { tiers: [{ units: 3, startPrice: 4 }, { units: 4, startPrice: 5 }], finalPrice: 6, makerSharePct: 20 },
    dropBot: { startFeeBps: DROP_BOT_START_FEE_BPS, windowSec: 60 },
    normalFeeBps: 100,
    shipDays: 30,
  }
  const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: 'A', maker: maker.publicKey, usdcMint })
  assert.deepEqual(built.onChain.goalUsdc > 0, true)
  await sendCreate(built, 'create vesting campaign')
  record = {
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
    fields: built.fields,
    migrationFeeOption: built.onChain.migrationFeeOption,
  }

  // The config on chain carries the schedule (inspect <config> shows creatorLiquidityVestingInfo).
  assert.deepEqual(await readLpTerms(conn, built.config), {
    partnerPermanentPct: 5,
    creatorPermanentPct: 15,
    creatorUnlockedPct: 0,
    creatorVestingPct: 80,
    vesting: SCHEDULE,
  })
  assert.ok((await onChainCreator(conn, built.pool)).equals(maker.publicKey))

  await send(conn, (await buildBuyTx(conn, backer.publicKey, built.pool, built.onChain.goalUsdc * 1.3)).tx, [backer], 'buy to the goal')
  const mig = await buildMigrateTx(conn, platform.publicKey, built.pool)
  await send(conn, mig.tx, [platform, ...mig.extraSigners], 'migrateToDammV2')
  damm = await resolveResalePool(conn, record)
})

test('positions after graduation: maker 80/95 vesting + 15/95 permanent, platform 5% permanent', { skip }, async () => {
  const cpAmm = new CpAmm(conn)
  const pool = await cpAmm.fetchPoolState(damm)
  const m = (await makerPosition()).positionState
  const makerTotal = m.unlockedLiquidity.add(m.vestedLiquidity).add(m.permanentLockedLiquidity)
  const ratio = (a: BN, b: BN) => Number(a.muln(1_000_000).div(b).toString()) / 1_000_000
  // Nothing is unlocked at graduation beyond rounding dust (2 raw units for some plans).
  assert.ok(m.unlockedLiquidity.lt(makerTotal.div(new BN(1_000_000_000))), `unlocked ${m.unlockedLiquidity}`)
  assert.ok(Math.abs(ratio(m.vestedLiquidity, makerTotal) - 80 / 95) < 1e-5, `vested ${ratio(m.vestedLiquidity, makerTotal)}`)
  assert.ok(Math.abs(ratio(m.permanentLockedLiquidity, makerTotal) - 15 / 95) < 1e-5)
  const platformPositions = await cpAmm.getUserPositionByPool(damm, platform.publicKey)
  assert.equal(platformPositions.length, 1)
  const plat = platformPositions[0].positionState
  assert.ok(Math.abs(ratio(plat.permanentLockedLiquidity, pool.liquidity) - 0.05) < 1e-5, `platform ${ratio(plat.permanentLockedLiquidity, pool.liquidity)}`)
  assert.ok(Math.abs(ratio(pool.permanentLockLiquidity, pool.liquidity) - 0.2) < 1e-5)
  assert.equal(m.innerVesting.periodFrequency.toNumber(), SCHEDULE.periodSec)
})

test('unlock before the cliff is refused, by the builder and by the program', { skip }, async () => {
  const p = await makerPosition()
  assert.ok((await chainNow(conn)) < p.positionState.innerVesting.cliffPoint.toNumber(), 'test too slow: cliff already passed')
  assert.equal(await buildMakerUnlockTx(conn, record, maker.publicKey), null)

  const earnings = await readMakerEarnings(conn, record)
  assert.equal(earnings.lp!.unlockableUsdc, 0)
  assert.ok(earnings.lp!.vestingUsdc > 0 && earnings.lp!.permanentUsdc > 0)
  assert.equal(earnings.lp!.nextUnlockAt, p.positionState.innerVesting.cliffPoint.toNumber())
  assert.equal(earnings.lp!.fullyVestedAt, p.positionState.innerVesting.cliffPoint.toNumber() + SCHEDULE.periods * SCHEDULE.periodSec)

  const cpAmm = new CpAmm(conn)
  const pool = await cpAmm.fetchPoolState(damm)
  const tx = await cpAmm.removeLiquidity({
    owner: maker.publicKey, pool: damm, position: p.position, positionNftAccount: p.positionNftAccount, liquidityDelta: new BN(1_000_000),
    tokenAAmountThreshold: new BN(0), tokenBAmountThreshold: new BN(0), tokenAMint: pool.tokenAMint, tokenBMint: pool.tokenBMint,
    tokenAVault: pool.tokenAVault, tokenBVault: pool.tokenBVault, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
    vestings: [], currentPoint: new BN(await chainNow(conn)),
  })
  // DAMM v2 6023 InsufficientLiquidity: the vesting liquidity is not released yet.
  await assert.rejects(send(conn, tx, [maker], 'remove before the cliff'), /"Custom":6023/)
})

test('resale trading accrues fees to the vesting position; backer floor is the permanent 20%', { skip }, async () => {
  await send(conn, await buildResaleSwapTx(conn, record, reseller.publicKey, 'buy', 3), [reseller], 'resale buy')
  const floor = (await readBackerFloor(conn, record, 1))!
  console.log(`    backer floor for 1 voucher: now ${floor.nowUsdc} USDC, permanent floor ${floor.floorUsdc} USDC`)
  assert.ok(Math.abs(floor.permanentShareBps - 2000) <= 1, `floor share ${floor.permanentShareBps}`)
  assert.ok(floor.floorUsdc > 0 && floor.floorUsdc < floor.nowUsdc, JSON.stringify(floor))
})

test('after the cliff the maker unlocks the cliff tranche and the vouchers are burned', { skip, timeout: 60_000 }, async () => {
  const start = (await makerPosition()).positionState
  await waitForChainTime(start.innerVesting.cliffPoint.toNumber())
  const built = (await buildMakerUnlockTx(conn, record, maker.publicKey, { slippageBps: 0 }))!
  assert.ok(built, 'nothing to unlock after the cliff')
  // Cliff only (the first period is 10s later): 50% of the vesting bucket, plus any graduation dust.
  const cliff = start.innerVesting.cliffUnlockLiquidity.add(start.unlockedLiquidity)
  assert.ok(built.liquidityDelta.eq(cliff), `${built.liquidityDelta} vs ${cliff}`)
  assert.ok(built.minUsdc.eq(built.outUsdc))

  const [usdc0, vouchers0, supply0] = [await balance(record.usdcMint, maker.publicKey), await balance(record.baseMint, maker.publicKey), await supply()]
  const sig = await send(conn, built.tx, [maker], 'unlock production funds (cliff)')
  const [usdc1, vouchers1, supply1] = [await balance(record.usdcMint, maker.publicKey), await balance(record.baseMint, maker.publicKey), await supply()]
  console.log(`    cliff tranche: +${usdc1.sub(usdc0)} raw USDC, burned ${supply0.sub(supply1)} raw vouchers`)
  assert.ok(usdc1.sub(usdc0).eq(built.outUsdc), `paid ${usdc1.sub(usdc0)} quoted ${built.outUsdc}`)
  assert.ok(built.outUsdc.gtn(0))
  assert.ok(supply0.sub(supply1).eq(built.outVouchers), 'voucher supply drops by the vouchers withdrawn')
  assert.ok(vouchers1.eq(vouchers0), 'the maker keeps none of the withdrawn vouchers')

  const after = (await makerPosition()).positionState
  assert.ok(after.permanentLockedLiquidity.eq(start.permanentLockedLiquidity))

  // The unlock burns vouchers, but in a transaction that calls DAMM v2 and that the pool's creator
  // signed: it can never be claimed as a redemption.
  const pending = { id: 'unlock-burn-0000', pool: record.pool, wallet: maker.publicKey.toBase58(), units: 1, shipping: '', createdAt: new Date().toISOString(), signature: sig, lastValidBlockHeight: 0 }
  await assert.rejects(verifyRedeemBurn(conn, record, pending, sig, maker.publicKey), /not a redemption/)
})

test('after full vesting the rest unlocks with default slippage; only the permanent floor stays', { skip, timeout: 60_000 }, async () => {
  const start = (await makerPosition()).positionState
  await waitForChainTime(start.innerVesting.cliffPoint.toNumber() + SCHEDULE.periods * SCHEDULE.periodSec)
  const built = (await buildMakerUnlockTx(conn, record, maker.publicKey))!
  assert.ok(built.liquidityDelta.eq(start.vestedLiquidity.add(start.unlockedLiquidity)), 'the whole remaining vesting bucket')
  assert.ok(built.minUsdc.lt(built.outUsdc) && built.minUsdc.gtn(0), 'the USDC threshold is the quote minus 1%, never 0')

  const [usdc0, vouchers0, supply0] = [await balance(record.usdcMint, maker.publicKey), await balance(record.baseMint, maker.publicKey), await supply()]
  await send(conn, built.tx, [maker], 'unlock production funds (rest)')
  const [usdc1, vouchers1, supply1] = [await balance(record.usdcMint, maker.publicKey), await balance(record.baseMint, maker.publicKey), await supply()]
  console.log(`    rest: +${usdc1.sub(usdc0)} raw USDC (min ${built.minUsdc}), burned ${supply0.sub(supply1)} raw vouchers`)
  assert.ok(usdc1.sub(usdc0).gte(built.minUsdc))
  assert.ok(supply0.sub(supply1).eq(built.outVouchers), 'every withdrawn voucher is burned, slippage or not')
  assert.ok(vouchers1.eq(vouchers0), 'the maker keeps none of the withdrawn vouchers')

  const after = (await makerPosition()).positionState
  assert.ok(after.vestedLiquidity.isZero() && after.unlockedLiquidity.isZero())
  assert.ok(after.permanentLockedLiquidity.eq(start.permanentLockedLiquidity) && after.permanentLockedLiquidity.gtn(0))
  assert.equal(await buildMakerUnlockTx(conn, record, maker.publicKey), null, 'nothing left to unlock')
  const lp = (await readMakerEarnings(conn, record)).lp!
  assert.equal(lp.nextUnlockAt, null)
  assert.equal(lp.unlockableUsdc, 0)
  assert.ok(lp.permanentUsdc > 0)
})

test('the maker claims resale fees on the combined vesting + permanent position', { skip }, async () => {
  const usdc0 = await balance(record.usdcMint, maker.publicKey)
  const tx = await buildMakerClaimTx(conn, record)
  assert.ok(tx, 'fees to claim')
  await send(conn, tx!, [maker], 'claim fees')
  assert.ok((await balance(record.usdcMint, maker.publicKey)).gt(usdc0))
})

test('graduation and cliff dust are not offered as unlocks; the countdown targets the first real release', { skip, timeout: 90_000 }, async () => {
  // This plan leaves 2 raw units of unlocked liquidity in the maker position, which the program refuses to remove.
  // Its schedule releases nothing at the cliff (like tier C's 20 × 5%), so DBC leaves only rounding there.
  const noCliff = { cliffSec: 20, periods: 2, periodSec: 10, bpsPerPeriod: 5000 }
  const campaign: Campaign = {
    name: 'Dust Mug',
    symbol: 'DMUG',
    uri: 'https://example.com/d.json',
    plan: { tiers: [{ units: 2, startPrice: 3 }, { units: 2, startPrice: 4 }], finalPrice: 5, makerSharePct: 10 },
    dropBot: { startFeeBps: DROP_BOT_START_FEE_BPS, windowSec: 60 },
    normalFeeBps: 100,
    shipDays: 45,
  }
  const usdcMint = new PublicKey(record.usdcMint) // funded in the first test
  process.env.VESTING_SCHEDULE_OVERRIDE = JSON.stringify(noCliff)
  const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: 'C', maker: maker.publicKey, usdcMint }).finally(() => {
    process.env.VESTING_SCHEDULE_OVERRIDE = JSON.stringify(SCHEDULE)
  })
  await sendCreate(built, 'create dust campaign')
  await send(conn, (await buildBuyTx(conn, backer.publicKey, built.pool, built.onChain.goalUsdc * 1.3)).tx, [backer], 'buy to the goal')
  const mig = await buildMigrateTx(conn, platform.publicKey, built.pool)
  await send(conn, mig.tx, [platform, ...mig.extraSigners], 'migrateToDammV2')
  const dust = { ...record, pool: built.pool.toBase58(), config: built.config.toBase58(), baseMint: built.baseMint.toBase58(), campaign }
  const [p] = await new CpAmm(conn).getUserPositionByPool(resalePoolAddress(built.baseMint, usdcMint, built.onChain.migrationFeeOption), maker.publicKey)
  assert.ok(p.positionState.unlockedLiquidity.gtn(0), 'expected dust in the unlocked bucket')
  assert.ok((await chainNow(conn)) < p.positionState.innerVesting.cliffPoint.toNumber(), 'test too slow: cliff already passed')
  assert.equal(await buildMakerUnlockTx(conn, dust, maker.publicKey), null)
  const v = p.positionState.innerVesting
  const firstRelease = v.cliffPoint.toNumber() + noCliff.periodSec
  console.log(`    cliff tranche ${v.cliffUnlockLiquidity} vs ${v.liquidityPerPeriod} per period`)
  let lp = (await readMakerEarnings(conn, dust)).lp!
  assert.equal(lp.unlockableUsdc, 0)
  assert.equal(lp.nextUnlockAt, firstRelease, 'not the cliff: nothing real releases there')

  await waitForChainTime(v.cliffPoint.toNumber())
  assert.ok((await chainNow(conn)) < firstRelease, 'test too slow: first period already passed')
  assert.equal(await buildMakerUnlockTx(conn, dust, maker.publicKey), null, 'nothing to unlock at the cliff')
  lp = (await readMakerEarnings(conn, dust)).lp!
  assert.equal(lp.unlockableUsdc, 0)
  assert.equal(lp.nextUnlockAt, firstRelease)
})
