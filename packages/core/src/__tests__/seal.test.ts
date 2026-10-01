import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { openJson, openJsonAny, parseShippingKey, sealJson, shippingKey, shippingKeys, shippingKeyStatus } from '../seal'

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

test('shippingKeyStatus: a malformed key or a missing mainnet key is unusable (health fails)', () => {
  assert.deepEqual(shippingKeyStatus({ NETWORK: 'devnet', SHIPPING_KEY: key.toString('hex') }), { ok: true, configured: true, usable: true })
  const bad = shippingKeyStatus({ NETWORK: 'devnet', SHIPPING_KEY: `${key.toString('hex')}x` })
  assert.equal(bad.usable, false)
  assert.equal(bad.ok, false)
  assert.match(bad.error!, /32 bytes/)
  assert.equal(shippingKeyStatus({ NETWORK: 'mainnet' }).usable, false)
  assert.equal(shippingKeyStatus({ NETWORK: 'localnet', SHIPPING_KEY: 'short' }).usable, false)
})

test('shippingKeyStatus: the public dev key is not ok on a deployed devnet, fine locally', () => {
  assert.deepEqual(shippingKeyStatus({ NETWORK: 'devnet' }), { ok: true, configured: false, usable: true })
  assert.deepEqual(shippingKeyStatus({ NETWORK: 'localnet', PUBLIC_BASE_URL: 'https://x.test' }), { ok: true, configured: false, usable: true })
  const deployed = shippingKeyStatus({ NETWORK: 'devnet', RAILWAY_PUBLIC_DOMAIN: 'x.up.railway.app' })
  assert.equal(deployed.ok, false)
  assert.equal(deployed.usable, true, 'still serves')
  const prev = shippingKeyStatus({ NETWORK: 'devnet', SHIPPING_KEY: key.toString('hex'), SHIPPING_KEY_PREVIOUS: 'c2hvcnQ=' })
  assert.equal(prev.ok, false)
  assert.equal(prev.usable, true)
  assert.match(prev.error!, /SHIPPING_KEY_PREVIOUS/)
})

test('shippingKeys: current, previous, then the dev key off mainnet; openJsonAny takes the first that fits', () => {
  const old = crypto.randomBytes(32)
  const keys = shippingKeys({ NETWORK: 'devnet', SHIPPING_KEY: key.toString('hex'), SHIPPING_KEY_PREVIOUS: ` ${old.toString('base64')} ,bad` })
  assert.equal(keys.length, 3)
  assert.ok(keys[0].equals(key) && keys[1].equals(old) && keys[2].equals(shippingKey({ NETWORK: 'devnet' })))
  assert.equal(shippingKeys({ NETWORK: 'mainnet', SHIPPING_KEY: key.toString('hex') }).length, 1)
  assert.equal(shippingKeys({ NETWORK: 'devnet' }).length, 1, 'no duplicate dev key')
  assert.deepEqual(openJsonAny(sealJson(shipping, 'a', old), 'a', keys), shipping)
  assert.throws(() => openJsonAny(sealJson(shipping, 'a', crypto.randomBytes(32)), 'a', keys), /Cannot decrypt/)
  assert.throws(() => openJsonAny(sealJson(shipping, 'a', key), 'a', []), /No SHIPPING_KEY/)
})
