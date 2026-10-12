import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import nacl from 'tweetnacl'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-inbox-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'localnet'
delete process.env.DATA_DIR
delete process.env.SHIPPING_KEY
delete process.env.SHIPPING_ENCRYPTION_KEY

import {
  INBOX_KEY_PATTERN,
  SEALED_PREFIX,
  checkShipping,
  encodeInboxKey,
  inboxKeyPair,
  inboxMessage,
  isSealedToMaker,
  openFromBackers,
  sealToMaker,
} from '../inbox-crypto'
import { getInboxKey, registerInboxKey, shippingFor } from '../inbox'
import { listRedemptions, saveRedemption } from '../redemptions'

const ada = { name: 'Ada', email: 'ada@example.com', address: '12 Analytical Way\nLondon', country: 'UK' }
const signatureOf = () => nacl.randomBytes(64) // stands in for a wallet's (deterministic) ed25519 signature
const sig = signatureOf()
const pair = inboxKeyPair(sig)
const key = encodeInboxKey(pair.publicKey)

test('the inbox key comes from the signature: same signature, same key; another signature, another key', () => {
  assert.equal(encodeInboxKey(inboxKeyPair(sig).publicKey), key)
  assert.notEqual(encodeInboxKey(inboxKeyPair(signatureOf()).publicKey), key)
  assert.match(key, INBOX_KEY_PATTERN)
})

test('the signed message names the campaign and the site', () => {
  assert.notEqual(inboxMessage('POOL1', 'a.example'), inboxMessage('POOL2', 'a.example'))
  assert.notEqual(inboxMessage('POOL1', 'a.example'), inboxMessage('POOL1', 'b.example'))
})

test('details sealed to the maker open for the maker only, and are not readable as stored', () => {
  const sealed = sealToMaker(ada, key)
  assert.ok(sealed.startsWith(SEALED_PREFIX))
  assert.ok(!sealed.includes('Ada') && !Buffer.from(sealed.slice(5), 'base64url').toString('latin1').includes('Analytical'))
  assert.deepEqual(openFromBackers(sealed, pair.secretKey), ada)
  assert.throws(() => openFromBackers(sealed, inboxKeyPair(signatureOf()).secretKey), /another key/)
  assert.notEqual(sealToMaker(ada, key), sealed, 'a fresh ephemeral key and nonce every time')
})

test('tampering with a sealed order is detected', () => {
  const sealed = sealToMaker(ada, key)
  const bytes = Buffer.from(sealed.slice(5), 'base64url')
  bytes[bytes.length - 1] ^= 1
  assert.throws(() => openFromBackers(SEALED_PREFIX + bytes.toString('base64url'), pair.secretKey), /another key/)
})

test('sealToMaker refuses a malformed key', () => {
  assert.throws(() => sealToMaker(ada, 'short'), /not valid/)
})

test('isSealedToMaker is a shape check the server can run without the key', () => {
  assert.ok(isSealedToMaker(sealToMaker(ada, key)))
  assert.ok(!isSealedToMaker('v1.abc.def.ghi'), 'a server-sealed value is not a sealed order')
  assert.ok(!isSealedToMaker(SEALED_PREFIX + 'abc'), 'too short to hold a box')
  assert.ok(!isSealedToMaker(SEALED_PREFIX + 'A'.repeat(3000)), 'too long')
  assert.ok(!isSealedToMaker(SEALED_PREFIX + '!!!!'.repeat(40)), 'not base64url')
  assert.ok(!isSealedToMaker(undefined))
})

test('checkShipping applies the server schema rules in the browser', () => {
  assert.equal(checkShipping(ada), null)
  assert.match(checkShipping({ ...ada, name: ' ' })!, /required/)
  assert.match(checkShipping({ ...ada, address: 'x'.repeat(501) })!, /address is too long/)
  assert.match(checkShipping({ ...ada, email: 'no' })!, /valid email/)
  assert.equal(checkShipping({ ...ada, email: '' }), null)
})

test('an inbox key is set once per campaign', () => {
  assert.equal(getInboxKey('P1'), null)
  registerInboxKey('P1', key)
  assert.equal(getInboxKey('P1'), key)
  assert.doesNotThrow(() => registerInboxKey('P1', key), 'the same key again is fine')
  assert.throws(() => registerInboxKey('P1', encodeInboxKey(inboxKeyPair(signatureOf()).publicKey)), /can’t be changed/)
  assert.throws(() => registerInboxKey('P2', 'not-a-key'), /not a valid inbox key/)
})

test('shippingFor: plain details without an inbox key, sealed ones with it, never the wrong kind', () => {
  // Campaign with no key
  assert.deepEqual(shippingFor('NOKEY', { shipping: ada }), ada)
  assert.throws(() => shippingFor('NOKEY', {}), /required/)
  assert.throws(() => shippingFor('NOKEY', { sealed: sealToMaker(ada, key) }), /no inbox key yet/)
  // Campaign with a key: the server must not be handed plaintext
  registerInboxKey('KEYED', key)
  const sealed = sealToMaker(ada, key)
  assert.equal(shippingFor('KEYED', { sealed }), sealed)
  assert.throws(() => shippingFor('KEYED', { shipping: ada }), /privately/)
  assert.throws(() => shippingFor('KEYED', { sealed: 'e2e1.abc' }), /not sealed/)
  assert.throws(() => shippingFor('KEYED', {}), /not sealed/)
})

test('the orders list hands sealed details to the maker as they are and never opens them', () => {
  const sealed = sealToMaker(ada, key)
  saveRedemption({ id: 'AAAAAAAAAAAAAAAA', pool: 'KEYED', signature: 'SIGSEALED', wallet: 'W', units: 1, shipping: sealed, createdAt: new Date().toISOString() })
  const [order] = listRedemptions('KEYED')
  assert.equal(order.shipping, null)
  assert.equal(order.sealed, sealed)
  assert.deepEqual(openFromBackers(order.sealed!, pair.secretKey), ada)
})
