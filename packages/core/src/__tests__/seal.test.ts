import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { openJson, parseShippingKey, sealJson, shippingKey } from '../seal'

const key = crypto.randomBytes(32)
const shipping = { name: 'Ada', email: 'ada@example.com', address: '12 Analytical St', country: 'UK' }

test('seal/open round trip; each seal uses a fresh IV', () => {
  const a = sealJson(shipping, 'redemption:S1', key)
  const b = sealJson(shipping, 'redemption:S1', key)
  assert.notEqual(a, b)
  assert.ok(!a.includes('Ada'))
  assert.deepEqual(openJson(a, 'redemption:S1', key), shipping)
})

test('wrong key, wrong row (AAD) and tampering all fail', () => {
  const sealed = sealJson(shipping, 'redemption:S1', key)
  assert.throws(() => openJson(sealed, 'redemption:S1', crypto.randomBytes(32)), /Cannot decrypt/)
  assert.throws(() => openJson(sealed, 'redemption:S2', key), /Cannot decrypt/)
  const [v, iv, tag, ct] = sealed.split('.')
  const flipped = Buffer.from(ct, 'base64url')
  flipped[0] ^= 1
  assert.throws(() => openJson([v, iv, tag, flipped.toString('base64url')].join('.'), 'redemption:S1', key), /Cannot decrypt/)
  assert.throws(() => openJson('garbage', 'redemption:S1', key), /Unreadable/)
})

test('SHIPPING_KEY accepts 32 bytes as hex or base64 and never echoes a bad value', () => {
  assert.ok(parseShippingKey(key.toString('hex')).equals(key))
  assert.ok(parseShippingKey(key.toString('base64')).equals(key))
  assert.throws(() => parseShippingKey('c2hvcnQ='), (e: Error) => /32 bytes, got 5/.test(e.message) && !e.message.includes('c2hvcnQ'))
  assert.ok(shippingKey({ NETWORK: 'mainnet', SHIPPING_KEY: key.toString('hex') }).equals(key))
})

test('mainnet requires SHIPPING_KEY; devnet and localnet fall back to distinct dev keys', () => {
  assert.throws(() => shippingKey({ NETWORK: 'mainnet' }), /SHIPPING_KEY must be set on mainnet/)
  const dev = shippingKey({ NETWORK: 'devnet' })
  const local = shippingKey({ NETWORK: 'localnet' })
  assert.equal(dev.length, 32)
  assert.ok(!dev.equals(local))
  assert.ok(dev.equals(shippingKey({ NETWORK: 'devnet' })), 'stable across restarts')
})
