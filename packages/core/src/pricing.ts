// Pure pricing math for a pre-order curve. No SDK, no chain: safe to use in the UI.
//
// A DBC segment between prices P0 and P1 with liquidity L sells
//   base  = L (1/√P0 − 1/√P1)      and raises   quote = L (√P1 − √P0)
// so the average price paid in a segment is quote / base = √(P0 · P1).
// That lets a maker specify units per early-bird tier and get an exact goal.

export type Tier = {
  units: number // vouchers sold in this tier
  startPrice: number // USDC per voucher at the start of the tier
}

export type TierPlan = {
  tiers: Tier[]
  finalPrice: number // USDC per voucher when the goal is reached (end of the last tier)
  makerSharePct: number // share of the raise paid to the maker at graduation (DBC migration fee)
}

export type Segment = {
  units: number
  startPrice: number
  endPrice: number
  averagePrice: number
  raise: number
  weight: number // relative DBC liquidity for this segment
}

export type PricingSummary = {
  segments: Segment[]
  preorderUnits: number // sold on the curve before the goal
  goalUsdc: number // raised on the curve = DBC migration quote threshold
  makerBudgetUsdc: number // paid to the maker at graduation
  resaleUsdc: number // goes into the resale pool as USDC
  resaleUnits: number // vouchers placed in the resale pool at graduation
  totalUnits: number // total voucher supply the maker must be able to produce
}

// DBC takes up to 16 curve segments, but each tier adds 32 bytes to the create transaction and the
// create flow is sized (and tested) for this many.
export const MAX_TIERS = 4

export function validatePlan(plan: TierPlan): void {
  if (plan.tiers.length === 0) throw new Error('at least one tier is required')
  if (plan.tiers.length > MAX_TIERS) throw new Error(`at most ${MAX_TIERS} tiers`)
  plan.tiers.forEach((t, i) => {
    if (!(t.units > 0)) throw new Error(`tier ${i + 1}: units must be positive`)
    // Vouchers redeem one whole item each, so tiers sell whole units (back-by-units buys exactly that).
    if (!Number.isInteger(t.units)) throw new Error(`tier ${i + 1}: units must be a whole number`)
    if (!(t.startPrice > 0)) throw new Error(`tier ${i + 1}: price must be positive`)
    const next = plan.tiers[i + 1]?.startPrice ?? plan.finalPrice
    if (!(next > t.startPrice)) throw new Error(`tier ${i + 1}: prices must rise from tier to tier and up to the final price`)
  })
  if (!(plan.makerSharePct >= 0 && plan.makerSharePct <= 50)) {
    throw new Error('maker share must be between 0 and 50%')
  }
  if (!Number.isInteger(plan.makerSharePct)) throw new Error('maker share must be a whole percentage')
}

export function priceTiers(plan: TierPlan): PricingSummary {
  validatePlan(plan)
  const segments: Segment[] = plan.tiers.map((t, i) => {
    const endPrice = plan.tiers[i + 1]?.startPrice ?? plan.finalPrice
    const s0 = Math.sqrt(t.startPrice)
    const s1 = Math.sqrt(endPrice)
    const averagePrice = s0 * s1
    // L = units / (1/√P0 − 1/√P1)
    const weight = t.units / (1 / s0 - 1 / s1)
    return { units: t.units, startPrice: t.startPrice, endPrice, averagePrice, raise: t.units * averagePrice, weight }
  })
  const preorderUnits = segments.reduce((a, s) => a + s.units, 0)
  const goalUsdc = segments.reduce((a, s) => a + s.raise, 0)
  const makerBudgetUsdc = (goalUsdc * plan.makerSharePct) / 100
  const resaleUsdc = goalUsdc - makerBudgetUsdc
  const resaleUnits = resaleUsdc / plan.finalPrice
  return {
    segments,
    preorderUnits,
    goalUsdc,
    makerBudgetUsdc,
    resaleUsdc,
    resaleUnits,
    totalUnits: preorderUnits + resaleUnits,
  }
}
