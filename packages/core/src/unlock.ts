// "Unlock production funds": the maker's vesting LP in the DAMM v2 resale pool, released on the
// ship-window schedule the DBC config wrote at graduation (vesting.ts). DBC stores the schedule as
// DAMM v2 "inner vesting" inside the maker's position, so no Vesting accounts are involved.
import BN from 'bn.js'
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, createBurnInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { CpAmm, getAvailableVestingLiquidity, type PoolState, type PositionState } from '@meteora-ag/cp-amm-sdk'
import { dbcClient, resalePoolAddress } from './chain'
import { USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'
import type { CampaignRecord } from './store'
import type { VestingSchedule } from './vesting'

const toNum = (bn: BN, decimals: number) => Number(bn.toString()) / 10 ** decimals

// Chain time (unix seconds) from the Clock sysvar: the clock the DAMM v2 program checks vesting against.
export async function chainUnixTime(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
  if (!info) throw new Error('Clock sysvar not readable')
  return Number(info.data.readBigInt64LE(32)) // slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64
}

// The maker as recorded on chain (DBC pool creator), not as claimed by our own store.
export async function onChainCreator(connection: Connection, pool: PublicKey | string): Promise<PublicKey> {
  const virtualPool = await dbcClient(connection).state.getPool(pool)
  if (!virtualPool) throw new Error(`pool ${pool.toString()} not found`)
  return virtualPool.poolState.creator
}

// What the DBC config says happens to resale liquidity at graduation. Configs are immutable, so cached.
export type LpTerms = {
  partnerPermanentPct: number
  creatorPermanentPct: number
  creatorUnlockedPct: number
  creatorVestingPct: number // 0 for campaigns created before ship-window vesting
  vesting: VestingSchedule | null
}

const termsCache = new Map<string, LpTerms>()

export async function readLpTerms(connection: Connection, config: PublicKey | string): Promise<LpTerms> {
  const key = config.toString()
  const hit = termsCache.get(key)
  if (hit) return hit
  const c = await dbcClient(connection).state.getPoolConfig(config)
  if (!c) throw new Error(`config ${key} not found`)
  const v = c.creatorLiquidityVestingInfo
  const vesting = v.isInitialized && v.vestingPercentage > 0
  const terms: LpTerms = {
    partnerPermanentPct: c.partnerPermanentLockedLiquidityPercentage,
    creatorPermanentPct: c.creatorPermanentLockedLiquidityPercentage,
    creatorUnlockedPct: c.creatorLiquidityPercentage,
    creatorVestingPct: vesting ? v.vestingPercentage : 0,
    vesting: vesting
      ? { cliffSec: v.cliffDurationFromMigrationTime, periods: v.numberOfPeriods, periodSec: v.frequency, bpsPerPeriod: v.bpsPerPeriod }
      : null,
  }
  termsCache.set(key, terms)
  return terms
}

// Liquidity the position can remove right now: unlocked plus vesting released by the clock.
function removableLiquidity(position: PositionState, now: number): BN {
  const available = getAvailableVestingLiquidity({ innerVesting: position.innerVesting } as never, new BN(now))
  return position.unlockedLiquidity.add(BN.min(available, position.vestedLiquidity))
}

function withdrawAmounts(cpAmm: CpAmm, poolState: PoolState, liquidityDelta: BN) {
  if (liquidityDelta.isZero()) return { outAmountA: new BN(0), outAmountB: new BN(0) }
  return cpAmm.getWithdrawQuote({
    liquidityDelta,
    sqrtPrice: poolState.sqrtPrice,
    minSqrtPrice: poolState.sqrtMinPrice,
    maxSqrtPrice: poolState.sqrtMaxPrice,
    collectFeeMode: poolState.collectFeeMode,
    tokenAAmount: poolState.tokenAAmount,
    tokenBAmount: poolState.tokenBAmount,
    liquidity: poolState.liquidity,
  })
}

// Next release of the inner vesting after `now` (unix seconds), or null once nothing is left to release.
export function nextReleaseAt(position: PositionState, now: number): number | null {
  const v = position.innerVesting
  if (position.vestedLiquidity.isZero()) return null
  const cliff = v.cliffPoint.toNumber()
  const freq = v.periodFrequency.toNumber()
  if (now < cliff && !v.cliffUnlockLiquidity.isZero()) return cliff
  if (freq === 0 || v.liquidityPerPeriod.isZero()) return now < cliff ? cliff : null
  const passed = now < cliff ? 0 : Math.floor((now - cliff) / freq)
  return passed >= v.numberOfPeriod ? null : cliff + (passed + 1) * freq
}

export type MakerLp = {
  unlockableUsdc: number // released and removable now ("Unlock production funds")
  unlockableVouchers: number // removed with it, then burned
  vestingUsdc: number // still on the schedule
  permanentUsdc: number // the maker's share of the permanent resale floor, never removable
  nextUnlockAt: number | null // unix seconds
  fullyVestedAt: number | null
  now: number
}

// Pure: sums the maker's resale-pool positions at chain time `now`. Amounts are at today's pool price.
export function makerLp(cpAmm: CpAmm, poolState: PoolState, positions: PositionState[], now: number): MakerLp {
  let removable = new BN(0)
  let vesting = new BN(0)
  let permanent = new BN(0)
  let nextUnlockAt: number | null = null
  let fullyVestedAt: number | null = null
  for (const p of positions) {
    const r = removableLiquidity(p, now)
    removable = removable.add(r)
    vesting = vesting.add(p.vestedLiquidity.add(p.unlockedLiquidity).sub(r))
    permanent = permanent.add(p.permanentLockedLiquidity)
    const next = nextReleaseAt(p, now)
    if (next !== null) nextUnlockAt = nextUnlockAt === null ? next : Math.min(nextUnlockAt, next)
    if (!p.vestedLiquidity.isZero()) {
      const end = p.innerVesting.cliffPoint.toNumber() + p.innerVesting.periodFrequency.toNumber() * p.innerVesting.numberOfPeriod
      fullyVestedAt = Math.max(fullyVestedAt ?? 0, end)
    }
  }
  const out = withdrawAmounts(cpAmm, poolState, removable)
  return {
    unlockableUsdc: toNum(out.outAmountB, USDC_DECIMALS),
    unlockableVouchers: toNum(out.outAmountA, VOUCHER_DECIMALS),
    vestingUsdc: toNum(withdrawAmounts(cpAmm, poolState, vesting).outAmountB, USDC_DECIMALS),
    permanentUsdc: toNum(withdrawAmounts(cpAmm, poolState, permanent).outAmountB, USDC_DECIMALS),
    nextUnlockAt,
    fullyVestedAt,
    now,
  }
}

export type UnlockBuild = {
  tx: Transaction
  liquidityDelta: BN
  outVouchers: BN // quoted
  outUsdc: BN // quoted
  minVouchers: BN // thresholds sent to the program
  minUsdc: BN
  burnVouchers: BN // burned in the same transaction (0 when burn is off)
}

// Removes every released tranche of the maker's resale-pool liquidity in one transaction.
// Minimums come from the withdraw quote minus slippage, so a sandwich cannot skew the removal.
// By default the vouchers that come out are burned in the same transaction: they were the maker's
// own inventory, and burning them keeps "voucher supply = units the maker still owes" true.
// Returns null when nothing is released yet (removing zero fails on chain with 6023, dust with 6006).
export async function buildMakerUnlockTx(
  connection: Connection,
  record: CampaignRecord,
  maker: PublicKey,
  opts: { slippageBps?: number; burn?: boolean; refreshVesting?: boolean } = {},
): Promise<UnlockBuild | null> {
  const slippageBps = opts.slippageBps ?? 100
  if (!(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps < 10_000)) throw new Error('slippageBps must be 0..9999')
  const cpAmm = new CpAmm(connection)
  const pool = resalePoolAddress(new PublicKey(record.baseMint), new PublicKey(record.usdcMint))
  const poolState = await cpAmm.fetchPoolState(pool).catch(() => null)
  if (!poolState) return null
  const [positions, now] = await Promise.all([cpAmm.getUserPositionByPool(pool, maker), chainUnixTime(connection)])
  const voucherIsA = poolState.tokenAMint.toBase58() === record.baseMint

  const tx = new Transaction()
  let liquidityDelta = new BN(0)
  let outA = new BN(0)
  let outB = new BN(0)
  let minA = new BN(0)
  let minB = new BN(0)
  const atLeastOne = (out: BN) => BN.max(out.muln(10_000 - slippageBps).divn(10_000), BN.min(out, new BN(1)))
  for (const p of positions) {
    const delta = removableLiquidity(p.positionState, now)
    if (delta.isZero()) continue
    const q = withdrawAmounts(cpAmm, poolState, delta)
    // Graduation can leave a few raw units of unlocked liquidity: worth nothing, and removing it
    // fails with AmountIsZero (6006). Wait for a real tranche instead.
    if (q.outAmountA.isZero() || q.outAmountB.isZero()) continue
    const [thresholdA, thresholdB] = [atLeastOne(q.outAmountA), atLeastOne(q.outAmountB)]
    if (opts.refreshVesting) {
      const refresh = await cpAmm.refreshVesting({ owner: maker, position: p.position, positionNftAccount: p.positionNftAccount, pool, vestingAccounts: [] })
      tx.add(...refresh.instructions)
    }
    const remove = await cpAmm.removeLiquidity({
      owner: maker,
      pool,
      position: p.position,
      positionNftAccount: p.positionNftAccount,
      liquidityDelta: delta,
      tokenAAmountThreshold: thresholdA,
      tokenBAmountThreshold: thresholdB,
      tokenAMint: poolState.tokenAMint,
      tokenBMint: poolState.tokenBMint,
      tokenAVault: poolState.tokenAVault,
      tokenBVault: poolState.tokenBVault,
      tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID,
      vestings: [], // inner vesting: the program releases it during remove_liquidity
      currentPoint: new BN(now),
    })
    tx.add(...remove.instructions)
    liquidityDelta = liquidityDelta.add(delta)
    outA = outA.add(q.outAmountA)
    outB = outB.add(q.outAmountB)
    minA = minA.add(thresholdA)
    minB = minB.add(thresholdB)
  }
  if (liquidityDelta.isZero()) return null

  const [outVouchers, outUsdc, minVouchers, minUsdc] = voucherIsA ? [outA, outB, minA, minB] : [outB, outA, minB, minA]
  // Burn the guaranteed minimum, so the burn can never fail for want of the vouchers it just received.
  const burnVouchers = opts.burn === false ? new BN(0) : minVouchers
  if (burnVouchers.gtn(0)) {
    const baseMint = new PublicKey(record.baseMint)
    tx.add(createBurnInstruction(getAssociatedTokenAddressSync(baseMint, maker), baseMint, maker, BigInt(burnVouchers.toString())))
  }
  return { tx, liquidityDelta, outVouchers, outUsdc, minVouchers, minUsdc, burnVouchers }
}

// What a backer could get for `vouchers` by selling into the resale pool: now, and at the floor,
// when only permanently locked liquidity is left (every vesting and unlocked position withdrawn).
// Both at today's pool price; it is an exit value, not a refund.
export type BackerFloor = { vouchers: number; nowUsdc: number; floorUsdc: number; permanentShareBps: number }

export async function readBackerFloor(connection: Connection, record: CampaignRecord, vouchers = 1): Promise<BackerFloor | null> {
  const cpAmm = new CpAmm(connection)
  const pool = resalePoolAddress(new PublicKey(record.baseMint), new PublicKey(record.usdcMint))
  const poolState = await cpAmm.fetchPoolState(pool).catch(() => null)
  if (!poolState || poolState.liquidity.isZero()) return null
  const [slot, now] = await Promise.all([connection.getSlot(), chainUnixTime(connection)])
  const inputMint = new PublicKey(record.baseMint)
  const inAmount = new BN(Math.round(vouchers * 10 ** VOUCHER_DECIMALS))
  const sell = (state: PoolState) =>
    cpAmm.getQuote({ inAmount, inputTokenMint: inputMint, slippage: 0, poolState: state, currentTime: now, currentSlot: slot, tokenADecimal: VOUCHER_DECIMALS, tokenBDecimal: USDC_DECIMALS })
  const floorLiquidity = poolState.permanentLockLiquidity
  const nowOut = sell(poolState).swapOutAmount
  const floorOut = floorLiquidity.isZero() ? new BN(0) : sell({ ...poolState, liquidity: floorLiquidity } as PoolState).swapOutAmount
  return {
    vouchers,
    nowUsdc: toNum(nowOut, USDC_DECIMALS),
    floorUsdc: toNum(floorOut, USDC_DECIMALS),
    permanentShareBps: floorLiquidity.muln(10_000).div(poolState.liquidity).toNumber(),
  }
}
