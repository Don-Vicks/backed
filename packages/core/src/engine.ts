// campaignToConfig: turns a maker's plain-language campaign into an exact DBC config.
//
// We do not use buildCurveWithCustomSqrtPrices' own sizing: it spreads a given supply across the
// curve and adds a 25% swap buffer, which moves the goal away from what the maker asked for.
// Instead the curve liquidity is solved per tier so each tier sells exactly its units, the goal is
// the exact quote needed to walk the curve, and the supply is the minimum the program accepts:
//   pre-migration  = curve units + 25% buffer + resale units
//   post-migration = curve units + resale units        (the program burns the unused buffer)
import BN from 'bn.js'
import Decimal from 'decimal.js'
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS,
  MigrationFeeOption,
  MigrationOption,
  Rounding,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  convertDecimalToBN,
  convertToLamports,
  fromDecimalToBN,
  getBaseFeeParams,
  getBaseTokenForSwap,
  getDeltaAmountQuoteUnsigned,
  getDynamicFeeParams,
  getLiquidityVestingInfoParams,
  getLockedVestingParams,
  getMigratedPoolFeeParams,
  getMigrationBaseToken,
  getMigrationQuoteAmountFromMigrationQuoteThreshold,
  getSqrtPriceFromPrice,
  getSwapAmountWithBuffer,
  type BaseFeeParams,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { priceTiers, type PricingSummary, type TierPlan } from './pricing'
import { MAX_MAKER_SHARE, type TrustTierName } from './trust'

export const VOUCHER_DECIMALS = TokenDecimal.SIX
export const USDC_DECIMALS = 6
export const MIGRATION_FEE_OPTION = MigrationFeeOption.FixedBps200 // 2% fee on the resale pool

export type Campaign = {
  name: string
  symbol: string
  uri: string // metadata JSON (name, image, description)
  plan: TierPlan
  dropBot: {
    startFeeBps: number // fee at launch, for bots rushing the drop
    windowSec: number // time for the fee to fall to the normal fee
  }
  normalFeeBps: number // fee after the drop window (DBC minimum is 25)
}

export type ConfigField = { input: string; value: string; dbcField: string; dbcValue: string }

export type CampaignConfig = {
  params: ConfigParameters
  pricing: PricingSummary
  onChain: { goalUsdc: number; preorderUnits: number; resaleUnits: number; totalUnits: number }
  fields: ConfigField[] // what the maker typed → what it became on-chain (UI panel + README)
}

const toRaw = (amount: number, decimals: number) => new Decimal(amount).mul(new Decimal(10).pow(decimals))
const fromRaw = (raw: BN, decimals: number) => new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toNumber()

export function campaignToConfig(campaign: Campaign, tier: TrustTierName): CampaignConfig {
  const { plan } = campaign
  if (plan.makerSharePct > MAX_MAKER_SHARE[tier]) {
    throw new Error(
      `Maker share ${plan.makerSharePct}% is above the ${MAX_MAKER_SHARE[tier]}% cap for trust tier ${tier}`,
    )
  }
  if (campaign.normalFeeBps < 25) throw new Error('normal fee must be at least 25 bps (DBC minimum)')
  if (campaign.dropBot.startFeeBps < campaign.normalFeeBps) throw new Error('drop-bot fee must start above the normal fee')

  const pricing = priceTiers(plan)

  // Curve: one DBC segment per tier, liquidity solved so the segment sells exactly its units.
  const prices = [...plan.tiers.map((t) => t.startPrice), plan.finalPrice]
  const sqrtPrices = prices.map((p) => getSqrtPriceFromPrice(String(p), VOUCHER_DECIMALS, USDC_DECIMALS))
  const curve = plan.tiers.map((t, i) => {
    const s0 = new Decimal(sqrtPrices[i].toString())
    const s1 = new Decimal(sqrtPrices[i + 1].toString())
    // base = L · (s1 − s0) / (s0 · s1)   (sqrt prices in Q64, as in the SDK's own builders)
    const liquidity = toRaw(t.units, VOUCHER_DECIMALS).mul(s0).mul(s1).div(s1.sub(s0))
    return { sqrtPrice: sqrtPrices[i + 1], liquidity: convertDecimalToBN(liquidity) }
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
  const migrationQuote = getMigrationQuoteAmountFromMigrationQuoteThreshold(
    new Decimal(threshold.toString()),
    plan.makerSharePct,
  )
  const migrationBase = getMigrationBaseToken(fromDecimalToBN(migrationQuote), sqrtMigrationPrice, MigrationOption.MET_DAMM_V2)
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
  const migrated = getMigratedPoolFeeParams(MigrationOption.MET_DAMM_V2, MIGRATION_FEE_OPTION, undefined, baseFeeParams)
  const noLiquidityVesting = getLiquidityVestingInfoParams(
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.vestingPercentage,
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.bpsPerPeriod,
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.numberOfPeriods,
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.cliffDurationFromMigrationTime,
    DEFAULT_LIQUIDITY_VESTING_INFO_PARAMS.totalDuration,
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
    // All resale-pool liquidity is locked forever: vouchers always have a market.
    // Locked positions still earn trading fees, so the maker earns on every resale.
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 20,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 80,
    sqrtStartPrice,
    lockedVesting: getLockedVestingParams(0, 0, 0, 0, 0, VOUCHER_DECIMALS),
    migrationFeeOption: migrated.migrationFeeOption,
    tokenSupply: { preMigrationTokenSupply, postMigrationTokenSupply },
    creatorTradingFeePercentage: 50,
    migratedPoolFee: migrated.migratedPoolFee,
    poolCreationFee: convertToLamports(0, 9),
    partnerLiquidityVestingInfo: noLiquidityVesting,
    creatorLiquidityVestingInfo: noLiquidityVesting,
    migratedPoolBaseFeeMode: migrated.migratedPoolBaseFeeMode,
    migratedPoolMarketCapFeeSchedulerParams: migrated.migratedPoolMarketCapFeeSchedulerParams,
    enableFirstSwapWithMinFee: false,
    compoundingFeeBps: migrated.compoundingFeeBps,
    padding: [],
    curve,
    migrationFee: { feePercentage: plan.makerSharePct, creatorFeePercentage: 100 },
    tokenUpdateAuthority: TokenAuthorityOption.Immutable,
  } as ConfigParameters

  const onChain = {
    goalUsdc: fromRaw(threshold, USDC_DECIMALS),
    preorderUnits: fromRaw(swapBase, VOUCHER_DECIMALS),
    resaleUnits: fromRaw(migrationBase, VOUCHER_DECIMALS),
    totalUnits: fromRaw(postMigrationTokenSupply, VOUCHER_DECIMALS),
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
    { input: 'Maker share', value: `${plan.makerSharePct}% (tier ${tier} cap ${MAX_MAKER_SHARE[tier]}%)`, dbcField: 'migrationFee', dbcValue: `feePercentage ${plan.makerSharePct}, creatorFeePercentage 100` },
    { input: 'Drop-bot window', value: `${campaign.dropBot.startFeeBps / 100}% → ${campaign.normalFeeBps / 100}% over ${campaign.dropBot.windowSec}s`, dbcField: 'baseFee', dbcValue: 'FeeSchedulerExponential' },
    { input: 'Limited edition', value: `${onChain.totalUnits.toFixed(2)} units max`, dbcField: 'tokenSupply + tokenUpdateAuthority', dbcValue: 'fixed post-migration supply, Immutable (no mint)' },
    { input: 'Resale market', value: `${onChain.resaleUnits.toFixed(2)} units + ${usd(pricing.resaleUsdc)} at ${usd(plan.finalPrice)}`, dbcField: 'migrationOption', dbcValue: 'DAMM v2, 2% fee' },
    { input: 'Resale royalties', value: 'maker earns 80% of resale fees', dbcField: 'creatorPermanentLockedLiquidityPercentage', dbcValue: '80 (partner 20), 100% locked forever' },
  ]

  return { params, pricing, onChain, fields }
}
