// Whole pre-order units. One voucher redeems for one item, and redemption burns exactly one whole
// voucher, so backing is counted in whole units: a buy asks the curve for N vouchers out (DBC ExactOut)
// instead of spending N dollars and getting 0.98 of something. Pure: no SDK, safe to use in the UI.
import { SwapError } from './errors'

// Raw base units per voucher (VOUCHER_DECIMALS = 6 in engine.ts; a test pins the two together).
export const VOUCHER_RAW_PER_UNIT = BigInt(1_000_000)

// The most units one buy may ask for. Far above any tier, and keeps raw amounts exact as Numbers.
export const MAX_UNITS_PER_BUY = 1000

// A request's `units`, as a whole number of pre-orders.
export function checkUnits(value: unknown): number {
  const units = Number(value)
  if (!Number.isInteger(units) || units < 1) throw new SwapError('Pick a whole number of units', 400)
  if (units > MAX_UNITS_PER_BUY) throw new SwapError(`Back at most ${MAX_UNITS_PER_BUY} units at a time`, 400)
  return units
}

export const unitsToRaw = (units: number) => BigInt(units) * VOUCHER_RAW_PER_UNIT

// A voucher balance split into what can be redeemed and the fraction left over from USDC-in buys.
export function splitVouchers(raw: bigint): { whole: number; fractionRaw: bigint; fraction: number } {
  const fractionRaw = raw % VOUCHER_RAW_PER_UNIT
  return {
    whole: Number(raw / VOUCHER_RAW_PER_UNIT),
    fractionRaw,
    fraction: Number(fractionRaw) / Number(VOUCHER_RAW_PER_UNIT),
  }
}

// Vouchers to buy so a fractional balance becomes the next whole unit; 0 when it already is whole.
export function topUpRaw(raw: bigint): bigint {
  const fractionRaw = raw % VOUCHER_RAW_PER_UNIT
  return fractionRaw === BigInt(0) ? BigInt(0) : VOUCHER_RAW_PER_UNIT - fractionRaw
}

// The most whole units a buy can still ask for: the whole units left, or 1 when less than one is
// left. The last buy takes the remainder too (see planUnitsBuy), so it gets at least what it asked.
export function maxUnitsLeft(remainingRaw: bigint): number {
  if (remainingRaw <= BigInt(0)) return 0
  return Math.max(1, Number(remainingRaw / VOUCHER_RAW_PER_UNIT))
}

export type UnitsBuyMode = 'exactOut' | 'sweep'

// How to buy `wantRaw` vouchers when `remainingRaw` are left on the curve before the goal.
//  - exactOut: DBC ExactOut delivers exactly wantRaw, and at least one whole unit stays on the curve.
//  - sweep: the buy would leave less than one unit, which no whole-unit buy could ever take (the
//    curve sells 7.000001 for a 7-unit plan, since DBC rounds the swap amount up). So this buy takes
//    everything left (PartialFill up to the goal) and completes the campaign.
// Asking for more whole units than are left is refused rather than silently filled with fewer.
export function planUnitsBuy(wantRaw: bigint, remainingRaw: bigint): UnitsBuyMode {
  if (wantRaw <= BigInt(0)) throw new SwapError('Pick a whole number of units', 400)
  if (remainingRaw <= BigInt(0)) throw new SwapError('This campaign has reached its goal', 409)
  const left = maxUnitsLeft(remainingRaw)
  if (wantRaw > BigInt(left) * VOUCHER_RAW_PER_UNIT) {
    throw new SwapError(`Only ${left} unit${left === 1 ? '' : 's'} left before the goal`, 409)
  }
  return wantRaw + VOUCHER_RAW_PER_UNIT > remainingRaw ? 'sweep' : 'exactOut'
}

// The fewest vouchers a sweep accepts: everything left less slippage, but never fewer than the units
// asked for while the curve has them. A buy that lands between build and send and eats into those
// units makes the sweep fail instead of leaving the backer a fraction they cannot redeem.
export function sweepMinOut(wantRaw: bigint, remainingRaw: bigint, slippageBps: number): bigint {
  const slipped = (remainingRaw * BigInt(10_000 - slippageBps)) / BigInt(10_000)
  const want = wantRaw < remainingRaw ? wantRaw : remainingRaw
  return want > slipped ? want : slipped
}
