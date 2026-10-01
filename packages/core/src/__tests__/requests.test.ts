import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import bs58 from 'bs58'
import { Keypair } from '@solana/web3.js'

// Point the repo root at a temp dir before anything writes data/.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-requests-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'localnet'

import { HttpError } from '../errors'
import { MAX_BODY_BYTES, clientIp, parseWith, readJsonBody, schemas, trustedProxyHops } from '../requests'
import { countFaucetClaims, recordFaucetClaim, removeFaucetClaim, takeRateToken } from '../store'

const post = (body: string | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost/api/x', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } })

const status = (e: unknown) => (e instanceof HttpError ? e.status : -1)
const wallet = Keypair.generate().publicKey.toBase58()
const pool = Keypair.generate().publicKey.toBase58()
const sig = bs58.encode(Buffer.alloc(64, 7))

test('readJsonBody parses JSON and rejects junk and oversized bodies', async () => {
  assert.deepEqual(await readJsonBody(post('{"a":1}')), { a: 1 })
  await assert.rejects(readJsonBody(post('{nope')), (e) => status(e) === 400 && /must be JSON/.test((e as Error).message))
  await assert.rejects(readJsonBody(post('')), (e) => status(e) === 400)
  assert.deepEqual(await readJsonBody(post(''), MAX_BODY_BYTES, { optional: true }), {})
  assert.deepEqual(await readJsonBody(post(null), MAX_BODY_BYTES, { optional: true }), {})
  // Counted on the stream, whatever Content-Length says (or when it is missing).
  const big = JSON.stringify({ description: 'x'.repeat(MAX_BODY_BYTES) })
  await assert.rejects(readJsonBody(post(big)), (e) => status(e) === 413)
  await assert.rejects(readJsonBody(post('{}', { 'content-length': String(10 * 1024 * 1024) })), (e) => status(e) === 413)
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(1024)))
      c.close()
    },
  })
  const streamed = new Request('http://localhost/api/x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
  await assert.rejects(readJsonBody(streamed), (e) => status(e) === 413)
})

test('parseWith turns schema failures into 400s with a readable message', () => {
  const bad = (schema: Parameters<typeof parseWith>[0], value: unknown, message: RegExp) =>
    assert.throws(() => parseWith(schema, value), (e) => status(e) === 400 && message.test((e as Error).message))

  const tx = parseWith(schemas.tx, { kind: 'buy', pool, wallet, usdc: 5, extra: 'dropped' })
  assert.equal(tx.wallet.toBase58(), wallet)
  assert.equal(tx.usdc, 5)
  assert.ok(!('extra' in tx))
  bad(schemas.tx, { kind: 'steal', pool, wallet }, /Unknown transaction kind/)
  bad(schemas.tx, { kind: 'buy', pool: 'x', wallet }, /pool is not a valid Solana address/)
  bad(schemas.tx, { kind: 'buy', pool, wallet: 'x' }, /wallet is not a valid Solana address/)
  bad(schemas.tx, { kind: 'buy', pool }, /wallet is missing/)
  for (const usdc of [0, -1, 'abc', null, 1e400, 2e9]) bad(schemas.tx, { kind: 'buy', pool, wallet, usdc }, /Enter an amount|too large/)
  bad(schemas.tx, { kind: 'buy', pool, wallet, usdc: 1, slippageBps: 1 }, /slippageBps must be from 10 to 500/)
  bad(schemas.tx, { kind: 'buy', pool, wallet, usdc: 1, slippageBps: 50.5 }, /whole number/)
  // A malformed referral is dropped, never an error.
  assert.equal(parseWith(schemas.tx, { kind: 'buy', pool, wallet, usdc: 1, ref: 42 }).ref, undefined)
  bad(schemas.tx, 'not an object', /Invalid input/)

  assert.equal(parseWith(schemas.quote, { pool, usdc: 1 }).side, 'buy')
  bad(schemas.quote, { pool, side: 'x', usdc: 1 }, /side must be buy or sell/)
  bad(schemas.resaleQuote, { pool, side: 'buy', amount: 0 }, /Enter an amount/)
  bad(schemas.confirmCampaign, { pool, signature: 'xyz' }, /not a valid transaction signature/)
  assert.equal(parseWith(schemas.migrate, {}).wallet, undefined)
  bad(schemas.faucet, { wallet: 'nope' }, /wallet is not a valid Solana address/)
  assert.equal(parseWith(schemas.preview, { campaign: {} }).maker, undefined)
  assert.equal(parseWith(schemas.createCampaign, { campaign: {}, maker: wallet, verifiedSocial: true }).maker.toBase58(), wallet)

  const shipping = { name: ' Ada ', address: '1 St', country: 'X' }
  const r = parseWith(schemas.redeemPrepare, { pool, wallet, shipping })
  assert.deepEqual(r.shipping, { name: 'Ada', email: '', address: '1 St', country: 'X' })
  bad(schemas.redeemPrepare, { pool, wallet, shipping: { name: 'a' } }, /Name, address and country are required/)
  bad(schemas.redeemPrepare, { pool, wallet, shipping: { ...shipping, address: 'x'.repeat(501) } }, /address is too long/)
  assert.equal(parseWith(schemas.redeemConfirm, { id: 'AbCd-_0123456789', signature: sig }).id, 'AbCd-_0123456789')
  bad(schemas.redeemConfirm, { id: '../../etc', signature: sig }, /not a redemption id/)
  bad(schemas.redeemConfirm, { id: 'AbCd-_0123456789', signature: 'x' }, /not a valid transaction signature/)
  bad(schemas.redeemPending, { pool, wallet: 'nope' }, /wallet is not a valid Solana address/)
  bad(schemas.redeemPrepare, { pool, wallet, shipping: { ...shipping, email: 'no' } }, /Enter a valid email/)
  const signedTx = Buffer.alloc(300, 1).toString('base64')
  assert.equal(parseWith(schemas.redeemSubmit, { pool, id: 'AbCd-_0123456789', tx: signedTx, shipping: { ...shipping, email: 'a@b.co' } }).tx, signedTx)
  bad(schemas.redeemSubmit, { pool, id: 'AbCd-_0123456789', tx: 'not base64!', shipping }, /tx is not base64/)
  bad(schemas.redeemSubmit, { pool, id: 'AbCd-_0123456789', tx: 'A'.repeat(1701), shipping }, /tx is too large/)
  bad(schemas.redeemSubmit, { pool, id: 'AbCd-_0123456789', shipping }, /tx is missing/)
  bad(schemas.ordersShipped, { pool, message: 'm', signature: 's' }, /signature is missing|Invalid input/)

  assert.equal(parseWith(schemas.blinkAmount, '25'), 25)
  bad(schemas.blinkAmount, 'abc', /Enter an amount/)
  bad(schemas.blinkAmount, '-5', /Enter an amount/)
})

test('clientIp takes the entry the trusted proxy appended, not what the client sent', () => {
  const h = (xff?: string) => new Headers(xff ? { 'x-forwarded-for': xff } : {})
  assert.equal(clientIp(h('9.9.9.9'), {}), '9.9.9.9')
  assert.equal(clientIp(h('6.6.6.6, 9.9.9.9'), {}), '9.9.9.9', 'a forged leftmost entry is ignored')
  assert.equal(clientIp(h('6.6.6.6, 9.9.9.9, 10.0.0.1'), { TRUSTED_PROXY_HOPS: '2' }), '9.9.9.9')
  assert.equal(clientIp(h('9.9.9.9'), { TRUSTED_PROXY_HOPS: '3' }), '9.9.9.9')
  assert.equal(clientIp(h('9.9.9.9'), { TRUSTED_PROXY_HOPS: '0' }), 'unknown')
  assert.equal(clientIp(h(), {}), 'unknown')
})

test('an invalid TRUSTED_PROXY_HOPS is an error, not one shared bucket', () => {
  assert.equal(trustedProxyHops({}), 1)
  assert.equal(trustedProxyHops({ TRUSTED_PROXY_HOPS: ' 2 ' }), 2)
  for (const bad of ['one', '1.5', '-1', '1e400']) {
    assert.throws(() => trustedProxyHops({ TRUSTED_PROXY_HOPS: bad }), /TRUSTED_PROXY_HOPS must be a whole number/, bad)
    assert.throws(() => clientIp(new Headers({ 'x-forwarded-for': '9.9.9.9' }), { TRUSTED_PROXY_HOPS: bad }), /TRUSTED_PROXY_HOPS/)
  }
})

test('rate tokens: a bucket empties and refills, per key', () => {
  const t0 = 1_000_000
  assert.equal(takeRateToken('ip:1', 2, 1, t0), true)
  assert.equal(takeRateToken('ip:1', 2, 1, t0), true)
  assert.equal(takeRateToken('ip:1', 2, 1, t0), false)
  assert.equal(takeRateToken('ip:2', 2, 1, t0), true, 'buckets are per key')
  assert.equal(takeRateToken('ip:1', 2, 1, t0 + 1000), true, 'one token back after a second')
  assert.equal(takeRateToken('ip:1', 2, 1, t0 + 1000), false)
  assert.equal(takeRateToken('__proto__', 1, 1, t0), true)
  assert.equal(takeRateToken('__proto__', 1, 1, t0), false)
})

const rateFile = () => path.join(root, 'data', 'rate.localnet.json')

test('rate tokens: a bucket is dropped once it would be full again, and writes leave no temp file', () => {
  const t0 = 2_000_000
  takeRateToken('keep', 10, 1, t0) // full again at t0 + 1 s
  takeRateToken('slow', 10, 1 / 60, t0) // full again at t0 + 60 s
  takeRateToken('other', 10, 1, t0 + 1500)
  const keys = Object.keys(JSON.parse(fs.readFileSync(rateFile(), 'utf8')))
  assert.ok(!keys.includes('keep') && keys.includes('slow') && keys.includes('other'), keys.join(','))
  assert.deepEqual(fs.readdirSync(path.dirname(rateFile())).filter((f) => f.endsWith('.tmp')), [])
})

test('rate tokens fail open on an unreadable file instead of failing every request', () => {
  fs.writeFileSync(rateFile(), '{"ip:9": {"tokens": 0.') // cut short mid-write
  assert.equal(takeRateToken('ip:9', 1, 1, 3_000_000), true)
  assert.equal(takeRateToken('ip:9', 1, 1, 3_000_000), false, 'and the next write repairs the file')
})

test('faucet claims are counted per wallet, per IP and in total', () => {
  const t0 = Date.now()
  recordFaucetClaim('W1', '1.1.1.1', t0)
  recordFaucetClaim('W2', '1.1.1.1', t0 + 10)
  recordFaucetClaim('W1', '2.2.2.2', t0 - 100)
  assert.equal(countFaucetClaims(t0, { wallet: 'W1' }), 1)
  assert.equal(countFaucetClaims(t0 - 100, { wallet: 'W1' }), 2)
  assert.equal(countFaucetClaims(t0, { ip: '1.1.1.1' }), 2)
  assert.equal(countFaucetClaims(t0 - 100), 3)
  removeFaucetClaim('W2', t0 + 10)
  assert.equal(countFaucetClaims(t0, { ip: '1.1.1.1' }), 1, 'a claim whose transfer never ran is taken back')
  removeFaucetClaim('W2', t0 + 10)
  assert.equal(countFaucetClaims(t0 - 100), 2)
})
