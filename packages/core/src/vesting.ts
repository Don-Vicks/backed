// Ship-window LP vesting: how the maker is paid out of the resale pool after graduation.
// Pure math, no SDK and no chain, so the create form can show the same numbers the engine writes.
//
// At graduation DBC puts the resale-pool liquidity into DAMM v2 positions:
//   partner (platform)  5% permanently locked
//   creator (maker)    15% permanently locked   → 20% permanent resale floor
//   creator (maker)    80% vesting on the schedule below, released by "Unlock production funds"
// The split is the same for every trust tier; the tier only sets how long backers are protected.
import type { TrustTierName } from './trust'

export const DAY = 86_400
export const WEEK = 7 * DAY
export const MAX_LOCK_SEC = 63_072_000 // DBC MAX_LOCK_DURATION_IN_SECONDS (2 years), cliff + all periods
export const BPS = 10_000

export const SHIP_DAYS = { min: 14, max: 180, default: 30 }

export const LP_SPLIT = { partnerPermanentPct: 5, creatorPermanentPct: 15, creatorVestingPct: 80 } as const
export const PERMANENT_FLOOR_PCT = LP_SPLIT.partnerPermanentPct + LP_SPLIT.creatorPermanentPct

// All times in seconds from graduation (the DBC and DAMM v2 pools use timestamp activation).
export type VestingSchedule = {
  cliffSec: number // first release
  periods: number // weekly releases after the cliff
  periodSec: number
  bpsPerPeriod: number // of the vesting bucket; the rest (10000 − periods·bps) releases at the cliff
}

// Cliff = later of the tier minimum and the promised ship date plus the tier's buffer.
const TIERS: Record<TrustTierName, { periods: number; bpsPerPeriod: number; minCliffDays: number; afterShipDays: number }> = {
  A: { periods: 6, bpsPerPeriod: 1250, minCliffDays: 14, afterShipDays: 0 },
  B: { periods: 12, bpsPerPeriod: 750, minCliffDays: 30, afterShipDays: 14 },
  C: { periods: 20, bpsPerPeriod: 500, minCliffDays: 60, afterShipDays: 30 },
}

export function validateShipDays(shipDays: number): void {
  if (!Number.isInteger(shipDays) || shipDays < SHIP_DAYS.min || shipDays > SHIP_DAYS.max) {
    throw new Error(`ship date must be a whole number of days between ${SHIP_DAYS.min} and ${SHIP_DAYS.max}`)
  }
}

export function validateSchedule(s: VestingSchedule): void {
  const ints = [s.cliffSec, s.periods, s.periodSec, s.bpsPerPeriod]
  if (!ints.every((n) => Number.isInteger(n) && n >= 0)) throw new Error('vesting schedule values must be whole numbers')
  if (s.periods < 1 || s.periodSec < 1) throw new Error('vesting needs at least one period')
  if (s.cliffSec < 1) throw new Error('vesting cliff must be at least 1 second')
  if (s.periods * s.bpsPerPeriod > BPS) throw new Error('vesting periods release more than 100%')
  if (vestingEndSec(s) > MAX_LOCK_SEC) throw new Error('vesting must end within 2 years of graduation (DBC limit)')
}

// The tier schedule, or a localnet test override (seconds-scale) when one is given.
export function vestingSchedule(tier: TrustTierName, shipDays: number = SHIP_DAYS.default, override?: VestingSchedule | null): VestingSchedule {
  validateShipDays(shipDays)
  const t = TIERS[tier]
  const schedule = override ?? {
    cliffSec: Math.max(t.minCliffDays, shipDays + t.afterShipDays) * DAY,
    periods: t.periods,
    periodSec: WEEK,
    bpsPerPeriod: t.bpsPerPeriod,
  }
  validateSchedule(schedule)
  return schedule
}

export const cliffReleaseBps = (s: VestingSchedule) => BPS - s.periods * s.bpsPerPeriod
export const vestingEndSec = (s: VestingSchedule) => s.cliffSec + s.periods * s.periodSec

// Share of the vesting bucket released `elapsedSec` after graduation (bps).
export function releasedBpsAt(s: VestingSchedule, elapsedSec: number): number {
  if (elapsedSec < s.cliffSec) return 0
  const periods = Math.min(s.periods, Math.floor((elapsedSec - s.cliffSec) / s.periodSec))
  return cliffReleaseBps(s) + periods * s.bpsPerPeriod
}

// Seconds after graduation of the first release (the cliff, or one period later if nothing releases at it).
export const firstReleaseSec = (s: VestingSchedule) => (cliffReleaseBps(s) > 0 ? s.cliffSec : s.cliffSec + s.periodSec)

// Share of the raise the maker can reach, assuming no resale trading: the upfront share at goal,
// plus the USDC side of the vesting position once released. Vouchers released with it are burned.
export function makerPayoutPct(upfrontPct: number, s: VestingSchedule) {
  const vestingPct = ((100 - upfrontPct) * LP_SPLIT.creatorVestingPct) / 100
  return {
    atGoal: upfrontPct,
    atFirstRelease: upfrontPct + (vestingPct * releasedBpsAt(s, firstReleaseSec(s))) / BPS,
    max: upfrontPct + vestingPct,
    permanentFloorPct: PERMANENT_FLOOR_PCT,
  }
}

// Units the maker may have to deliver once the vesting bucket is unlocked and its vouchers burned:
// every pre-order, plus the resale vouchers that stay in the permanent floor and can still be bought.
export const unitsOwedAfterUnlock = (preorderUnits: number, resaleUnits: number) =>
  preorderUnits + (resaleUnits * PERMANENT_FLOOR_PCT) / 100

export const formatDuration = (sec: number) =>
  sec % DAY === 0 ? `${sec / DAY} day${sec === DAY ? '' : 's'}` : sec >= 3600 ? `${(sec / 3600).toFixed(1)} h` : `${sec} s`

// "day 30" for real schedules, "20 s after the goal" for the seconds-scale localnet override.
export const formatAfterGoal = (sec: number) => (sec % DAY === 0 ? `day ${sec / DAY}` : `${formatDuration(sec)} after the goal`)
