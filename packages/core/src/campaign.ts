import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  type ConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

// Phase 1 proof config: the exact combination Preorder Curves depends on.
// Phase 2 replaces these constants with campaignToConfig(campaign, tier).
export const PROOF_CAMPAIGN = {
  name: 'Proof Hoodie',
  symbol: 'PHOOD',
  units: 1_000, // total voucher supply (1 token = 1 unit)
  goalUsdc: 50, // funding goal = migrationQuoteThreshold
  makerSharePct: 30, // share of the raise paid to the maker at graduation
  // Drop-bot window: the fee starts high at launch and decays to the normal fee.
  // (DBC deprecated the rate limiter for new pools in SDK 1.5.12, so a per-buy size limit is not available.)
  dropStartFeeBps: 5_000, // 50% for bots that rush the drop
  dropEndFeeBps: 100, // 1% normal fee
  dropWindowSec: 60, // short for the devnet proof; ~10 minutes for real campaigns
  buySizeUsdc: 5, // size of each backer buy in the proof
}

export const MIGRATION_FEE_OPTION = MigrationFeeOption.FixedBps200

export function proofConfig(): ConfigParameters {
  const c = PROOF_CAMPAIGN
  return buildCurve({
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.SIX, // USDC
      tokenAuthorityOption: TokenAuthorityOption.Immutable, // no one can mint more vouchers
      totalTokenSupply: c.units,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential, // drop-bot window
        feeSchedulerParam: {
          startingFeeBps: c.dropStartFeeBps,
          endingFeeBps: c.dropEndFeeBps,
          numberOfPeriod: 6,
          totalDuration: c.dropWindowSec,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken, // fees in USDC
      creatorTradingFeePercentage: 50,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2, // resale market after funding
      migrationFeeOption: MIGRATION_FEE_OPTION,
      migrationFee: { feePercentage: c.makerSharePct, creatorFeePercentage: 100 }, // maker's production budget
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 20,
      partnerPermanentLockedLiquidityPercentage: 5,
      creatorLiquidityPercentage: 25,
      creatorPermanentLockedLiquidityPercentage: 50, // vouchers always have a resale market
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: c.goalUsdc,
  })
}
