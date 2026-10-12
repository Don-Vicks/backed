import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { Keypair } from '@solana/web3.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-session-'))
fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), '')
process.env.PREORDER_ROOT = root
process.env.NETWORK = 'localnet'
delete process.env.DATA_DIR

import {
  MAKER_SESSION_TTL_MS,
  MAX_SIGN_IN_NONCES,
  SIGN_IN_NONCE_TTL_MS,
  bearerToken,
  endMakerSession,
  issueSignInNonce,
  maker as makerForSession,
  startMakerSession,
} from '../maker-session'
import { ordersMessage } from '../messages'
import { db } from '../db'

const DOMAIN = 'backed.example'
const POOL = 'POOLPOOLPOOLPOOLPOOLPOOLPOOLPOOLPOOL1'
const kp = Keypair.generate()
const sign = (msg: string, k = kp) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(msg), k.secretKey))
const input = (message: string, k = kp) => ({ pool: POOL, maker: kp.publicKey.toBase58(), domain: DOMAIN, message, signature: sign(message, k) })
const signedFor = (nonce: string, now = Date.now()) => ordersMessage(POOL, new Date(now).toISOString(), DOMAIN, nonce)
const clear = () => {
  db().exec('DELETE FROM signin_nonces; DELETE FROM maker_sessions')
}

test('sign-in: a signed nonce buys a session that names the maker and this campaign only', () => {
  clear()
  const { nonce } = issueSignInNonce(POOL)
  const { token, expiresAt } = startMakerSession(input(signedFor(nonce)))
  assert.ok(expiresAt > Date.now())
  assert.equal(makerForSession(POOL, token), kp.publicKey.toBase58())
  assert.throws(() => makerForSession('OTHERPOOL', token), /expired|sign in/i, 'a session is for one campaign')
  assert.throws(() => makerForSession(POOL, 'x'.repeat(43)), /sign in again/)
  assert.throws(() => makerForSession(POOL, null), /Sign in/)
})

test('sign-in: a nonce works once, so a leaked signature cannot be replayed', () => {
  clear()
  const { nonce } = issueSignInNonce(POOL)
  const body = input(signedFor(nonce))
  startMakerSession(body)
  assert.throws(() => startMakerSession(body), /already used or has expired/)
})

test('sign-in: a nonce is spent by a valid signature only', () => {
  clear()
  const { nonce } = issueSignInNonce(POOL)
  const stranger = Keypair.generate()
  assert.throws(() => startMakerSession(input(signedFor(nonce), stranger)), /does not match/)
  assert.doesNotThrow(() => startMakerSession(input(signedFor(nonce))), 'the maker can still use it after a stranger failed')
})

test('sign-in: unknown, expired and other-campaign nonces are refused', () => {
  clear()
  assert.throws(() => startMakerSession(input(signedFor('never-issued-nonce-1'))), /already used or has expired/)
  assert.throws(() => startMakerSession(input(signedFor('x'))), /not for this page/, 'a malformed nonce')
  const old = issueSignInNonce(POOL, Date.now() - SIGN_IN_NONCE_TTL_MS - 1_000)
  assert.throws(() => startMakerSession(input(signedFor(old.nonce))), /already used or has expired/)
  const other = issueSignInNonce('ANOTHERPOOL')
  assert.throws(() => startMakerSession(input(signedFor(other.nonce))), /already used or has expired/, 'issued for another campaign')
})

test('sessions expire and can be ended', () => {
  clear()
  const now = Date.now()
  const { nonce } = issueSignInNonce(POOL, now)
  const { token } = startMakerSession(input(signedFor(nonce, now)), now)
  assert.doesNotThrow(() => makerForSession(POOL, token, now + MAKER_SESSION_TTL_MS - 1_000))
  assert.throws(() => makerForSession(POOL, token, now + MAKER_SESSION_TTL_MS + 1_000), /expired/)
  endMakerSession(token)
  assert.throws(() => makerForSession(POOL, token, now), /sign in again/)
})

test('only a hash of the session token is stored', () => {
  clear()
  const { nonce } = issueSignInNonce(POOL)
  const { token } = startMakerSession(input(signedFor(nonce)))
  const rows = db().prepare('SELECT token_hash FROM maker_sessions').all() as { token_hash: string }[]
  assert.equal(rows.length, 1)
  assert.notEqual(rows[0].token_hash, token)
  assert.ok(!JSON.stringify(rows).includes(token))
})

test('unspent nonces are capped, and expired ones make room', () => {
  clear()
  const now = Date.now()
  const stmt = db().prepare('INSERT INTO signin_nonces (nonce, pool, created_at) VALUES (?, ?, ?)')
  db().exec('BEGIN')
  for (let i = 0; i < MAX_SIGN_IN_NONCES; i++) stmt.run(`filler-${i}`, POOL, now)
  db().exec('COMMIT')
  assert.throws(() => issueSignInNonce(POOL, now), /busy/)
  assert.doesNotThrow(() => issueSignInNonce(POOL, now + SIGN_IN_NONCE_TTL_MS + 1_000), 'old nonces are dropped first')
})

test('bearerToken reads only a well-formed Authorization header', () => {
  const t = 'A'.repeat(43)
  assert.equal(bearerToken(`Bearer ${t}`), t)
  assert.equal(bearerToken(null), null)
  assert.equal(bearerToken(`Basic ${t}`), null)
  assert.equal(bearerToken(`Bearer ${t} extra`), null)
  assert.equal(bearerToken('Bearer short'), null)
})
