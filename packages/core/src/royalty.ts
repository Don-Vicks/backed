// Resale royalty: the fee on the DAMM v2 resale pool that graduation opens, set by the maker.
// Pure math, no SDK and no chain, so the create form can show the same numbers the engine writes.
//
// Every campaign migrates with DBC MigrationFeeOption.Customizable: the config carries the maker's pool
// fee (migratedPoolFeeBps), fees are collected in USDC only, and DAMM v2's dynamic (volatility) fee is
// on top. Each trade's fee is split by the program into Meteora's protocol share and the LP fee, and
// the LP fee is split between positions by liquidity. So what the maker actually earns per trade is
//   maker royalty = poolFeeBps × (1 − protocolFeePercent) × maker share of pool liquidity
// with protocolFeePercent read from chain (the resale pool once it exists), never assumed here.
import { BPS } from './vesting'

export const RESALE_ROYALTY_BPS = { min: 100, max: 1000, default: 300 }

// DBC MigrationFeeOption.Customizable, and the rates of the fixed options 0..5 (the DAMM v2 config each
// migrates into). Mirrored here so this file stays SDK-free.
const CUSTOMIZABLE = 6
const FIXED_FEE_BPS = [25, 30, 100, 200, 400, 600]

export function validateResaleRoyaltyBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < RESALE_ROYALTY_BPS.min || bps > RESALE_ROYALTY_BPS.max) {
    throw new Error(`resale royalty must be a whole number of bps between ${RESALE_ROYALTY_BPS.min} and ${RESALE_ROYALTY_BPS.max}`)
  }
}

// The campaign's royalty, defaulted for campaigns that never set one.
export function resaleRoyaltyBps(campaign: { resaleRoyaltyBps?: number }): number {
  const bps = campaign.resaleRoyaltyBps ?? RESALE_ROYALTY_BPS.default
  validateResaleRoyaltyBps(bps)
  return bps
}

// The base pool fee a DBC config gives its resale pool: its own migratedPoolFeeBps when Customizable,
// else the fixed rate of the DAMM v2 config it migrates into.
export function resalePoolFeeBps(migrationFeeOption: number, migratedPoolFeeBps: number): number {
  if (migrationFeeOption === CUSTOMIZABLE) return migratedPoolFeeBps
  const fixed = FIXED_FEE_BPS[migrationFeeOption]
  if (fixed === undefined) throw new Error(`unknown migration fee option ${migrationFeeOption}`)
  return fixed
}

// What the maker earns per resale trade, in bps of the trade (before the dynamic fee, which only adds).
// makerLiquidityBps: the maker's positions as a share of the pool's liquidity (9500 at graduation with
// the 5/15/80 split, 7500 once every vesting tranche is unlocked and withdrawn).
export function makerRoyaltyBps(poolFeeBps: number, protocolFeePct: number, makerLiquidityBps: number): number {
  return (poolFeeBps * (100 - protocolFeePct) * makerLiquidityBps) / (100 * BPS)
}
