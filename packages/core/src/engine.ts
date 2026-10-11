// campaignToConfig: turns a maker's plain-language campaign into an exact DBC config.
//
// We do not use buildCurveWithCustomSqrtPrices' own sizing: it spreads a given supply across the
// curve and adds a 25% swap buffer, which moves the goal away from what the maker asked for.
// Instead the curve liquidity is solved per tier so each tier sells exactly its units, the goal is
// the exact quote needed to walk the curve, and the supply is the minimum the program accepts:
//   supply = curve units + resale units
// The curve ends at the migration price, so the SDK's swap buffer is 0 and the pre- and
// post-migration supplies are equal: nothing is minted or burned at graduation.
//
// After graduation the maker is paid from the resale pool on a ship-window schedule (vesting.ts).
import BN from 'bn.js'
import Decimal from 'decimal.js'
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS,
  DammV2DynamicFeeMode,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  Rounding,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  convertDecimalToBN,
  convertToLamports,
  getBaseFeeParams,
  getBaseTokenForSwap,
  getDeltaAmountQuoteUnsigned,
  getDynamicFeeParams,
  getLiquidityVestingInfoParams,
  getLockedVestingParams,
  getMigratedPoolFeeParams,
  getMigrationBaseToken,
  getSqrtPriceFromPrice,
  getSwapAmountWithBuffer,
  type BaseFeeParams,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { checkLaunchFee } from './campaign-input'
import { priceTiers, type PricingSummary, type TierPlan } from './pricing'
import { MAX_MAKER_SHARE, type TrustTierName } from './trust'
import { parseNetwork } from './network'
import { resaleRoyaltyBps } from './royalty'
import {
  LP_SPLIT,
  SHIP_DAYS,
  cliffReleaseBps,
  firstReleaseSec,
  formatAfterGoal,
  formatDuration,
  validateSchedule,
  vestingEndSec,
  vestingSchedule,
  type VestingSchedule,
} from './vesting'

export const VOUCHER_DECIMALS = TokenDecimal.SIX
export const USDC_DECIMALS = 6
// Every campaign's resale pool takes the maker-set royalty (DAMM v2 config A8gM…, a dynamic config).
export const MIGRATION_FEE_OPTION = MigrationFeeOption.Customizable
// Campaigns created before the maker-set royalty migrate into the fixed 2% DAMM v2 config (2c4c…).
export const LEGACY_MIGRATION_FEE_OPTION = MigrationFeeOption.FixedBps200

export type Campaign = {
  name: string
  symbol: string
  uri: string // metadata JSON (name, image, description)
  description?: string
  image?: string
  makerName?: string // how the maker wants to be shown (a name or brand); display only, never on-chain
  plan: TierPlan
  dropBot: {
    startFeeBps: number // fee at launch, for bots rushing the drop
    windowSec: number // time for the fee to fall to the normal fee
  }
  normalFeeBps: number // fee after the drop window (DBC minimum is 25)
  shipDays?: number // promised ship date in days after the goal (14–180); sets the LP vesting cliff
  resaleRoyaltyBps?: number // resale pool fee, 100–1000 bps (default 300); older campaigns have a fixed 2%
}

export type ConfigField = { input: string; value: string; dbcField: string; dbcValue: string }

export type CampaignConfig = {
  params: ConfigParameters
  pricing: PricingSummary
  onChain: { goalUsdc: number; preorderUnits: number; resaleUnits: number; totalUnits: number; migrationFeeOption: MigrationFeeOption; resaleFeeBps: number }
  vesting: VestingSchedule // the maker's LP vesting, seconds after graduation
  fields: ConfigField[] // what the maker typed → what it became on-chain (UI panel + README)
}

// Localnet only: VESTING_SCHEDULE_OVERRIDE='{"cliffSec":20,"periods":2,"periodSec":10,"bpsPerPeriod":2500}'
// replaces the tier schedule so tests and the e2e demo can unlock in seconds. Ignored on devnet and mainnet.
export function vestingScheduleOverride(env: NodeJS.ProcessEnv = process.env): VestingSchedule | null {
  if (!env.VESTING_SCHEDULE_OVERRIDE?.trim() || parseNetwork(env.NETWORK) !== 'localnet') return null
  let s: VestingSchedule
  try {
    s = JSON.parse(env.VESTING_SCHEDULE_OVERRIDE)
  } catch {
    throw new Error('VESTING_SCHEDULE_OVERRIDE is not valid JSON')
  }
  const out = { cliffSec: s.cliffSec, periods: s.periods, periodSec: s.periodSec, bpsPerPeriod: s.bpsPerPeriod }
  validateSchedule(out)
  return out
}

// Raw vouchers added to each curve segment so it sells at least its units (0.00001 voucher per tier).
// It covers whole-unit (ExactOut) buys. Each USDC-amount buy rounds its output down and can use up
// to 1 raw of it, so many of those can leave the last backer's sweep a few raw short of whole.
export const CURVE_MARGIN_RAW = 10

const toRaw = (amount: number, decimals: number) => new Decimal(amount).mul(new Decimal(10).pow(decimals))
const fromRaw = (raw: BN, decimals: number) => new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toNumber()

// Quote that moves into the resale pool at graduation: the threshold minus the maker's migration fee,
// exactly as the program computes it.
export function migrationQuoteAmount(threshold: BN, makerSharePct: number): BN {
  return threshold.sub(threshold.muln(makerSharePct).divn(100))
}

export function campaignToConfig(campaign: Campaign, tier: TrustTierName): CampaignConfig {
  const { plan } = campaign
  if (plan.makerSharePct > MAX_MAKER_SHARE[tier]) {
    throw new Error(
      `Maker share ${plan.makerSharePct}% is above the ${MAX_MAKER_SHARE[tier]}% cap for trust tier ${tier}`,
    )
  }
  checkLaunchFee(campaign)

  const pricing = priceTiers(plan)
  const shipDays = campaign.shipDays ?? SHIP_DAYS.default
  const vesting = vestingSchedule(tier, shipDays, vestingScheduleOverride())

  // Curve: one DBC segment per tier, liquidity solved so the segment sells exactly its units.
  const prices = [...plan.tiers.map((t) => t.startPrice), plan.finalPrice]
  const sqrtPrices = prices.map((p) => getSqrtPriceFromPrice(String(p), VOUCHER_DECIMALS, USDC_DECIMALS))
  const curve = plan.tiers.map((t, i) => {
    const s0 = new Decimal(sqrtPrices[i].toString())
    const s1 = new Decimal(sqrtPrices[i + 1].toString())
    // base = L · (s1 − s0) / (s0 · s1)   (sqrt prices in Q64, as in the SDK's own builders)
    // Sized for a hair more than the tier's units: swaps round their output down, so a curve sized
    // exactly sold a 7-unit plan as 6.999999, and backing one unit at a time left the last backer 1.999998.
    const liquidity = toRaw(t.units, VOUCHER_DECIMALS).add(CURVE_MARGIN_RAW).mul(s0).mul(s1).div(s1.sub(s0))
    return { sqrtPrice: sqrtPrices[i + 1], liquidity: convertDecimalToBN(liquidity.ceil()) }
  })
  const sqrtStartPrice = sqrtPrices[0]
  const sqrtMigrationPrice = sqrtPrices[sqrtPrices.length - 1]

  // Goal = quote needed to walk the whole curve.
  let threshold = new BN(0)
  let lower = sqrtStartPrice
  for (const seg of curve) {
    threshold = threshold.add(getDeltaAmountQuoteUnsigned(lower, seg.sqrtPrice, seg.liquidity, Rounding.Up))
    lower = seg.sqrtPrice
  }

  // Supply: curve units (+ buffer before migration) + resale pool units.
  const swapBase = getBaseTokenForSwap(sqrtStartPrice, sqrtMigrationPrice, curve)
  const swapBaseBuffered = getSwapAmountWithBuffer(swapBase, sqrtStartPrice, curve)
  // The program takes the maker share as floor(threshold·share/100) and migrates the rest, so the
  // migration quote is rounded up. Flooring it here (as the SDK helper does) left the supply 1 lamport
  // short for some shares, and createConfig failed with InvalidTokenSupply (6020).
  const migrationQuote = migrationQuoteAmount(threshold, plan.makerSharePct)
  const migrationBase = getMigrationBaseToken(migrationQuote, sqrtMigrationPrice, MigrationOption.MET_DAMM_V2)
  const preMigrationTokenSupply = swapBaseBuffered.add(migrationBase)
  const postMigrationTokenSupply = swapBase.add(migrationBase)

  const baseFeeParams: BaseFeeParams = {
    baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
    feeSchedulerParam: {
      startingFeeBps: campaign.dropBot.startFeeBps,
      endingFeeBps: campaign.normalFeeBps,
      numberOfPeriod: 10,
      totalDuration: campaign.dropBot.windowSec,
    },
  }
  // Resale pool: the maker's royalty as a flat base fee plus DAMM v2's volatility fee, collected in
  // USDC only, so royalties never pay out in the maker's own vouchers.
  const resaleFeeBps = resaleRoyaltyBps(campaign)
  const migrated = getMigratedPoolFeeParams(
    MigrationOption.MET_DAMM_V2,
    MIGRATION_FEE_OPTION,
    { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Enabled, poolFeeBps: resaleFeeBps },
    baseFeeParams,
  )
  const noLiquidityVesting = getLiquidityVestingInfoParams(
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.vestingPercentage,
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.bpsPerPeriod,
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.numberOfPeriods,
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.cliffDurationFromMigrationTime,
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.totalDuration,
  )
  // The SDK's totalDuration is measured after the cliff (frequency = totalDuration / periods).
  const creatorLiquidityVesting = getLiquidityVestingInfoParams(
    LP_SPLIT.creatorVestingPct,
    vesting.bpsPerPeriod,
    vesting.periods,
    vesting.cliffSec,
    vesting.periods * vesting.periodSec,
  )

  const params: ConfigParameters = {
    poolFees: {
      baseFee: getBaseFeeParams(baseFeeParams),
      dynamicFee: getDynamicFeeParams(campaign.normalFeeBps),
    },
    activationType: ActivationType.Timestamp,
    collectFeeMode: CollectFeeMode.QuoteToken,
    migrationOption: MigrationOption.MET_DAMM_V2,
    tokenType: TokenType.SPLToken,
    tokenDecimal: VOUCHER_DECIMALS,
    migrationQuoteThreshold: threshold,
    // 20% of resale-pool liquidity is locked forever, so vouchers always have a market. The maker's
    // other 80% vests on the ship-window schedule and funds production. Every position, locked or
    // vesting, earns trading fees, so the maker earns on every resale.
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: LP_SPLIT.partnerPermanentPct,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: LP_SPLIT.creatorPermanentPct,
    sqrtStartPrice,
    lockedVesting: getLockedVestingParams(0, 0, 0, 0, 0, VOUCHER_DECIMALS),
    migrationFeeOption: migrated.migrationFeeOption,
    tokenSupply: { preMigrationTokenSupply, postMigrationTokenSupply },
    creatorTradingFeePercentage: 50,
    migratedPoolFee: migrated.migratedPoolFee,
    poolCreationFee: convertToLamports(0, 9),
    partnerLiquidityVestingInfo: noLiquidityVesting,
    creatorLiquidityVestingInfo: creatorLiquidityVesting,
    migratedPoolBaseFeeMode: migrated.migratedPoolBaseFeeMode,
    migratedPoolMarketCapFeeSchedulerParams: migrated.migratedPoolMarketCapFeeSchedulerParams,
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: migrated.compoundingFeeBps,
    padding: [],
    curve,
    // All of the migration fee is the maker's; with no fee there is nothing to split (the SDK rejects 100 of 0).
    migrationFee: { feePercentage: plan.makerSharePct, creatorFeePercentage: plan.makerSharePct > 0 ? 100 : 0 },
    tokenUpdateAuthority: TokenAuthorityOption.Immutable,
  } as ConfigParameters

  const onChain = {
    goalUsdc: fromRaw(threshold, USDC_DECIMALS),
    preorderUnits: fromRaw(swapBase, VOUCHER_DECIMALS),
    resaleUnits: fromRaw(migrationBase, VOUCHER_DECIMALS),
    totalUnits: fromRaw(postMigrationTokenSupply, VOUCHER_DECIMALS),
    migrationFeeOption: migrated.migrationFeeOption,
    resaleFeeBps,
  }

  const usd = (n: number) => `$${n.toFixed(2)}`
  const fields: ConfigField[] = [
    ...plan.tiers.map((t, i) => ({
      input: `Tier ${i + 1}`,
      value: `${t.units} units from ${usd(t.startPrice)}`,
      dbcField: `curve[${i}]`,
      dbcValue: `segment ${usd(t.startPrice)} → ${usd(pricing.segments[i].endPrice)}, avg ${usd(pricing.segments[i].averagePrice)}`,
    })),
    { input: 'Funding goal', value: usd(pricing.goalUsdc), dbcField: 'migrationQuoteThreshold', dbcValue: `${onChain.goalUsdc.toFixed(6)} USDC` },
    { input: 'Maker share', value: `${plan.makerSharePct}% (tier ${tier} cap ${MAX_MAKER_SHARE[tier]}%)`, dbcField: 'migrationFee', dbcValue: `feePercentage ${plan.makerSharePct}, creatorFeePercentage ${plan.makerSharePct > 0 ? 100 : 0}` },
    { input: 'Drop-bot window', value: `${campaign.dropBot.startFeeBps / 100}% → ${campaign.normalFeeBps / 100}% over ${campaign.dropBot.windowSec}s`, dbcField: 'baseFee', dbcValue: 'FeeSchedulerExponential' },
    { input: 'Limited edition', value: `${onChain.totalUnits.toFixed(2)} units max`, dbcField: 'tokenSupply + tokenUpdateAuthority', dbcValue: 'fixed post-migration supply, Immutable (no mint)' },
    { input: 'Resale market', value: `${onChain.resaleUnits.toFixed(2)} units + ${usd(pricing.resaleUsdc)} at ${usd(plan.finalPrice)}`, dbcField: 'migrationOption', dbcValue: 'DAMM v2' },
    { input: 'Resale royalty', value: `${resaleFeeBps / 100}% of every resale, in USDC, plus a volatility fee`, dbcField: 'migrationFeeOption + migratedPoolFee', dbcValue: `Customizable: poolFeeBps ${resaleFeeBps}, collectFeeMode QuoteToken, dynamicFee Enabled` },
    { input: 'Ship window', value: `ships by day ${shipDays}; the maker's ${LP_SPLIT.creatorVestingPct}% of resale liquidity unlocks from ${formatAfterGoal(firstReleaseSec(vesting))} to ${formatAfterGoal(vestingEndSec(vesting))}`, dbcField: 'creatorLiquidityVestingInfo', dbcValue: `vestingPercentage ${LP_SPLIT.creatorVestingPct}: ${cliffReleaseBps(vesting) / 100}% at the cliff, then ${vesting.periods} × ${vesting.bpsPerPeriod / 100}% every ${formatDuration(vesting.periodSec)}, all by ${formatDuration(vestingEndSec(vesting))}` },
    { input: 'Resale floor', value: `${LP_SPLIT.partnerPermanentPct + LP_SPLIT.creatorPermanentPct}% of resale liquidity locked forever`, dbcField: 'creator + partnerPermanentLockedLiquidityPercentage', dbcValue: `${LP_SPLIT.creatorPermanentPct} (maker) + ${LP_SPLIT.partnerPermanentPct} (platform)` },
    { input: 'Royalty split', value: `maker earns ${100 - LP_SPLIT.partnerPermanentPct}% of the LP fee, ${LP_SPLIT.creatorPermanentPct * 100 / (LP_SPLIT.creatorPermanentPct + LP_SPLIT.partnerPermanentPct)}% once fully unlocked`, dbcField: 'DAMM v2 position fees', dbcValue: "LP fee = pool fee minus Meteora's protocol share, split by liquidity" },
  ]

  return { params, pricing, onChain, vesting, fields }
}
