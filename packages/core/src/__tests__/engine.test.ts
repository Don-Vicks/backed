import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import BN from 'bn.js'
import {
  DammV2DynamicFeeMode,
  MAX_LOCK_DURATION_IN_SECONDS,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  calculateLockedLiquidityBpsAtTime,
  getBaseTokenForSwap,
  getMigrationBaseToken,
  validateConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DROP_BOT_START_FEE_BPS, DROP_BOT_WINDOWS_SEC } from '../campaign-input'
import { campaignToConfig, migrationQuoteAmount, vestingScheduleOverride, type Campaign } from '../engine'
import { DAY, WEEK, vestingEndSec } from '../vesting'
import { MAX_MAKER_SHARE, type TrustTierName } from '../trust'

// campaignToConfig reads VESTING_SCHEDULE_OVERRIDE (localnet only), and network.ts has loaded the repo
// .env by now. Keep a localnet demo setup out of the tier-schedule assertions; the override test below
// sets its own values and restores this state.
delete process.env.VESTING_SCHEDULE_OVERRIDE

const hoodie = (makerSharePct: number): Campaign => ({
  name: 'Hackathon Hoodie',
  symbol: 'HOOD',
  uri: 'https://example.com/hoodie.json',
  plan: {
    tiers: [
      { units: 20, startPrice: 25 },
      { units: 30, startPrice: 30 },
    ],
    finalPrice: 38,
    makerSharePct,
  },
  dropBot: { startFeeBps: 1500, windowSec: 120 },
  normalFeeBps: 100,
})

const close = (a: number, b: number, relTol: number) => Math.abs(a - b) <= Math.abs(b) * relTol

for (const tier of ['A', 'B', 'C'] as TrustTierName[]) {
  test(`tier ${tier}: config at the maker-share cap passes SDK validation`, () => {
    const { params } = campaignToConfig(hoodie(MAX_MAKER_SHARE[tier]), tier)
    assert.doesNotThrow(() => validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey } as any))
  })
}

test('on-chain goal and units match the plan', () => {
  const { pricing, onChain } = campaignToConfig(hoodie(25), 'B')
  assert.ok(close(onChain.goalUsdc, pricing.goalUsdc, 1e-4), `goal ${onChain.goalUsdc} vs ${pricing.goalUsdc}`)
  assert.ok(close(onChain.preorderUnits, pricing.preorderUnits, 1e-4), `units ${onChain.preorderUnits} vs ${pricing.preorderUnits}`)
  assert.ok(close(onChain.resaleUnits, pricing.resaleUnits, 1e-3), `resale ${onChain.resaleUnits} vs ${pricing.resaleUnits}`)
})

test('maker share above the trust-tier cap is rejected', () => {
  assert.throws(() => campaignToConfig(hoodie(MAX_MAKER_SHARE.C + 1), 'C'), /cap for trust tier C/)
})

// Plans the scripts and the web smoke test launch, plus seeded random ones.
type Plan = { tiers: { units: number; startPrice: number }[]; finalPrice: number }
const fixedPlans: Record<string, Plan> = {
  hoodie: hoodie(10).plan,
  lifecycle: { tiers: [{ units: 3, startPrice: 4 }, { units: 4, startPrice: 5 }], finalPrice: 6 },
  smoke: { tiers: [{ units: 2, startPrice: 3 }, { units: 2, startPrice: 4 }], finalPrice: 5 },
}

function randomPlans(count: number, seed: number): Plan[] {
  let state = seed
  const rand = () => ((state = (state * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  return Array.from({ length: count }, () => {
    const tiers = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => ({ units: 1 + Math.floor(rand() * 200), startPrice: 0 }))
    let price = Math.round((0.5 + rand() * 40) * 100) / 100
    for (const t of tiers) {
      t.startPrice = price
      price = Math.round((price + 0.25 + rand() * 20) * 100) / 100
    }
    return { tiers, finalPrice: price }
  })
}

const withPlan = (plan: Plan, makerSharePct: number): Campaign => ({ ...hoodie(makerSharePct), plan: { ...plan, makerSharePct } })

test('post-migration supply covers the curve plus the migration base the program computes, shares 1..40', () => {
  const all = [...Object.values(fixedPlans), ...randomPlans(12, 7)]
  for (const plan of all) {
    for (let share = 1; share <= MAX_MAKER_SHARE.A; share++) {
      const { params } = campaignToConfig(withPlan(plan, share), 'A')
      const threshold = params.migrationQuoteThreshold
      // The program keeps floor(threshold·share/100) as the fee, so the migrated quote is the ceiling.
      const ceilQuote = threshold.muln(100 - share).addn(99).divn(100)
      const sqrtMigration = params.curve[params.curve.length - 1].sqrtPrice
      const swapBase = getBaseTokenForSwap(params.sqrtStartPrice, sqrtMigration, params.curve)
      const needed = swapBase.add(getMigrationBaseToken(ceilQuote, sqrtMigration, MigrationOption.MET_DAMM_V2))
      const post = params.tokenSupply!.postMigrationTokenSupply
      assert.ok(post.gte(needed), `${JSON.stringify(plan)} share ${share}: post ${post} < needed ${needed}`)
    }
  }
})

const withShip = (makerSharePct: number, shipDays?: number): Campaign => ({ ...hoodie(makerSharePct), shipDays })

// The supply-rounding fix (createConfig 6020) together with the curve margin, ship-window vesting and the
// Customizable resale pool: every tier × allowed share × ship date, on the fixed plans and seeded random
// ones, passes SDK validation and leaves the post-migration supply covering what the program needs.
test('every tier × share × ship date: SDK validation and post-migration supply, with vesting and royalty', () => {
  const plans = [...Object.values(fixedPlans), ...randomPlans(4, 11)]
  for (const tier of ['A', 'B', 'C'] as TrustTierName[]) {
    for (const shipDays of [14, 60, 180]) {
      for (const plan of plans) {
        for (let share = 1; share <= MAX_MAKER_SHARE[tier]; share++) {
          const what = `tier ${tier} ship ${shipDays} share ${share} ${JSON.stringify(plan)}`
          const { params } = campaignToConfig({ ...withPlan(plan, share), shipDays, resaleRoyaltyBps: 500 }, tier)
          assert.doesNotThrow(() => validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey } as any), what)
          const ceilQuote = params.migrationQuoteThreshold.muln(100 - share).addn(99).divn(100)
          const sqrtMigration = params.curve[params.curve.length - 1].sqrtPrice
          const needed = getBaseTokenForSwap(params.sqrtStartPrice, sqrtMigration, params.curve).add(getMigrationBaseToken(ceilQuote, sqrtMigration, MigrationOption.MET_DAMM_V2))
          assert.ok(params.tokenSupply!.postMigrationTokenSupply.gte(needed), what)
        }
      }
    }
  }
})

for (const tier of ['A', 'B', 'C'] as TrustTierName[]) {
  test(`tier ${tier}: every allowed share × ship date passes SDK validation with 5/15/80 vesting`, () => {
    for (const shipDays of [14, 60, 180]) {
      for (let share = 1; share <= MAX_MAKER_SHARE[tier]; share++) {
        const { params } = campaignToConfig(withShip(share, shipDays), tier)
        assert.doesNotThrow(
          () => validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey } as any),
          `tier ${tier}, share ${share}%, ship day ${shipDays}`,
        )
      }
    }
  })
}

test('LP split: 5% partner and 15% creator permanent, 80% creator vesting, nothing unlocked', () => {
  const { params, vesting } = campaignToConfig(withShip(25, 60), 'B')
  assert.equal(params.partnerLiquidityPercentage, 0)
  assert.equal(params.partnerPermanentLockedLiquidityPercentage, 5)
  assert.equal(params.creatorLiquidityPercentage, 0)
  assert.equal(params.creatorPermanentLockedLiquidityPercentage, 15)
  assert.equal(params.partnerLiquidityVestingInfo.vestingPercentage, 0)
  const v = params.creatorLiquidityVestingInfo
  assert.deepEqual(
    { pct: v.vestingPercentage, bps: v.bpsPerPeriod, n: v.numberOfPeriods, freq: v.frequency, cliff: v.cliffDurationFromMigrationTime },
    { pct: 80, bps: 750, n: 12, freq: WEEK, cliff: (60 + 14) * DAY },
  )
  assert.deepEqual(vesting, { cliffSec: 74 * DAY, periods: 12, periodSec: WEEK, bpsPerPeriod: 750 })
})

test('locked liquidity: at least 10% at day 1, exactly the 20% floor once fully vested', () => {
  for (const tier of ['A', 'B', 'C'] as TrustTierName[]) {
    for (const shipDays of [14, 60, 180]) {
      const { params, vesting } = campaignToConfig(withShip(MAX_MAKER_SHARE[tier], shipDays), tier)
      const locked = (t: number) =>
        calculateLockedLiquidityBpsAtTime(
          params.partnerPermanentLockedLiquidityPercentage,
          params.creatorPermanentLockedLiquidityPercentage,
          params.partnerLiquidityVestingInfo,
          params.creatorLiquidityVestingInfo,
          t,
        )
      assert.ok(locked(DAY) >= 1000, `tier ${tier} day 1: ${locked(DAY)}`)
      assert.ok(locked(DAY) >= 9999, `tier ${tier}: everything is still locked on day 1`)
      assert.equal(locked(vestingEndSec(vesting)), 2000, `tier ${tier} ship ${shipDays} at the end`)
      assert.ok(vestingEndSec(vesting) <= MAX_LOCK_DURATION_IN_SECONDS)
    }
  }
})

test('migration quote is the threshold minus the floored maker fee', () => {
  assert.equal(migrationQuoteAmount(new BN(21195187), 40).toString(), (21195187 - Math.floor((21195187 * 40) / 100)).toString())
  assert.equal(migrationQuoteAmount(new BN(1001), 15).toString(), '851') // 1001 − floor(150.15)
})

test('maker share 0: no migration fee to split, and the SDK accepts the config', () => {
  const { params } = campaignToConfig(hoodie(0), 'C')
  assert.deepEqual(params.migrationFee, { feePercentage: 0, creatorFeePercentage: 0 })
  assert.doesNotThrow(() => validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey } as any))
})

test('only the fixed launch fee with a whitelisted window becomes a config', () => {
  for (const windowSec of DROP_BOT_WINDOWS_SEC) {
    const c = { ...hoodie(10), dropBot: { startFeeBps: DROP_BOT_START_FEE_BPS, windowSec } }
    const { params } = campaignToConfig(c, 'C')
    assert.doesNotThrow(() => validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey } as any))
  }
  const predatory = { ...hoodie(10), dropBot: { startFeeBps: 9900, windowSec: 60 }, normalFeeBps: 9000 }
  assert.throws(() => campaignToConfig(predatory, 'C'), /launch fee is fixed/)
  assert.throws(() => campaignToConfig({ ...hoodie(10), dropBot: { startFeeBps: 5000, windowSec: 600 } }, 'C'), /launch fee is fixed/)
  assert.throws(() => campaignToConfig({ ...hoodie(10), normalFeeBps: 25 }, 'C'), /launch fee is fixed/)
  assert.throws(() => campaignToConfig({ ...hoodie(10), dropBot: { startFeeBps: DROP_BOT_START_FEE_BPS, windowSec: 600 } }, 'C'), /window must be one of 60, 120, 300/)
})

test('campaigns without a ship date (older records) default to 30 days', () => {
  assert.deepEqual(campaignToConfig(hoodie(10), 'C').vesting, campaignToConfig(withShip(10, 30), 'C').vesting)
})

test('ship date outside 14–180 whole days is rejected', () => {
  for (const d of [13, 181, 30.5]) assert.throws(() => campaignToConfig(withShip(10, d), 'C'), /ship date/)
})

test('VESTING_SCHEDULE_OVERRIDE applies on localnet only and is validated', () => {
  const VESTING_SCHEDULE_OVERRIDE = JSON.stringify({ cliffSec: 20, periods: 2, periodSec: 10, bpsPerPeriod: 2500 })
  assert.deepEqual(vestingScheduleOverride({ NETWORK: 'localnet', VESTING_SCHEDULE_OVERRIDE }), { cliffSec: 20, periods: 2, periodSec: 10, bpsPerPeriod: 2500 })
  assert.equal(vestingScheduleOverride({ NETWORK: 'devnet', VESTING_SCHEDULE_OVERRIDE }), null)
  assert.equal(vestingScheduleOverride({ NETWORK: 'mainnet', VESTING_SCHEDULE_OVERRIDE }), null)
  assert.equal(vestingScheduleOverride({ NETWORK: 'localnet' }), null)
  assert.throws(() => vestingScheduleOverride({ NETWORK: 'localnet', VESTING_SCHEDULE_OVERRIDE: '{' }), /not valid JSON/)
  const tooMuch = JSON.stringify({ cliffSec: 20, periods: 3, periodSec: 10, bpsPerPeriod: 4000 })
  assert.throws(() => vestingScheduleOverride({ NETWORK: 'localnet', VESTING_SCHEDULE_OVERRIDE: tooMuch }), /more than 100%/)
})

test('the short localnet schedule still passes SDK validation', () => {
  const prev = { NETWORK: process.env.NETWORK, VESTING_SCHEDULE_OVERRIDE: process.env.VESTING_SCHEDULE_OVERRIDE }
  Object.assign(process.env, { NETWORK: 'localnet', VESTING_SCHEDULE_OVERRIDE: JSON.stringify({ cliffSec: 20, periods: 2, periodSec: 10, bpsPerPeriod: 2500 }) })
  try {
    const { params, vesting } = campaignToConfig(hoodie(40), 'A')
    assert.deepEqual(vesting, { cliffSec: 20, periods: 2, periodSec: 10, bpsPerPeriod: 2500 })
    assert.equal(params.creatorLiquidityVestingInfo.frequency, 10)
    assert.doesNotThrow(() => validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey } as any))
  } finally {
    for (const [k, v] of Object.entries(prev)) v === undefined ? delete process.env[k] : (process.env[k] = v)
  }
})

const withRoyalty = (resaleRoyaltyBps?: number): Campaign => ({ ...withShip(10, 60), resaleRoyaltyBps })

test('resale pool: Customizable, the maker-set fee in USDC only, dynamic fee on; 300 bps by default', () => {
  const { params, onChain } = campaignToConfig(withRoyalty(), 'C')
  assert.equal(params.migrationFeeOption, MigrationFeeOption.Customizable)
  assert.deepEqual(params.migratedPoolFee, { collectFeeMode: MigratedCollectFeeMode.QuoteToken, dynamicFee: DammV2DynamicFeeMode.Enabled, poolFeeBps: 300 })
  assert.equal(params.compoundingFeeBps, 0)
  assert.deepEqual({ option: onChain.migrationFeeOption, fee: onChain.resaleFeeBps }, { option: MigrationFeeOption.Customizable, fee: 300 })
  assert.equal(campaignToConfig(withRoyalty(750), 'C').params.migratedPoolFee!.poolFeeBps, 750)
})

for (const tier of ['A', 'B', 'C'] as TrustTierName[]) {
  test(`tier ${tier}: every resale royalty from 1% to 10% passes SDK validation`, () => {
    for (const bps of [100, 101, 250, 300, 500, 999, 1000]) {
      const { params } = campaignToConfig({ ...withRoyalty(bps), plan: { ...hoodie(0).plan, makerSharePct: MAX_MAKER_SHARE[tier] } }, tier)
      assert.doesNotThrow(() => validateConfigParameters({ ...params, leftoverReceiver: Keypair.generate().publicKey } as any), `tier ${tier}, ${bps} bps`)
    }
  })
}

test('resale royalty outside 100–1000 whole bps is rejected', () => {
  for (const bps of [0, 10, 99, 1001, 2000, 250.5, NaN]) assert.throws(() => campaignToConfig(withRoyalty(bps), 'C'), /resale royalty/, String(bps))
})
