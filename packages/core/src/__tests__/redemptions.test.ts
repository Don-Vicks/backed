import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'

// Point the repo root at a temp dir before anything writes data/ or keys/.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-redemptions-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'localnet'
delete process.env.DATA_DIR
delete process.env.SHIPPING_KEY
delete process.env.SHIPPING_ENCRYPTION_KEY
delete process.env.SHIPPING_KEY_PREVIOUS

import {
  MAX_PENDING_REDEMPTIONS,
  checkSignedRedeemTx,
  PENDING_REDEMPTION_RETENTION_MS,
  countPendingRedemptions,
  getPendingRedemption,
  listPendingRedemptions,
  listRedemptions,
  markRedemptionShipped,
  newRedemptionId,
  ordersMessage,
  removePendingRedemption,
  saveRedemption,
  savePendingRedemption,
  sealShipping,
  verifyWalletMessage,
  type PendingRedemption,
} from '../redemptions'
import { db, dbPath, redemptionAad, transaction } from '../db'
import { openJson, shippingKey, shippingKeyStatus } from '../seal'
import { MEMO_PROGRAM_ID, REDEEM_MEMO_PREFIX, buildRedeemTx } from '../chain'

const sign = (kp: Keypair, msg: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey))
const DOMAIN = 'backed.example'
const NONCE = 'nonce-nonce-nonce-1'
const expected = (at: string) => ordersMessage('POOL', at, DOMAIN, NONCE)
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

test('maker sign-in: a fresh message for this site and pool passes', () => {
  const kp = Keypair.generate()
  const msg = expected(iso(0))
  assert.doesNotThrow(() => verifyWalletMessage(msg, sign(kp, msg), kp.publicKey, expected))
  assert.match(msg, /^backed\.example asks you to sign in to /)
})

test('maker sign-in: another wallet or a malformed signature is rejected', () => {
  const kp = Keypair.generate()
  const msg = expected(iso(0))
  assert.throws(() => verifyWalletMessage(msg, sign(kp, msg), Keypair.generate().publicKey, expected), /does not match/)
  assert.throws(() => verifyWalletMessage(msg, 'not-base58-0OIl', kp.publicKey, expected), /does not match/)
  assert.throws(() => verifyWalletMessage(msg, bs58.encode(Buffer.alloc(10)), kp.publicKey, expected), /does not match/)
})

test('maker sign-in: stale, future and undated messages are rejected', () => {
  const kp = Keypair.generate()
  const check = (msg: string) => () => verifyWalletMessage(msg, sign(kp, msg), kp.publicKey, expected)
  assert.throws(check(expected(iso(-6 * 60_000))), /expired/)
  assert.throws(check(expected(iso(9 * 60_000))), /future/, 'a message dated ahead (to replay later) is refused')
  assert.doesNotThrow(check(expected(iso(20_000))), 'a little clock skew is fine')
  assert.throws(check(expected('not a date')), /no valid date/)
  assert.throws(check(expected('NaN')), /no valid date/)
})

test('maker sign-in: only the exact message counts, not one that contains it', () => {
  const kp = Keypair.generate()
  const at = iso(0)
  const check = (msg: string) => () => verifyWalletMessage(msg, sign(kp, msg), kp.publicKey, expected)
  // The old check: any text that mentions the pool and ends with a date.
  assert.throws(check(`Sign up for our airdrop! POOL\nIssued at: ${at}`), /not for this page/)
  assert.throws(check(`Hello\n${expected(at)}`), /not for this page/)
  assert.throws(check(ordersMessage('POOL', at, 'evil.example', NONCE)), /not for this page/, 'signed for another site')
  assert.throws(check(ordersMessage('OTHER', at, DOMAIN, NONCE)), /not for this page/, 'signed for another campaign')
  assert.throws(check(`${expected(at)}\n`), /not for this page/)
})

test('shipping is sealed at rest and only opens for its burn signature', () => {
  const shipping = { name: 'Ada', email: 'ada@example.com', address: '12 Analytical Way', country: 'UK' }
  const sealed = sealShipping(shipping, 'SIG')
  assert.match(sealed, /^v1\./)
  assert.ok(!sealed.includes('Ada'), 'no plaintext at rest')
  assert.deepEqual(openJson(sealed, redemptionAad('SIG')), shipping)
  assert.throws(() => openJson(sealed, redemptionAad('OTHER')), /Cannot decrypt/, 'bound to the burn')
  const [v, iv, tag, ct] = sealed.split('.')
  assert.throws(() => openJson([v, iv, tag, Buffer.from('x').toString('base64url')].join('.'), redemptionAad('SIG')), /Cannot decrypt/, 'tampering is detected')
  // Localnet without a key uses a stable dev key; nothing is written next to the data.
  assert.ok(shippingKey().equals(shippingKey()))
  assert.ok(!fs.existsSync(path.join(root, 'keys', 'localnet', 'shipping-key')))
})

test('SHIPPING_ENCRYPTION_KEY is an alias of SHIPPING_KEY; required on mainnet and a deployed devnet', () => {
  const hex = 'ab'.repeat(32)
  const b64 = Buffer.alloc(32, 7).toString('base64')
  assert.ok(shippingKey({ NETWORK: 'mainnet', SHIPPING_ENCRYPTION_KEY: hex }).equals(Buffer.from(hex, 'hex')))
  assert.ok(shippingKey({ NETWORK: 'devnet', SHIPPING_ENCRYPTION_KEY: b64 }).equals(Buffer.from(b64, 'base64')))
  assert.ok(shippingKey({ NETWORK: 'devnet', SHIPPING_KEY: b64, SHIPPING_ENCRYPTION_KEY: hex }).equals(Buffer.from(b64, 'base64')), 'SHIPPING_KEY wins')
  assert.equal(shippingKeyStatus({ NETWORK: 'devnet', SHIPPING_ENCRYPTION_KEY: 'short' }).usable, false)
  assert.match(shippingKeyStatus({ NETWORK: 'devnet', SHIPPING_ENCRYPTION_KEY: 'short' }).error!, /32 bytes/)
  assert.deepEqual(shippingKeyStatus({ NETWORK: 'mainnet', SHIPPING_ENCRYPTION_KEY: hex }), { ok: true, configured: true, usable: true })
  assert.equal(shippingKeyStatus({ NETWORK: 'mainnet' }).usable, false)
  assert.match(shippingKeyStatus({ NETWORK: 'mainnet' }).error!, /must be set on mainnet/)
  const deployed = shippingKeyStatus({ NETWORK: 'devnet', PUBLIC_BASE_URL: 'https://backed.example' })
  assert.equal(deployed.usable, false, 'a deployed devnet keeps real addresses off the public dev key')
  assert.match(deployed.error!, /must be set on a deployed devnet/)
  assert.equal(shippingKeyStatus({ NETWORK: 'localnet' }).usable, true)
  const sealed = sealShipping({ name: 'a', email: '', address: 'b', country: 'c' }, 'S', Buffer.from(hex, 'hex'))
  assert.throws(() => openJson(sealed, redemptionAad('S'), Buffer.alloc(32)), /Cannot decrypt/, 'another key cannot open it')
})

const pending = (over: Partial<PendingRedemption> = {}): PendingRedemption => {
  const signature = over.signature ?? `SIG-${newRedemptionId()}`
  return {
    id: newRedemptionId(),
    pool: 'POOL',
    wallet: 'WALLET',
    units: 1,
    shipping: sealShipping({ name: 'Ada', email: '', address: '1 St', country: 'X' }, signature),
    createdAt: new Date().toISOString(),
    signature,
    lastValidBlockHeight: 100,
    ...over,
  }
}

test('pending redemptions: save, find, count, remove; old ones expire', () => {
  const now = Date.now()
  const old = pending({ createdAt: new Date(now - PENDING_REDEMPTION_RETENTION_MS - 1000).toISOString() })
  savePendingRedemption(old, now - PENDING_REDEMPTION_RETENTION_MS - 1000)
  const a = pending()
  const b = pending({ wallet: 'OTHER' })
  savePendingRedemption(a, now)
  savePendingRedemption(b, now)
  assert.equal(getPendingRedemption(old.id), undefined, 'pruned on the next write')
  assert.deepEqual(getPendingRedemption(a.id), a, 'round trip')
  assert.deepEqual(listPendingRedemptions('POOL', 'WALLET').map((p) => p.id), [a.id])
  assert.equal(countPendingRedemptions('POOL', 'WALLET'), 1)
  assert.equal(countPendingRedemptions('POOL', 'NOBODY'), 0)
  removePendingRedemption(a.id)
  assert.equal(getPendingRedemption(a.id), undefined)
  assert.ok(getPendingRedemption(b.id))
  assert.match(a.id, /^[A-Za-z0-9_-]{16}$/)
  removePendingRedemption(b.id)
})

test('a full pending table refuses new rows and keeps every existing one', () => {
  const rowsOf = () => db().prepare('SELECT id FROM pending_redemptions ORDER BY id').all().map((r) => (r as { id: string }).id)
  const insert = (p: PendingRedemption) =>
    db()
      .prepare('INSERT INTO pending_redemptions (id, pool, wallet, units, signature, created_at, last_valid_block_height, shipping_ct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.id, p.pool, p.wallet, p.units, p.signature, Date.parse(p.createdAt), p.lastValidBlockHeight, p.shipping)
  // The oldest row is someone's landed burn whose confirm was lost: a flood must not push it out.
  const burned = pending({ wallet: 'VICTIM', createdAt: new Date(Date.now() - 29 * 24 * 60 * 60_000).toISOString() })
  const sealed = pending().shipping
  const filler = Array.from({ length: MAX_PENDING_REDEMPTIONS - 1 }, (_, i) => ({ ...pending({ shipping: sealed }), id: `fill${String(i).padStart(12, '0')}`, signature: `fill-${i}` }))
  transaction(() => [...filler, burned].forEach(insert))
  const before = rowsOf()
  assert.throws(() => savePendingRedemption(pending()), (e: any) => e.status === 429 && /busy/.test(e.message))
  assert.deepEqual(rowsOf(), before, 'nothing dropped, nothing added')
  assert.equal(getPendingRedemption(burned.id)?.wallet, 'VICTIM')
  // Rows past the retention make room again.
  db().prepare('UPDATE pending_redemptions SET created_at = ? WHERE id LIKE ?').run(Date.now() - PENDING_REDEMPTION_RETENTION_MS - 1000, 'fill%')
  const fresh = pending()
  savePendingRedemption(fresh)
  assert.deepEqual(rowsOf().sort(), [fresh.id, burned.id].sort())
  db().prepare('DELETE FROM pending_redemptions').run()
})

test('orders: one per burn and per id; mark shipped deletes the shipping details; listing opens the rest', () => {
  const sealed = sealShipping({ name: 'Ada', email: '', address: '1 St', country: 'X' }, 'sig1')
  saveRedemption({ id: 'r1', pool: 'SHIPPOOL', signature: 'sig1', wallet: 'W1', units: 1, shipping: sealed, createdAt: new Date().toISOString() })
  assert.throws(() => saveRedemption({ id: 'r2', pool: 'SHIPPOOL', signature: 'sig1', wallet: 'W1', units: 1, shipping: sealed, createdAt: '' }), /already submitted/)
  assert.throws(() => saveRedemption({ id: 'r1', pool: 'SHIPPOOL', signature: 'sig9', wallet: 'W1', units: 1, shipping: sealed, createdAt: '' }), /already submitted/)
  // An order saved with plain details (sealed on save), and one sealed under another key.
  saveRedemption({ pool: 'SHIPPOOL', signature: 'sig2', wallet: 'W2', units: 2, shipping: { name: 'Old', email: '', address: 'a', country: 'b' }, createdAt: '' })
  const otherKey = sealShipping({ name: 'x', email: '', address: 'y', country: 'z' }, 'sig3', Buffer.alloc(32))
  saveRedemption({ id: 'r3', pool: 'SHIPPOOL', signature: 'sig3', wallet: 'W3', units: 1, shipping: otherKey, createdAt: '' })

  const stored = (sig: string) => (db().prepare('SELECT shipping_ct FROM redemptions WHERE signature = ?').get(sig) as { shipping_ct: string | null }).shipping_ct
  assert.ok(stored('sig2')!.startsWith('v1.') && !stored('sig2')!.includes('Old'), 'plain details are sealed on save')

  const views = listRedemptions('SHIPPOOL')
  assert.equal(views.find((v) => v.signature === 'sig1')?.shipping?.name, 'Ada')
  assert.equal(views.find((v) => v.signature === 'sig1')?.id, 'r1')
  assert.equal(views.find((v) => v.signature === 'sig2')?.shipping?.name, 'Old')
  const broken = views.find((v) => v.signature === 'sig3')
  assert.equal(broken?.shipping, null)
  assert.equal(broken?.unreadable, true)

  assert.equal(markRedemptionShipped('SHIPPOOL', 'sig1'), true)
  assert.equal(markRedemptionShipped('OTHERPOOL', 'sig2'), false, 'only the campaign’s own orders')
  const shipped = listRedemptions('SHIPPOOL').find((r) => r.signature === 'sig1')!
  assert.equal(shipped.shipping, null)
  assert.ok(shipped.shippedAt)
  assert.equal(shipped.unreadable, undefined)
  assert.equal(stored('sig1'), null, 'the sealed details are gone from the store')
  assert.ok(fs.existsSync(dbPath()))
})

test('the redeem transaction burns whole units and carries the owner-signed memo', () => {
  const owner = Keypair.generate().publicKey
  const mint = Keypair.generate().publicKey
  const tx = buildRedeemTx(owner, mint, 'AbCd-_0123456789', 2)
  assert.equal(tx.instructions.length, 2)
  assert.equal(tx.instructions[0].data.readBigUInt64LE(1), BigInt(2_000_000))
  const memo = tx.instructions[1]
  assert.ok(memo.programId.equals(MEMO_PROGRAM_ID))
  assert.equal(memo.data.toString('utf8'), `${REDEEM_MEMO_PREFIX}AbCd-_0123456789`)
  assert.deepEqual(memo.keys, [{ pubkey: owner, isSigner: true, isWritable: false }])
})

test('a signed burn counts only as built for its wallet and id, signed by that wallet alone', () => {
  const owner = Keypair.generate()
  const record = { baseMint: Keypair.generate().publicKey.toBase58() } as Parameters<typeof checkSignedRedeemTx>[0]
  const id = 'AbCd-_0123456789'
  const blockhash = Keypair.generate().publicKey.toBase58()
  const signed = (tx: Transaction, payer = owner, ...more: Keypair[]) => {
    tx.feePayer = payer.publicKey
    tx.recentBlockhash = blockhash
    tx.sign(payer, ...more)
    return Transaction.from(tx.serialize({ requireAllSignatures: false })) // as the server receives it
  }
  const built = () => buildRedeemTx(owner.publicKey, new PublicKey(record.baseMint), id)
  const fee = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })

  assert.ok(checkSignedRedeemTx(record, signed(built()), id).equals(owner.publicKey))
  assert.ok(checkSignedRedeemTx(record, signed(new Transaction().add(fee, ...built().instructions)), id), 'a priority fee is fine')
  assert.throws(() => checkSignedRedeemTx(record, signed(built()), 'ZZZZ-_0123456789'), /not the redemption transaction/, 'another id')
  const unsigned = built()
  unsigned.feePayer = owner.publicKey
  unsigned.recentBlockhash = blockhash
  assert.throws(() => checkSignedRedeemTx(record, Transaction.from(unsigned.serialize({ requireAllSignatures: false })), id), /not signed by its wallet/)
  // Someone else's key cannot sign it: the burn and memo need the owner, so a forger signs as payer only.
  const forger = Keypair.generate()
  const forged = built()
  forged.feePayer = forger.publicKey
  forged.recentBlockhash = blockhash
  forged.partialSign(forger)
  assert.throws(() => checkSignedRedeemTx(record, Transaction.from(forged.serialize({ requireAllSignatures: false })), id), /not signed by its wallet/)
  // A tampered signature.
  const tampered = signed(built())
  tampered.signatures[0].signature![0] ^= 1
  assert.throws(() => checkSignedRedeemTx(record, tampered, id), /not signed by its wallet/)
  // Two units, an extra instruction, or a co-signer: not the burn that was built.
  assert.throws(() => checkSignedRedeemTx(record, signed(buildRedeemTx(owner.publicKey, new PublicKey(record.baseMint), id, 2)), id), /not the redemption transaction/)
  const extra = new Transaction().add(...built().instructions, SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: forger.publicKey, lamports: 1 }))
  assert.throws(() => checkSignedRedeemTx(record, signed(extra), id), /not the redemption transaction/)
  const cosigner = Keypair.generate()
  const cosigned = new Transaction().add(...built().instructions, SystemProgram.transfer({ fromPubkey: cosigner.publicKey, toPubkey: owner.publicKey, lamports: 1 }))
  assert.throws(() => checkSignedRedeemTx(record, signed(cosigned, owner, cosigner), id), /not signed by its wallet/)
})
