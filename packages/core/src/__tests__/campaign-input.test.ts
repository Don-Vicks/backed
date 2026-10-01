import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DROP_BOT_START_FEE_BPS, MAX_GOAL_USDC, MAX_PRICE_RATIO, NORMAL_FEE_BPS, campaignFromInput } from '../campaign-input'
import { MAX_TIERS, priceTiers } from '../pricing'

const URI = 'https://backed.example/m/abcdefghij'
const body = (over: Record<string, unknown> = {}) => ({
  name: ' Hackathon Hoodie ',
  symbol: 'hood',
  uri: 'https://evil.example/fake.json',
  description: 'Heavyweight cotton.',
  image: 'https://img.example/hoodie.png',
  plan: { tiers: [{ units: 20, startPrice: 25 }, { units: 30, startPrice: 30 }], finalPrice: 38, makerSharePct: 10 },
  dropBot: { windowSec: 120 },
  ...over,
})
const plan = (over: Record<string, unknown>) => ({ ...body().plan, ...over })

test('builds the campaign from allowlisted fields only, with the server uri and the fixed fees', () => {
  const c = campaignFromInput({ ...body(), verifiedSocial: true, extra: 'x', plan: { ...body().plan, junk: 1 } }, URI)
  assert.deepEqual(c, {
    name: 'Hackathon Hoodie',
    symbol: 'HOOD',
    uri: URI,
    description: 'Heavyweight cotton.',
    image: 'https://img.example/hoodie.png',
    plan: { tiers: [{ units: 20, startPrice: 25 }, { units: 30, startPrice: 30 }], finalPrice: 38, makerSharePct: 10 },
    dropBot: { startFeeBps: DROP_BOT_START_FEE_BPS, windowSec: 120 },
    normalFeeBps: NORMAL_FEE_BPS,
  })
  // The client may echo the fixed fees.
  const echoed = campaignFromInput(body({ dropBot: { startFeeBps: 1500, windowSec: 60 }, normalFeeBps: 100 }), URI)
  assert.equal(echoed.dropBot.windowSec, 60)
})

test('rejects any other fee schedule instead of rewriting it', () => {
  assert.throws(() => campaignFromInput(body({ dropBot: { startFeeBps: 9900, windowSec: 60 }, normalFeeBps: 9000 }), URI), /launch fee is fixed/)
  assert.throws(() => campaignFromInput(body({ normalFeeBps: 9000 }), URI), /launch fee is fixed/)
  assert.throws(() => campaignFromInput(body({ dropBot: { windowSec: 600 } }), URI), /window must be one of/)
  assert.throws(() => campaignFromInput(body({ dropBot: undefined }), URI), /window must be one of/)
})

test('name, ticker, description and image limits', () => {
  assert.throws(() => campaignFromInput(body({ name: '  ' }), URI), /Name the product/)
  assert.doesNotThrow(() => campaignFromInput(body({ name: 'N'.repeat(32) }), URI))
  assert.throws(() => campaignFromInput(body({ name: 'N'.repeat(33) }), URI), /32 bytes/)
  assert.throws(() => campaignFromInput(body({ name: '€'.repeat(11) }), URI), /32 bytes/) // 33 bytes in 11 characters
  assert.equal(campaignFromInput(body({ symbol: 'ab12' }), URI).symbol, 'AB12')
  for (const symbol of ['', 'TOOLONGTICK', 'HO OD', 'HÖÖD', 42]) {
    assert.throws(() => campaignFromInput(body({ symbol }), URI), /ticker/, String(symbol))
  }
  assert.doesNotThrow(() => campaignFromInput(body({ description: 'd'.repeat(1000) }), URI))
  assert.throws(() => campaignFromInput(body({ description: 'd'.repeat(1001) }), URI), /description/)
  assert.equal(campaignFromInput(body({ image: '' }), URI).image, undefined)
  assert.throws(() => campaignFromInput(body({ image: 'http://img.example/a.png' }), URI), /https/)
  assert.throws(() => campaignFromInput(body({ image: 'javascript:alert(1)' }), URI), /https/)
  assert.throws(() => campaignFromInput(body({ image: `https://img.example/${'a'.repeat(200)}` }), URI), /200/)
})

test('plan: whole units, at most MAX_TIERS tiers, finite prices', () => {
  const tier = (i: number) => ({ units: 5, startPrice: 1 + i })
  assert.doesNotThrow(() => campaignFromInput(body({ plan: plan({ tiers: [0, 1, 2, 3].map(tier), finalPrice: 9 }) }), URI))
  assert.throws(() => campaignFromInput(body({ plan: plan({ tiers: [0, 1, 2, 3, 4].map(tier), finalPrice: 9 }) }), URI), /at most 4 tiers/)
  assert.throws(() => campaignFromInput(body({ plan: plan({ tiers: [{ units: 2.5, startPrice: 25 }] }) }), URI), /whole/)
  assert.throws(() => campaignFromInput(body({ plan: plan({ tiers: [{ units: '20', startPrice: 25 }] }) }), URI), /must be a number/)
  assert.throws(() => campaignFromInput(body({ plan: plan({ finalPrice: Infinity }) }), URI), /must be a number/)
  assert.throws(() => campaignFromInput(body({ plan: plan({ makerSharePct: 10.5 }) }), URI), /whole percentage/)
  assert.throws(() => campaignFromInput(body({ plan: plan({ tiers: [] }) }), URI), /at least one tier/)
  assert.throws(() => campaignFromInput(body({ plan: undefined }), URI), /plan is missing/)
  assert.throws(() => campaignFromInput(null, URI), /campaign is missing/)
})

test('MAX_TIERS is enforced by the shared pricing validation too', () => {
  const tiers = Array.from({ length: MAX_TIERS + 1 }, (_, i) => ({ units: 1, startPrice: 1 + i }))
  assert.throws(() => priceTiers({ tiers, finalPrice: 20, makerSharePct: 0 }), /at most 4 tiers/)
  assert.throws(() => priceTiers({ tiers: [{ units: 1.5, startPrice: 1 }], finalPrice: 2, makerSharePct: 0 }), /whole/)
})

test('plan: the goal and the price ratio are bounded, with a clear message', () => {
  // The case that used to reach the SDK: in range per tier, ~1e12 USDC in total.
  assert.throws(() => campaignFromInput(body({ plan: plan({ tiers: [{ units: 1_000_000, startPrice: 999_999 }], finalPrice: 1_000_000 }) }), URI), /goal can be at most 10,000,000 USDC/)
  const flat = (startPrice: number) => body({ plan: plan({ tiers: [{ units: 1_000_000, startPrice }], finalPrice: 10.1 }) })
  assert.ok(priceTiers(campaignFromInput(flat(9.9), URI).plan).goalUsdc <= MAX_GOAL_USDC)
  assert.throws(() => campaignFromInput(flat(10), URI), /goal/)
  // Final price up to MAX_PRICE_RATIO times the first tier's price.
  assert.doesNotThrow(() => campaignFromInput(body({ plan: plan({ tiers: [{ units: 1, startPrice: 0.01 }], finalPrice: 0.01 * MAX_PRICE_RATIO }) }), URI))
  assert.throws(() => campaignFromInput(body({ plan: plan({ tiers: [{ units: 1, startPrice: 0.01 }], finalPrice: 1.01 }) }), URI), /at most 100× the first tier/)
})
