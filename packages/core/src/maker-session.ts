// The maker's sign-in to the orders page. The server issues a single-use nonce for a campaign, the
// maker's wallet signs ordersMessage() with it, and the signature buys a short session. A signature
// that leaks (a screen share, a log, a compromised page) works once at most, and only before its nonce
// expires; the session token is random, kept hashed, and sent as a bearer header, never a cookie.
import crypto from 'crypto'
import { PublicKey } from '@solana/web3.js'
import { db, transaction } from './db'
import { HttpError } from './errors'
import { ordersMessage } from './messages'
import { verifyWalletMessage } from './redemptions'

export const SIGN_IN_NONCE_TTL_MS = 5 * 60_000
export const MAKER_SESSION_TTL_MS = 30 * 60_000
// Unspent nonces and live sessions are capped, like the other tables an anonymous caller can grow.
export const MAX_SIGN_IN_NONCES = 5000
export const MAX_MAKER_SESSIONS = 1000

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')
const NONCE_LINE = /\nNonce: ([A-Za-z0-9_-]{16,64})\nIssued at: /

// A fresh nonce for signing in to one campaign's orders. Needs no proof of anything, so callers
// rate-limit it.
export function issueSignInNonce(pool: string, now = Date.now()): { nonce: string; expiresAt: number } {
  const nonce = crypto.randomBytes(16).toString('base64url')
  transaction((d) => {
    d.prepare('DELETE FROM signin_nonces WHERE created_at < ?').run(now - SIGN_IN_NONCE_TTL_MS)
    const { n } = d.prepare('SELECT COUNT(*) AS n FROM signin_nonces').get() as { n: number }
    if (n >= MAX_SIGN_IN_NONCES) throw new HttpError('Sign-in is busy right now. Try again in a few minutes.', 429)
    d.prepare('INSERT INTO signin_nonces (nonce, pool, created_at) VALUES (?, ?, ?)').run(nonce, pool, now)
  })
  return { nonce, expiresAt: now + SIGN_IN_NONCE_TTL_MS }
}

// Checks the signed message (this site, this campaign, the maker's signature, dated recently), spends
// its nonce and opens a session. The nonce is spent only by a valid signature, so a stranger cannot
// burn the maker's nonce; one that is unknown, spent, expired or issued for another campaign is a 403.
export function startMakerSession(
  input: { pool: string; maker: string; domain: string; message: string; signature: string },
  now = Date.now(),
): { token: string; expiresAt: number } {
  const nonce = NONCE_LINE.exec(input.message)?.[1]
  if (!nonce) throw new HttpError('That sign-in message is not for this page; sign again', 403)
  try {
    verifyWalletMessage(input.message, input.signature, new PublicKey(input.maker), (issuedAt) => ordersMessage(input.pool, issuedAt, input.domain, nonce), now)
  } catch (e) {
    throw new HttpError(e instanceof Error ? e.message : 'Not authorized', 403)
  }
  const token = crypto.randomBytes(32).toString('base64url')
  const expiresAt = now + MAKER_SESSION_TTL_MS
  transaction((d) => {
    const spent = d.prepare('DELETE FROM signin_nonces WHERE nonce = ? AND pool = ? AND created_at > ?').run(nonce, input.pool, now - SIGN_IN_NONCE_TTL_MS)
    if (Number(spent.changes) !== 1) throw new HttpError('That sign-in was already used or has expired; sign again', 403)
    d.prepare('DELETE FROM maker_sessions WHERE expires_at < ?').run(now)
    const { n } = d.prepare('SELECT COUNT(*) AS n FROM maker_sessions').get() as { n: number }
    if (n >= MAX_MAKER_SESSIONS) throw new HttpError('Too many open sessions right now. Try again in a few minutes.', 429)
    d.prepare('INSERT INTO maker_sessions (token_hash, pool, maker, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(hash(token), input.pool, input.maker, now, expiresAt)
  })
  return { token, expiresAt }
}

// The maker wallet behind a session token for this campaign (403 when unknown, expired or for another
// campaign). The caller compares it with the campaign's maker.
export function maker(pool: string, token: string | null | undefined, now = Date.now()): string {
  if (!token) throw new HttpError('Sign in as the maker to see orders', 401)
  const row = db().prepare('SELECT pool, maker, expires_at FROM maker_sessions WHERE token_hash = ?').get(hash(token)) as
    | { pool: string; maker: string; expires_at: number }
    | undefined
  if (!row || row.pool !== pool || row.expires_at <= now) throw new HttpError('Your sign-in expired; sign in again', 401)
  return row.maker
}

export function endMakerSession(token: string) {
  db().prepare('DELETE FROM maker_sessions WHERE token_hash = ?').run(hash(token))
}

export const bearerToken = (header: string | null): string | null => /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header ?? '')?.[1] ?? null

