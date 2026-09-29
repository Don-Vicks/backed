import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@solana/web3.js'
import { validateConfigParameters } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { campaignToConfig, type Campaign } from '../engine'
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
