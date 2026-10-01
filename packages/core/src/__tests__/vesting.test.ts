import { test } from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import type { PositionState } from '@meteora-ag/cp-amm-sdk'
import {
  DAY,
  WEEK,
  cliffReleaseBps,
  firstReleaseSec,
  makerPayoutPct,
  releasedBpsAt,
  unitsOwedAfterUnlock,
  vestingEndSec,
  vestingSchedule,
} from '../vesting'
import { nextReleaseAt } from '../unlock'

test('tier schedules follow the ship date', () => {
  assert.deepEqual(vestingSchedule('A', 14), { cliffSec: 14 * DAY, periods: 6, periodSec: WEEK, bpsPerPeriod: 1250 })
  assert.equal(vestingSchedule('A', 60).cliffSec, 60 * DAY)
  assert.equal(vestingSchedule('B', 14).cliffSec, 30 * DAY) // tier minimum
  assert.equal(vestingSchedule('B', 60).cliffSec, 74 * DAY) // ship date + 14 days
  assert.equal(vestingSchedule('C', 14).cliffSec, 60 * DAY)
  assert.equal(vestingSchedule('C', 180).cliffSec, 210 * DAY)
  assert.equal(vestingEndSec(vestingSchedule('C', 180)), 210 * DAY + 20 * WEEK)
})

test('release shares: A frees 25% at the cliff, C nothing until a week after it', () => {
  const a = vestingSchedule('A', 14)
  assert.equal(cliffReleaseBps(a), 2500)
  assert.equal(releasedBpsAt(a, a.cliffSec - 1), 0)
  assert.equal(releasedBpsAt(a, a.cliffSec), 2500)
  assert.equal(releasedBpsAt(a, a.cliffSec + WEEK), 3750)
  assert.equal(releasedBpsAt(a, vestingEndSec(a) + 999), 10_000)
  const c = vestingSchedule('C', 30)
  assert.equal(cliffReleaseBps(c), 0)
  assert.equal(firstReleaseSec(c), c.cliffSec + WEEK)
  assert.equal(releasedBpsAt(c, firstReleaseSec(c)), 500)
})

test('maker payout: upfront share plus 80% of the rest, 20% floor', () => {
  const p = makerPayoutPct(40, vestingSchedule('A', 14))
  assert.equal(p.atGoal, 40)
  assert.equal(p.max, 88) // 40 + 0.8 × 60
  assert.equal(p.atFirstRelease, 52) // 40 + 48 × 25%
  assert.equal(p.permanentFloorPct, 20)
  assert.equal(makerPayoutPct(10, vestingSchedule('C', 30)).max, 82)
  assert.equal(unitsOwedAfterUnlock(50, 30), 56)
})

const position = (v: { cliff: number; freq: number; n: number; cliffUnlock: number; perPeriod: number; vested?: number }) =>
  ({
    vestedLiquidity: new BN(v.vested ?? 100),
    innerVesting: {
      cliffPoint: new BN(v.cliff),
      periodFrequency: new BN(v.freq),
      numberOfPeriod: v.n,
      cliffUnlockLiquidity: new BN(v.cliffUnlock),
      liquidityPerPeriod: new BN(v.perPeriod),
      totalReleasedLiquidity: new BN(0),
    },
  }) as unknown as PositionState

test('next unlock: the cliff, then cliff + k × period, then none', () => {
  const p = position({ cliff: 1000, freq: 10, n: 2, cliffUnlock: 50, perPeriod: 25 })
  assert.equal(nextReleaseAt(p, 500), 1000)
  assert.equal(nextReleaseAt(p, 1000), 1010)
  assert.equal(nextReleaseAt(p, 1015), 1020)
  assert.equal(nextReleaseAt(p, 1020), null)
  // nothing released at the cliff: the first release is one period later
  assert.equal(nextReleaseAt(position({ cliff: 1000, freq: 10, n: 2, cliffUnlock: 0, perPeriod: 50 }), 500), 1010)
  assert.equal(nextReleaseAt(position({ cliff: 1000, freq: 10, n: 2, cliffUnlock: 50, perPeriod: 25, vested: 0 }), 500), null)
})
