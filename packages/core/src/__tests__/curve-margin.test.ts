import { test } from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Rounding, getDeltaAmountBaseUnsigned } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CURVE_MARGIN_RAW, campaignToConfig, type Campaign } from '../engine'

const campaign = (tiers: { units: number; startPrice: number }[], finalPrice: number): Campaign => ({
  name: 'Curve',
  symbol: 'CRV',
  uri: 'https://example.com/c.json',
  plan: { tiers, finalPrice, makerSharePct: 20 },
  dropBot: { startFeeBps: 1500, windowSec: 120 },
  normalFeeBps: 100,
})

// What a swap through each whole segment delivers (output rounds down, as on chain).
test('every curve segment sells at least its tier units, and at most the margin over', () => {
  const plans = [
    campaign([{ units: 3, startPrice: 4 }, { units: 4, startPrice: 5 }], 6),
    campaign([{ units: 20, startPrice: 25 }, { units: 30, startPrice: 30 }], 40),
    campaign([{ units: 1, startPrice: 10 }], 12),
    campaign([{ units: 7, startPrice: 3 }, { units: 3, startPrice: 3.5 }, { units: 5, startPrice: 4.2 }], 5),
  ]
  for (const c of plans) {
    const { params } = campaignToConfig(c, 'A')
    let lower: BN = params.sqrtStartPrice
    params.curve.forEach((seg, i) => {
      const sold = getDeltaAmountBaseUnsigned(lower, seg.sqrtPrice, seg.liquidity, Rounding.Down)
      const units = new BN(c.plan.tiers[i].units * 1_000_000)
      assert.ok(sold.gte(units), `tier ${i + 1}: sells ${sold}, plan ${units}`)
      assert.ok(sold.lte(units.addn(CURVE_MARGIN_RAW + 1)), `tier ${i + 1}: sells ${sold}, plan ${units}`)
      lower = seg.sqrtPrice
    })
  }
})
