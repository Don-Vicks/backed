import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import {
  DammV2DynamicFeeMode,
  MAX_LOCK_DURATION_IN_SECONDS,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  calculateLockedLiquidityBpsAtTime,
  validateConfigParameters,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { campaignToConfig, vestingScheduleOverride, type Campaign } from '../engine'
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
  dropBot: { startFeeBps: 5000, windowSec: 600 },
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

const withShip = (makerSharePct: number, shipDays?: number): Campaign => ({ ...hoodie(makerSharePct), shipDays })

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
