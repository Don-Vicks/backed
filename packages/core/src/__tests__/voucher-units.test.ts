import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VOUCHER_DECIMALS } from '../engine'
import {
  MAX_UNITS_PER_BUY,
  UnitsError,
  VOUCHER_RAW_PER_UNIT,
  checkUnits,
  maxUnitsLeft,
  planUnitsBuy,
  splitVouchers,
  sweepMinOut,
  topUpRaw,
  unitsToRaw,
} from '../voucher-units'

const U = VOUCHER_RAW_PER_UNIT
const raw = (units: number) => BigInt(Math.round(units * 1e6))

test('one unit is one voucher at the mint decimals', () => {
  assert.equal(U, BigInt(10 ** VOUCHER_DECIMALS))
  assert.equal(unitsToRaw(3), BigInt(3_000_000))
})

test('units must be a positive whole number, capped per buy', () => {
  assert.equal(checkUnits(2), 2)
  assert.equal(checkUnits('3'), 3)
  for (const bad of [0, -1, 1.5, NaN, Infinity, 'two', null, undefined, MAX_UNITS_PER_BUY + 1]) {
    assert.throws(() => checkUnits(bad), (e: unknown) => e instanceof UnitsError && e.status === 400, String(bad))
  }
})

test('a balance splits into whole vouchers and the fraction left by a USDC-amount buy', () => {
  assert.deepEqual(splitVouchers(raw(3.43)), { whole: 3, fractionRaw: BigInt(430_000), fraction: 0.43 })
  assert.deepEqual(splitVouchers(raw(2)), { whole: 2, fractionRaw: BigInt(0), fraction: 0 })
  assert.deepEqual(splitVouchers(BigInt(0)), { whole: 0, fractionRaw: BigInt(0), fraction: 0 })
})

test('top up buys exactly the rest of the next whole voucher', () => {
  assert.equal(topUpRaw(raw(0.49)), BigInt(510_000))
  assert.equal(topUpRaw(raw(3.999999)), BigInt(1))
  assert.equal(topUpRaw(raw(2)), BigInt(0))
  assert.equal(topUpRaw(BigInt(0)), BigInt(0))
})

test('ExactOut while at least one whole unit stays on the curve', () => {
  assert.equal(planUnitsBuy(unitsToRaw(1), raw(7.000001)), 'exactOut')
  assert.equal(planUnitsBuy(unitsToRaw(6), raw(7.000001)), 'exactOut')
  assert.equal(planUnitsBuy(unitsToRaw(2), raw(3)), 'exactOut')
})

test('the last buy sweeps the rest, so whole-unit buys still reach the goal', () => {
  // 7 units of a 7.000001 curve would leave 0.000001 that no one could ever buy.
  assert.equal(planUnitsBuy(unitsToRaw(7), raw(7.000001)), 'sweep')
  assert.equal(planUnitsBuy(unitsToRaw(1), raw(1.000001)), 'sweep')
  assert.equal(planUnitsBuy(unitsToRaw(2), raw(2.5)), 'sweep')
  // Less than one unit left (after USDC-amount buys): backing 1 takes it and completes the goal.
  assert.equal(planUnitsBuy(unitsToRaw(1), raw(0.3)), 'sweep')
  assert.equal(planUnitsBuy(raw(0.51), raw(1.2)), 'sweep')
})

test('asking for more whole units than are left is refused, not silently shrunk', () => {
  assert.throws(() => planUnitsBuy(unitsToRaw(3), raw(2)), (e: unknown) => e instanceof UnitsError && e.status === 409 && /Only 2 units left/.test(e.message))
  assert.throws(() => planUnitsBuy(unitsToRaw(3), raw(2.999999)), /Only 2 units left/)
  assert.throws(() => planUnitsBuy(unitsToRaw(8), raw(7.000001)), /Only 7 units left/)
  assert.throws(() => planUnitsBuy(unitsToRaw(2), raw(0.3)), /Only 1 unit left/)
  assert.throws(() => planUnitsBuy(unitsToRaw(1), BigInt(0)), (e: unknown) => e instanceof UnitsError && e.status === 409 && /goal/.test(e.message))
})

test('maxUnitsLeft counts whole units left, and 1 while any fraction is left', () => {
  assert.equal(maxUnitsLeft(raw(7.000001)), 7)
  assert.equal(maxUnitsLeft(raw(7)), 7)
  assert.equal(maxUnitsLeft(raw(2.5)), 2)
  assert.equal(maxUnitsLeft(raw(0.3)), 1)
  assert.equal(maxUnitsLeft(BigInt(0)), 0)
})

test('a sweep never accepts fewer vouchers than the units asked for', () => {
  // The common last buy: 1.000019 left, back 1. Slippage alone would accept 0.990018, which a $0.03
  // front-run turns into an unredeemable 0.993374.
  assert.equal(sweepMinOut(unitsToRaw(1), raw(1.000019), 100), unitsToRaw(1))
  assert.equal(sweepMinOut(unitsToRaw(2), raw(2.000018), 500), unitsToRaw(2))
  // Less left than asked: everything left is the floor.
  assert.equal(sweepMinOut(unitsToRaw(1), raw(0.3), 100), raw(0.3))
  // Far more left than asked (a top-up near the goal): slippage on the rest is the tighter bound.
  assert.equal(sweepMinOut(raw(0.61), raw(1.2), 100), raw(1.188))
})
