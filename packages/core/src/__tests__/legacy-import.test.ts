// The JSON-file stores the safety track kept before the database (orders with shipping sealed to
// pool:wallet, pending redemptions, faucet claims, rate buckets) are imported once into it, with the
// shipping details re-sealed to their burn signature under SHIPPING_KEY.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Point the repo root (keys/) and the store (data/) at a temp dir before anything reads them.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-legacy-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'localnet'
delete process.env.DATA_DIR
delete process.env.SHIPPING_KEY
delete process.env.SHIPPING_ENCRYPTION_KEY
delete process.env.SHIPPING_KEY_PREVIOUS

import { closeDb, db, getMeta, legacyPlaintextFiles, redemptionAad } from '../db'
import { countFaucetClaims, takeRateToken } from '../store'
import { getPendingRedemption, getRedemption, listRedemptions } from '../redemptions'
import { isLegacySealed, openJson } from '../seal'

// What the JSON store wrote: { v: 1, iv, tag, data } in base64, bound to `<pool>:<wallet>`.
function legacySeal(value: unknown, pool: string, wallet: string, key: Buffer) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(`${pool}:${wallet}`))
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return { v: 1 as const, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

const ada = { name: 'Ada Lovelace', email: 'ada@example.com', address: '12 Analytical Way', country: 'UK' }
const bob = { name: 'Bob', email: '', address: '1 St', country: 'X' }

test('the JSON-file stores are imported once, shipping re-sealed to the burn signature', () => {
  // A local run without SHIPPING_ENCRYPTION_KEY generated its key here.
  const generated = crypto.randomBytes(32)
  fs.mkdirSync(path.join(root, 'keys', 'localnet'), { recursive: true })
  fs.writeFileSync(path.join(root, 'keys', 'localnet', 'shipping-key'), generated.toString('hex'))
  const data = path.join(root, 'data')
  fs.mkdirSync(data, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(
    path.join(data, 'redemptions.localnet.json'),
    JSON.stringify([
      { id: 'r1', pool: 'P', signature: 'S1', wallet: 'W1', units: 1, shipping: legacySeal(ada, 'P', 'W1', generated), createdAt: '2026-09-01T00:00:00.000Z' },
      { pool: 'P', signature: 'S0', wallet: 'W0', units: 2, shipping: bob, createdAt: '2026-08-01T00:00:00.000Z' }, // before encryption
      { id: 'r2', pool: 'P', signature: 'S2', wallet: 'W2', units: 1, shipping: null, createdAt: '2026-09-02T00:00:00.000Z', shippedAt: '2026-09-03T00:00:00.000Z' },
    ]),
  )
  fs.writeFileSync(
    path.join(data, 'pending-redemptions.localnet.json'),
    JSON.stringify([
      { id: 'p1', pool: 'P', wallet: 'W3', units: 1, shipping: legacySeal(bob, 'P', 'W3', generated), createdAt: new Date(now).toISOString(), signature: 'S3', lastValidBlockHeight: 42 },
    ]),
  )
  fs.writeFileSync(
    path.join(data, 'faucet-claims.localnet.json'),
    JSON.stringify([
      { wallet: 'F1', ip: '1.1.1.1', claimedAt: now - 1000 },
      { wallet: 'F2', ip: null, claimedAt: now - 2000 },
    ]),
  )
  fs.writeFileSync(path.join(data, 'rate.localnet.json'), JSON.stringify({ 'faucet:1.1.1.1': { tokens: 0, updatedAt: now, fullAt: now + 300_000 } }))

  const orders = listRedemptions('P')
  assert.deepEqual(
    orders.map((o) => [o.signature, o.id, o.units, o.shipping?.name ?? null, o.shippedAt ?? null]),
    [
      ['S2', 'r2', 1, null, '2026-09-03T00:00:00.000Z'],
      ['S1', 'r1', 1, 'Ada Lovelace', null],
      ['S0', undefined, 2, 'Bob', null],
    ],
  )
  assert.ok(!orders.some((o) => o.unreadable))
  assert.equal(getRedemption('r1')?.signature, 'S1')
  // Re-sealed in the one scheme, bound to the burn: the old pool:wallet binding is gone.
  const sealed = (db().prepare('SELECT shipping_ct FROM redemptions WHERE signature = ?').get('S1') as { shipping_ct: string }).shipping_ct
  assert.match(sealed, /^v1\./)
  assert.deepEqual(openJson(sealed, redemptionAad('S1')), ada)

  const pending = getPendingRedemption('p1')!
  assert.equal(pending.signature, 'S3')
  assert.equal(pending.lastValidBlockHeight, 42)
  assert.ok(!isLegacySealed(pending.shipping))
  assert.deepEqual(openJson(pending.shipping, redemptionAad('S3')), bob)

  assert.equal(countFaucetClaims(now - 5000), 2)
  assert.equal(countFaucetClaims(now - 5000, { ip: '1.1.1.1' }), 1)
  assert.equal(takeRateToken('faucet:1.1.1.1', 5, 1 / 60, now), false, 'an empty bucket stays empty')

  // Plaintext gone, the rest renamed, and the import recorded once.
  assert.deepEqual(legacyPlaintextFiles(), [])
  assert.deepEqual(fs.readdirSync(data).filter((f) => f.endsWith('.json.imported')).sort(), [
    'faucet-claims.localnet.json.imported',
    'pending-redemptions.localnet.json.imported',
    'rate.localnet.json.imported',
  ])
  const report = JSON.parse(getMeta('legacy_json_import')!) as { files: { file: string; rows: number; skipped: number[] }[] }
  assert.deepEqual(
    report.files.map((f) => [f.file, f.rows, f.skipped.length]),
    [
      ['redemptions.localnet.json', 3, 0],
      ['pending-redemptions.localnet.json', 1, 0],
      ['faucet-claims.localnet.json', 2, 0],
      ['rate.localnet.json', 1, 0],
    ],
  )
})

test('an import retried after a crash (rows committed, file not renamed) does not count a faucet claim twice', () => {
  const data = path.join(root, 'data')
  const before = countFaucetClaims(0)
  assert.equal(before, 2)
  // As if the process died after the import transaction committed, before the rename and the marker.
  fs.copyFileSync(path.join(data, 'faucet-claims.localnet.json.imported'), path.join(data, 'faucet-claims.localnet.json'))
  db().prepare("DELETE FROM meta WHERE key = 'legacy_json_import'").run()
  closeDb()
  assert.equal(countFaucetClaims(0), before)
  assert.equal(countFaucetClaims(0, { wallet: 'F2' }), 1, 'a claim with no ip is matched too')
  assert.ok(getMeta('legacy_json_import'))
})
