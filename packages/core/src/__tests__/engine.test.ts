import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import BN from 'bn.js'
import { MigrationOption, getBaseTokenForSwap, getMigrationBaseToken, validateConfigParameters } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DROP_BOT_START_FEE_BPS, DROP_BOT_WINDOWS_SEC } from '../campaign-input'
import { campaignToConfig, migrationQuoteAmount, type Campaign } from '../engine'
import { MAX_MAKER_SHARE, type TrustTierName } from '../trust'

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
