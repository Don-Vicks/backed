// Durable store: one SQLite file per network under DATA_DIR (a mounted volume when deployed).
// node:sqlite is synchronous, so the store keeps its synchronous API; WAL mode lets the web server
// and the core scripts share the file, and every write is a transaction, so a crash never tears it.
import fs from 'fs'
import path from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { getNetwork } from './network'
import { repoRoot } from './paths'
import { isLegacySealed, openLegacySealed, sealJson, shippingKey } from './seal'

export type Db = DatabaseSync

// DATA_DIR holds only the database (no keys). Defaults to <repo>/data for local runs. A relative
// DATA_DIR is taken from the repo root, so the server (cwd apps/web) and the scripts (cwd
// packages/core) open the same file.
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.DATA_DIR?.trim()
  return dir ? path.resolve(repoRoot(), dir) : path.join(repoRoot(), 'data')
}

// Whether the store survives a redeploy. On Railway the directory must sit on the attached volume
// (Railway sets RAILWAY_VOLUME_MOUNT_PATH only when one is attached); elsewhere an explicit DATA_DIR
// is taken on trust.
export function storeDurability(env: NodeJS.ProcessEnv = process.env): { durable: boolean; reason: string } {
  if (getNetwork(env).name === 'localnet') return { durable: true, reason: 'localnet' }
  const dir = dataDir(env)
  const mount = env.RAILWAY_VOLUME_MOUNT_PATH?.trim()
  if (mount) {
    const rel = path.relative(path.resolve(mount), dir)
    const inside = !rel.startsWith('..') && !path.isAbsolute(rel)
    return { durable: inside, reason: inside ? `on the volume at ${mount}` : `${dir} is outside the volume at ${mount}` }
  }
  if (env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID) return { durable: false, reason: 'no Railway volume attached' }
  return env.DATA_DIR?.trim() ? { durable: true, reason: 'DATA_DIR set (volume not verified)' } : { durable: false, reason: 'DATA_DIR not set' }
}

export function dbPath(): string {
  return path.join(dataDir(), `backed.${getNetwork().name}.sqlite`)
}

// Schema changes, applied once each, in order, and recorded by name. Append new entries at the end
// and never edit one that has shipped; a name (not a number) keeps parallel branches easy to merge.
export type Migration = { name: string; sql: string }
export const MIGRATIONS: Migration[] = [
  {
    name: '0001_initial',
    sql: `
      CREATE TABLE campaigns (
        pool TEXT PRIMARY KEY,
        config TEXT NOT NULL UNIQUE,
        maker TEXT NOT NULL,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE pending (
        pool TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX pending_created_at ON pending(created_at);
      CREATE TABLE metadata (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE redemptions (
        signature TEXT PRIMARY KEY,
        pool TEXT NOT NULL,
        wallet TEXT NOT NULL,
        units INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        shipping_ct TEXT NOT NULL
      );
      CREATE INDEX redemptions_pool ON redemptions(pool, created_at);
      CREATE TABLE faucet_claims (
        wallet TEXT NOT NULL,
        ip TEXT,
        claimed_at INTEGER NOT NULL
      );
      CREATE INDEX faucet_claims_wallet ON faucet_claims(wallet, claimed_at);
      CREATE INDEX faucet_claims_time ON faucet_claims(claimed_at);
      CREATE TABLE rate (
        key TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    // Memo-bound redemptions: an order has the id its burn's memo names, and its shipping details are
    // deleted (shipping_ct NULL) once the maker marks it shipped. A pending redemption is a burn its
    // wallet signed, kept from just before the server sends it until its order is recorded or it is known
    // not to have landed; its sealed shipping details move to the order unchanged.
    name: '0002_redemption_flow',
    sql: `
      CREATE TABLE redemptions_v2 (
        signature TEXT PRIMARY KEY,
        id TEXT UNIQUE,
        pool TEXT NOT NULL,
        wallet TEXT NOT NULL,
        units INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        shipping_ct TEXT,
        shipped_at TEXT
      );
      INSERT INTO redemptions_v2 (signature, pool, wallet, units, created_at, shipping_ct)
        SELECT signature, pool, wallet, units, created_at, shipping_ct FROM redemptions ORDER BY rowid;
      DROP TABLE redemptions;
      ALTER TABLE redemptions_v2 RENAME TO redemptions;
      CREATE INDEX redemptions_pool ON redemptions(pool, created_at);
      CREATE TABLE pending_redemptions (
        id TEXT PRIMARY KEY,
        pool TEXT NOT NULL,
        wallet TEXT NOT NULL,
        units INTEGER NOT NULL,
        signature TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_valid_block_height INTEGER NOT NULL,
        shipping_ct TEXT NOT NULL
      );
      CREATE INDEX pending_redemptions_owner ON pending_redemptions(pool, wallet);
      CREATE INDEX pending_redemptions_created_at ON pending_redemptions(created_at);
    `,
  },
  {
    // Product photos the makers upload. Kept in the database (so they ride on the same volume as
    // everything else), keyed by a hash of their bytes so the same photo is stored once.
    name: '0003_images',
    sql: `
      CREATE TABLE images (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        bytes BLOB NOT NULL
      );
    `,
  },
]

// node:sqlite prints an ExperimentalWarning on first load (Node 22); keep it out of the logs.
// getBuiltinModule loads it at runtime, out of reach of the Next bundler (which cannot resolve a
// require of node:sqlite) and only when the store is first used.
function loadSqlite(): typeof import('node:sqlite') {
  const emit = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (String(warning).includes('SQLite is an experimental feature')) return
    return (emit as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return process.getBuiltinModule('node:sqlite')
  } finally {
    process.emitWarning = emit
  }
}

// One handle per file, shared across hot reloads in dev.
const handles: Map<string, Db> = ((globalThis as { __preorderDb?: Map<string, Db> }).__preorderDb ??= new Map())

export function db(): Db {
  const file = dbPath()
  const open = handles.get(file)
  if (open) return open
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const { DatabaseSync } = loadSqlite()
  const handle = new DatabaseSync(file)
  try {
    handle.exec('PRAGMA busy_timeout = 5000')
    handle.exec('PRAGMA journal_mode = WAL')
    handle.exec('PRAGMA synchronous = FULL')
    migrate(handle)
    importLegacyJson(handle)
  } catch (e) {
    // Not cached, so the next call retries; close this handle rather than leak it.
    handle.close()
    throw e
  }
  handles.set(file, handle)
  return handle
}

// Tests switch DATA_DIR between cases; servers never need this.
export function closeDb() {
  for (const handle of handles.values()) handle.close()
  handles.clear()
}

const depth = new WeakMap<Db, number>()

// Runs fn in one write transaction (nested calls join the outer one).
export function transaction<T>(fn: (d: Db) => T, d: Db = db()): T {
  const level = depth.get(d) ?? 0
  if (level > 0) return fn(d)
  d.exec('BEGIN IMMEDIATE')
  depth.set(d, 1)
  try {
    const result = fn(d)
    d.exec('COMMIT')
    return result
  } catch (e) {
    // SQLite may have rolled back already (SQLITE_FULL, IOERR); keep the original error either way.
    try {
      if (d.isTransaction) d.exec('ROLLBACK')
    } catch {}
    throw e
  } finally {
    depth.set(d, 0)
  }
}

function migrate(d: Db) {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = new Set((d.prepare('SELECT name FROM schema_migrations').all() as { name: string }[]).map((r) => r.name))
  for (const m of MIGRATIONS) {
    if (applied.has(m.name)) continue
    transaction((t) => {
      // Another process may have applied it while we waited for the write lock.
      if (t.prepare('SELECT 1 FROM schema_migrations WHERE name = ?').get(m.name)) return
      t.exec(m.sql)
      t.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(m.name, new Date().toISOString())
    }, d)
  }
}

export function getMeta(key: string, d: Db = db()): string | undefined {
  return (d.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
}

export function setMeta(key: string, value: string, d: Db = db()) {
  d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// The shipping data of a redemption is sealed to its signature.
export const redemptionAad = (signature: string) => `redemption:${signature}`

// One-time import of the JSON files the store used before (data/<kind>.<network>.json in DATA_DIR):
// campaigns, pending creates, token metadata and orders, plus the pending redemptions, faucet claims
// and rate-limit buckets the JSON-file stores kept.
// Each file is imported in its own transaction and each row on its own: a row that does not validate
// is skipped and logged, a file that does not parse is renamed *.failed, and the store opens either way.
// Imported files are renamed *.imported, except redemptions, which hold plaintext shipping details and
// are deleted once their rows are sealed in the database (kept as *.failed if any row was skipped).
// Shipping details sealed by the JSON store (LegacySealed) are opened and re-sealed with sealJson.
// Without a usable SHIPPING_KEY the files with shipping details are left in place and imported on a
// later open.
type LegacyFileReport = { file: string; rows: number; skipped: number[]; error?: string }
const LEGACY_KINDS = ['campaigns', 'pending', 'metadata', 'redemptions', 'pending-redemptions', 'faucet-claims', 'rate'] as const
type LegacyKind = (typeof LEGACY_KINDS)[number]
// Files that are an object keyed by id rather than an array of rows.
const KEYED_KINDS: LegacyKind[] = ['metadata', 'rate']
// Files whose rows carry shipping details, so need SHIPPING_KEY to be sealed.
const SEALED_KINDS: LegacyKind[] = ['redemptions', 'pending-redemptions']

const str = (v: unknown, field: string) => {
  if (typeof v !== 'string' || !v) throw new Error(`missing ${field}`)
  return v
}
const num = (v: unknown, field: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`missing ${field}`)
  return v
}
const positiveUnits = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 1) throw new Error('units must be a positive integer')
  return v as number
}

// Shipping details of a legacy row, sealed to `aad`: plaintext (the first JSON store) or LegacySealed.
function resealShipping(shipping: unknown, pool: string, wallet: string, aad: string, key: Buffer): string {
  if (!shipping || typeof shipping !== 'object') throw new Error('missing shipping')
  return sealJson(isLegacySealed(shipping) ? openLegacySealed(shipping, pool, wallet) : shipping, aad, key)
}

// Inserts one legacy row, or throws. A row already there is skipped (INSERT OR IGNORE, or NOT EXISTS for
// faucet claims), so an import retried after a crash (rows committed, file not yet renamed) is a no-op.
function legacyRowImporter(t: Db, kind: LegacyKind, key: Buffer | null): (row: any, id?: string) => void {
  if (kind === 'campaigns') {
    const insert = t.prepare('INSERT OR IGNORE INTO campaigns (pool, config, maker, created_at, data) VALUES (?, ?, ?, ?, ?)')
    return (r) => void insert.run(str(r?.pool, 'pool'), str(r.config, 'config'), str(r.maker, 'maker'), str(r.createdAt, 'createdAt'), JSON.stringify(r))
  }
  if (kind === 'pending') {
    const insert = t.prepare('INSERT OR IGNORE INTO pending (pool, created_at, data) VALUES (?, ?, ?)')
    return (r) => void insert.run(str(r?.pool, 'pool'), Date.parse(r.createdAt) || Date.now(), JSON.stringify(r))
  }
  if (kind === 'metadata') {
    const insert = t.prepare('INSERT OR IGNORE INTO metadata (id, created_at, data) VALUES (?, ?, ?)')
    return (meta, id) => {
      if (!meta || typeof meta !== 'object') throw new Error('not an object')
      insert.run(str(id, 'id'), Date.now(), JSON.stringify(meta))
    }
  }
  if (kind === 'faucet-claims') {
    // The table has no key: a claim already there (same wallet, ip and time) is the same claim.
    const insert = t.prepare(
      'INSERT INTO faucet_claims (wallet, ip, claimed_at) SELECT ?1, ?2, ?3 WHERE NOT EXISTS (SELECT 1 FROM faucet_claims WHERE wallet = ?1 AND ip IS ?2 AND claimed_at = ?3)',
    )
    return (c) => void insert.run(str(c?.wallet, 'wallet'), typeof c.ip === 'string' ? c.ip : null, num(c.claimedAt, 'claimedAt'))
  }
  if (kind === 'rate') {
    const insert = t.prepare('INSERT OR IGNORE INTO rate (key, tokens, updated_at) VALUES (?, ?, ?)')
    return (b, id) => void insert.run(str(id, 'key'), num(b?.tokens, 'tokens'), num(b.updatedAt, 'updatedAt'))
  }
  if (kind === 'pending-redemptions') {
    const insert = t.prepare(
      'INSERT OR IGNORE INTO pending_redemptions (id, pool, wallet, units, signature, created_at, last_valid_block_height, shipping_ct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    return (p) => {
      const signature = str(p?.signature, 'signature')
      const pool = str(p.pool, 'pool')
      const wallet = str(p.wallet, 'wallet')
      const createdAt = Date.parse(str(p.createdAt, 'createdAt'))
      if (!Number.isFinite(createdAt)) throw new Error('createdAt is not a date')
      const shipping = resealShipping(p.shipping, pool, wallet, redemptionAad(signature), key!)
      insert.run(str(p.id, 'id'), pool, wallet, positiveUnits(p.units), signature, createdAt, num(p.lastValidBlockHeight, 'lastValidBlockHeight'), shipping)
    }
  }
  const insert = t.prepare('INSERT OR IGNORE INTO redemptions (signature, id, pool, wallet, units, created_at, shipping_ct, shipped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  return (r) => {
    const signature = str(r?.signature, 'signature')
    const pool = str(r.pool, 'pool')
    const wallet = str(r.wallet, 'wallet')
    const units = positiveUnits(r.units)
    const shippedAt = typeof r.shippedAt === 'string' ? r.shippedAt : null
    // Shipped orders kept no shipping details.
    const shipping = r.shipping === null && shippedAt ? null : resealShipping(r.shipping, pool, wallet, redemptionAad(signature), key!)
    insert.run(signature, typeof r.id === 'string' && r.id ? r.id : null, pool, wallet, units, str(r.createdAt, 'createdAt'), shipping, shippedAt)
  }
}

// Overwrites, then unlinks: the plaintext should not outlive the import on the volume.
function shred(file: string) {
  fs.writeFileSync(file, Buffer.alloc(fs.statSync(file).size))
  fs.unlinkSync(file)
}

function importLegacyFile(d: Db, kind: LegacyKind, file: string, key: Buffer | null): LegacyFileReport {
  const report: LegacyFileReport = { file: path.basename(file), rows: 0, skipped: [] }
  let rows: [string | undefined, unknown][]
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (KEYED_KINDS.includes(kind)) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object')
      rows = Object.entries(parsed)
    } else {
      if (!Array.isArray(parsed)) throw new Error('expected an array')
      rows = parsed.map((r) => [undefined, r])
    }
  } catch (e) {
    if (missing(e)) return report // another process imported it first
    report.error = e instanceof Error ? e.message : String(e)
    console.error(`Legacy store file ${file} is unreadable (${report.error}); renamed to *.failed, not imported`)
    ignoreMissing(() => fs.renameSync(file, `${file}.failed`))
    return report
  }
  transaction((t) => {
    const insert = legacyRowImporter(t, kind, key)
    rows.forEach(([id, row], i) => {
      try {
        insert(row, id)
        report.rows++
      } catch (e) {
        report.skipped.push(i)
        console.error(`Legacy store file ${file}, row ${i}${id ? ` (${id})` : ''}: ${e instanceof Error ? e.message : String(e)}; skipped`)
      }
    })
  }, d)
  ignoreMissing(() => {
    if (kind !== 'redemptions') fs.renameSync(file, `${file}.imported`)
    else if (report.skipped.length) fs.renameSync(file, `${file}.failed`)
    else shred(file)
  })
  return report
}

const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT'
function ignoreMissing(fn: () => void) {
  try {
    fn()
  } catch (e) {
    if (!missing(e)) throw e
  }
}

function importLegacyJson(d: Db) {
  if (getMeta('legacy_json_import', d)) return
  const net = getNetwork().name
  const reports: LegacyFileReport[] = []
  let deferred = false
  for (const kind of LEGACY_KINDS) {
    const file = path.join(dataDir(), `${kind}.${net}.json`)
    if (!fs.existsSync(file)) continue
    let key: Buffer | null = null
    if (SEALED_KINDS.includes(kind)) {
      try {
        key = shippingKey()
      } catch (e) {
        deferred = true
        console.error(`Legacy ${file} not imported yet: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }
    }
    reports.push(importLegacyFile(d, kind, file, key))
  }
  if (deferred) return
  transaction((t) => {
    if (!getMeta('legacy_json_import', t)) setMeta('legacy_json_import', JSON.stringify({ at: new Date().toISOString(), files: reports }), t)
  }, d)
  if (reports.length) console.warn(`Imported ${reports.length} legacy JSON store file(s) into ${dbPath()}: ${JSON.stringify(reports)}`)
}

// Plaintext shipping details left on the volume: a redemptions JSON file of any network, or its
// *.imported / *.failed copy. /api/status reports them.
export function legacyPlaintextFiles(): string[] {
  try {
    return fs.readdirSync(dataDir()).filter((f) => /^redemptions\.[a-z]+\.json(\.[a-z]+)?$/.test(f))
  } catch {
    return []
  }
}

// For /api/status: proves the file is writable (a real write transaction), and counts rows.
export function storeHealth(): { ok: boolean; campaigns?: number; pending?: number; error?: string } {
  try {
    const d = db()
    transaction((t) => setMeta('status_check', new Date().toISOString(), t), d)
    const count = (table: string) => (d.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    return { ok: true, campaigns: count('campaigns'), pending: count('pending') }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
