// Campaign store on the durable SQLite database (db.ts). Same synchronous API as the JSON store it replaced.
import { db, transaction } from './db'
import type { MigrationFeeOption } from '@meteora-ag/dynamic-bonding-curve-sdk'
import type { Campaign, ConfigField } from './engine'
import type { TrustResult } from './trust'

export type CampaignRecord = {
  pool: string
  config: string
  baseMint: string
  usdcMint: string
  maker: string
  createdAt: string
  createSignature: string
  campaign: Campaign
  trust: Pick<TrustResult, 'tier' | 'score' | 'reasons' | 'maxMakerSharePct'>
  goalUsdc: number
  totalUnits: number
  fields: ConfigField[]
  // The DAMM v2 config the pool migrates into (resale pool address). The on-chain config is the
  // source of truth; records older than this field are FixedBps200.
  migrationFeeOption?: MigrationFeeOption
}

const parse = <T>(row: unknown) => JSON.parse((row as { data: string }).data) as T

export function listCampaigns(): CampaignRecord[] {
  return db().prepare('SELECT data FROM campaigns ORDER BY created_at DESC, rowid DESC').all().map((r) => parse<CampaignRecord>(r))
}

// Idempotent: saving the same pool again updates it in place. A config belongs to one pool only.
export function saveCampaign(record: CampaignRecord) {
  try {
    db()
      .prepare(
        `INSERT INTO campaigns (pool, config, maker, created_at, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(pool) DO UPDATE SET config = excluded.config, maker = excluded.maker, created_at = excluded.created_at, data = excluded.data`,
      )
      .run(record.pool, record.config, record.maker, record.createdAt, JSON.stringify(record))
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: campaigns\.config/.test(e.message)) {
      throw new Error(`Config ${record.config} already belongs to another campaign`)
    }
    throw e
  }
}

export function getCampaign(pool: string): CampaignRecord | undefined {
  const row = db().prepare('SELECT data FROM campaigns WHERE pool = ?').get(pool)
  return row ? parse<CampaignRecord>(row) : undefined
}

// Campaigns built for a maker's wallet but not yet confirmed on-chain. Rows live for PENDING_TTL_MS;
// the reconcile job (listing.ts) lists or expires them against chain state well before that.
export const PENDING_TTL_MS = 24 * 60 * 60_000
export type PendingRecord = { record: CampaignRecord; createdAtMs: number }

export function savePending(record: CampaignRecord, now = Date.now()) {
  transaction((d) => {
    prunePending(now - PENDING_TTL_MS)
    d.prepare('INSERT INTO pending (pool, created_at, data) VALUES (?, ?, ?) ON CONFLICT(pool) DO UPDATE SET created_at = excluded.created_at, data = excluded.data').run(
      record.pool,
      now,
      JSON.stringify(record),
    )
  })
}

// Reads without consuming: the row is removed only once the campaign is saved (promotePending).
export function getPending(pool: string): CampaignRecord | undefined {
  const row = db().prepare('SELECT data FROM pending WHERE pool = ?').get(pool)
  return row ? parse<CampaignRecord>(row) : undefined
}

export function listPending(): PendingRecord[] {
  return (db().prepare('SELECT data, created_at FROM pending ORDER BY created_at').all() as { data: string; created_at: number }[]).map((r) => ({
    record: JSON.parse(r.data) as CampaignRecord,
    createdAtMs: r.created_at,
  }))
}

export function deletePending(pool: string) {
  db().prepare('DELETE FROM pending WHERE pool = ?').run(pool)
}

// The /m/<id> (or older /api/metadata/<id>) metadata row a campaign's uri points at.
export const metadataIdOf = (record: CampaignRecord) => /\/(?:m|api\/metadata)\/([^/?#]+)$/.exec(record.campaign?.uri ?? '')?.[1]

// Drops a build that never landed together with the metadata saved for it (unless a listed campaign
// uses it). Only for builds whose create transaction can no longer land.
export function expirePending(pool: string) {
  transaction((d) => {
    const record = getPending(pool)
    deletePending(pool)
    const id = record && metadataIdOf(record)
    if (id && !getCampaign(pool)) d.prepare('DELETE FROM metadata WHERE id = ?').run(id)
  })
}

// Expires every pending row created before a time (and its metadata). Returns how many.
export function prunePending(beforeMs: number): number {
  return transaction((d) => {
    const pools = (d.prepare('SELECT pool FROM pending WHERE created_at < ?').all(beforeMs) as { pool: string }[]).map((r) => r.pool)
    for (const pool of pools) expirePending(pool)
    return pools.length
  })
}

export function takePending(pool: string): CampaignRecord | undefined {
  return transaction(() => {
    const found = getPending(pool)
    deletePending(pool)
    return found
  })
}

// Lists a pending campaign with its create signature and drops the pending row, atomically.
// Already listed: returns the listed record unchanged (and still drops any pending row).
export function promotePending(pool: string, createSignature: string): CampaignRecord | undefined {
  return transaction(() => {
    const listed = getCampaign(pool)
    const pending = getPending(pool)
    if (!listed && pending) saveCampaign({ ...pending, createSignature })
    deletePending(pool)
    return listed ?? (pending && { ...pending, createSignature })
  })
}

// Token metadata JSON served by the web app at /m/<id> (Metaplex uri; older campaigns use /api/metadata/<id>).
export type TokenMetadata = { name: string; symbol: string; description: string; image: string }

export function saveMetadata(id: string, meta: TokenMetadata) {
  db()
    .prepare('INSERT INTO metadata (id, created_at, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
    .run(id, Date.now(), JSON.stringify(meta))
}

export function getMetadata(id: string): TokenMetadata | undefined {
  const row = db().prepare('SELECT data FROM metadata WHERE id = ?').get(id)
  return row ? parse<TokenMetadata>(row) : undefined
}

// Durable token bucket per key (an IP on a route, a wallet): capacity tokens, refilled at refillPerSec.
// Returns false when the bucket is empty. The buckets are a guard, not a record: a store that cannot
// be read or written fails open (every bucket full) rather than turning each limited request into a 500.
export function takeRateToken(key: string, capacity: number, refillPerSec: number, now = Date.now()): boolean {
  try {
    return transaction((d) => {
      const row = d.prepare('SELECT tokens, updated_at FROM rate WHERE key = ?').get(key) as { tokens: number; updated_at: number } | undefined
      const available = row ? Math.min(capacity, row.tokens + (Math.max(0, now - row.updated_at) / 1000) * refillPerSec) : capacity
      const ok = available >= 1
      d.prepare('INSERT INTO rate (key, tokens, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at').run(
        key,
        ok ? available - 1 : available,
        now,
      )
      return ok
    })
  } catch (e) {
    console.error(`rate limits not saved: ${e instanceof Error ? e.message : String(e)}`)
    return true
  }
}

// A bucket untouched this long has refilled for any sane limit, so dropping it changes nothing.
export function pruneRate(olderThanMs: number, now = Date.now()): number {
  return Number(db().prepare('DELETE FROM rate WHERE updated_at < ?').run(now - olderThanMs).changes)
}

// Faucet claims (devnet/localnet), kept for FAUCET_RETENTION_MS: longer than any faucet window.
export function recordFaucetClaim(wallet: string, ip: string | null, now = Date.now()) {
  db().prepare('INSERT INTO faucet_claims (wallet, ip, claimed_at) VALUES (?, ?, ?)').run(wallet, ip, now)
}

// Takes back a claim recorded before a transfer that then provably did not happen.
export function removeFaucetClaim(wallet: string, claimedAt: number) {
  db().prepare('DELETE FROM faucet_claims WHERE rowid = (SELECT rowid FROM faucet_claims WHERE wallet = ? AND claimed_at = ? LIMIT 1)').run(wallet, claimedAt)
}

// Claims since a time, optionally for one wallet or one IP (both unset: all claims).
export function countFaucetClaims(sinceMs: number, by: { wallet?: string; ip?: string } = {}): number {
  const where = ['claimed_at >= ?']
  const args: (string | number)[] = [sinceMs]
  if (by.wallet) {
    where.push('wallet = ?')
    args.push(by.wallet)
  }
  if (by.ip) {
    where.push('ip = ?')
    args.push(by.ip)
  }
  return (db().prepare(`SELECT COUNT(*) AS n FROM faucet_claims WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n
}

export function pruneFaucetClaims(olderThanMs: number, now = Date.now()): number {
  return Number(db().prepare('DELETE FROM faucet_claims WHERE claimed_at < ?').run(now - olderThanMs).changes)
}

// Housekeeping for the reconcile job: pending rows past their TTL (with their metadata), idle rate
// buckets after a day, faucet claims after 30 days (longer than any faucet window).
export const RATE_RETENTION_MS = 24 * 60 * 60_000
export const FAUCET_RETENTION_MS = 30 * 24 * 60 * 60_000
export function pruneStore(now = Date.now()) {
  return {
    pending: prunePending(now - PENDING_TTL_MS),
    rate: pruneRate(RATE_RETENTION_MS, now),
    faucetClaims: pruneFaucetClaims(FAUCET_RETENTION_MS, now),
  }
}

// A campaign's trade history (see the 0004_trade_history migration). `trades` is opaque here: the web
// app reads and writes it whole.
export type TradeHistory<T = unknown> = { newest?: string; updatedAt: number; trades: T[] }

export function getTradeHistory<T>(pool: string): TradeHistory<T> | undefined {
  const row = db().prepare('SELECT newest, updated_at, data FROM trade_history WHERE pool = ?').get(pool) as { newest: string | null; updated_at: number; data: string } | undefined
  return row && { newest: row.newest ?? undefined, updatedAt: row.updated_at, trades: JSON.parse(row.data) as T[] }
}

export function saveTradeHistory<T>(pool: string, history: TradeHistory<T>) {
  db()
    .prepare('INSERT INTO trade_history (pool, newest, updated_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(pool) DO UPDATE SET newest = excluded.newest, updated_at = excluded.updated_at, data = excluded.data')
    .run(pool, history.newest ?? null, history.updatedAt, JSON.stringify(history.trades))
}
