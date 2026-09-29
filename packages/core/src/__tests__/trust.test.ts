import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreSignals } from '../trust'

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
