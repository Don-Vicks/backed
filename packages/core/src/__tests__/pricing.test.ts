import { test } from 'node:test'
import assert from 'node:assert/strict'
import { priceTiers } from '../pricing'

test('one tier: average price is the geometric mean of start and end price', () => {
  const p = priceTiers({ tiers: [{ units: 10, startPrice: 4 }], finalPrice: 9, makerSharePct: 0 })
  assert.equal(p.segments[0].averagePrice, 6)
  assert.equal(p.goalUsdc, 60)
  assert.equal(p.resaleUnits, 60 / 9)
})

test('maker share reduces the resale pool, not the goal', () => {
  const p = priceTiers({ tiers: [{ units: 10, startPrice: 4 }], finalPrice: 9, makerSharePct: 25 })
  assert.equal(p.goalUsdc, 60)
  assert.equal(p.makerBudgetUsdc, 15)
  assert.equal(p.resaleUnits, 45 / 9)
  assert.equal(p.totalUnits, 10 + 5)
})

test('tiers must rise in price', () => {
  assert.throws(() => priceTiers({ tiers: [{ units: 5, startPrice: 10 }, { units: 5, startPrice: 8 }], finalPrice: 12, makerSharePct: 0 }))
  assert.throws(() => priceTiers({ tiers: [{ units: 5, startPrice: 10 }], finalPrice: 10, makerSharePct: 0 }))
})

test('tiers sell whole units: a fractional tier is rejected', () => {
  assert.throws(() => priceTiers({ tiers: [{ units: 2.5, startPrice: 4 }], finalPrice: 9, makerSharePct: 0 }), /whole number/)
  assert.doesNotThrow(() => priceTiers({ tiers: [{ units: 3, startPrice: 4 }], finalPrice: 9, makerSharePct: 0 }))
})
