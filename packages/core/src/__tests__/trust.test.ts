import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreSignals, trustFixture } from '../trust'

test('brand-new wallet with no history is tier C', () => {
  const r = scoreSignals({ walletAgeDays: 2, txCount: 3, fundedByFreshWallet: false, verifiedSocial: false })
  assert.equal(r.tier, 'C')
  assert.equal(r.maxMakerSharePct, 10)
})

test('old, active, verified wallet is tier A', () => {
  const r = scoreSignals({ walletAgeDays: 800, txCount: 1000, fundedByFreshWallet: false, verifiedSocial: true })
  assert.equal(r.tier, 'A')
})

test('being funded by a fresh wallet costs a tier', () => {
  const clean = scoreSignals({ walletAgeDays: 400, txCount: 60, fundedByFreshWallet: false, verifiedSocial: false })
  const sus = scoreSignals({ walletAgeDays: 400, txCount: 60, fundedByFreshWallet: true, verifiedSocial: false })
  assert.equal(clean.tier, 'B')
  assert.equal(sus.tier, 'C')
  assert.ok(sus.reasons.some((r) => r.includes('brand new')))
})

test('TRUST_FIXTURES stand in for mainnet history on localnet only', () => {
  const TRUST_FIXTURES = JSON.stringify({ MAKER: { walletAgeDays: 800, txCount: 900 }, BAD: { walletAgeDays: 2 } })
  const a = trustFixture('MAKER', { NETWORK: 'localnet', TRUST_FIXTURES })
  assert.deepEqual(a, { walletAgeDays: 800, txCount: 900, fundedByFreshWallet: false, verifiedSocial: false })
  assert.equal(scoreSignals(a!).tier, 'B')
  assert.equal(scoreSignals({ ...a!, verifiedSocial: true }).tier, 'A')
  assert.equal(trustFixture('OTHER', { NETWORK: 'localnet', TRUST_FIXTURES }), null)
  assert.equal(trustFixture('MAKER', { NETWORK: 'devnet', TRUST_FIXTURES }), null)
  assert.equal(trustFixture('MAKER', { NETWORK: 'mainnet', TRUST_FIXTURES }), null)
  assert.throws(() => trustFixture('MAKER', { NETWORK: 'localnet', TRUST_FIXTURES: '{' }), /not valid JSON/)
})
