// Durable store: one SQLite file per network under DATA_DIR (a mounted volume when deployed).
// node:sqlite is synchronous, so the store keeps its synchronous API; WAL mode lets the web server
// and the core scripts share the file, and every write is a transaction, so a crash never tears it.
import fs from 'fs'
import path from 'path'
import type { DatabaseSync } from 'node:sqlite'
import { getNetwork } from './network'
import { repoRoot } from './paths'
import { sealJson } from './seal'

export type Db = DatabaseSync

// DATA_DIR holds only the database (no keys). Defaults to <repo>/data for local runs.
export function dataDir(): string {
  return process.env.DATA_DIR?.trim() || path.join(repoRoot(), 'data')
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
  handle.exec('PRAGMA busy_timeout = 5000')
  handle.exec('PRAGMA journal_mode = WAL')
  handle.exec('PRAGMA synchronous = FULL')
  migrate(handle)
  importLegacyJson(handle)
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
    d.exec('ROLLBACK')
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

// One-time import of the JSON files the store used before (data/<kind>.<network>.json, in DATA_DIR
// or the repo's data/). Imported files are renamed to *.imported; they still hold plaintext shipping
// data, so delete them once the import is checked.
function importLegacyJson(d: Db) {
  const net = getNetwork().name
  if (getMeta('legacy_json_import', d)) return
  const dirs = [...new Set([dataDir(), path.join(repoRoot(), 'data')])]
  const files = (kind: string) => dirs.map((dir) => path.join(dir, `${kind}.${net}.json`)).filter((f) => fs.existsSync(f))
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'))
  const imported: string[] = []
  transaction((t) => {
    if (getMeta('legacy_json_import', t)) return
    for (const file of files('campaigns')) {
      const insert = t.prepare('INSERT OR IGNORE INTO campaigns (pool, config, maker, created_at, data) VALUES (?, ?, ?, ?, ?)')
      for (const r of read(file)) insert.run(r.pool, r.config, r.maker, r.createdAt, JSON.stringify(r))
      imported.push(file)
    }
    for (const file of files('pending')) {
      const insert = t.prepare('INSERT OR IGNORE INTO pending (pool, created_at, data) VALUES (?, ?, ?)')
      for (const r of read(file)) insert.run(r.pool, Date.parse(r.createdAt) || Date.now(), JSON.stringify(r))
      imported.push(file)
    }
    for (const file of files('metadata')) {
      const insert = t.prepare('INSERT OR IGNORE INTO metadata (id, created_at, data) VALUES (?, ?, ?)')
      for (const [id, meta] of Object.entries(read(file) as Record<string, unknown>)) insert.run(id, Date.now(), JSON.stringify(meta))
      imported.push(file)
    }
    for (const file of files('redemptions')) {
      const insert = t.prepare(
        'INSERT OR IGNORE INTO redemptions (signature, pool, wallet, units, created_at, shipping_ct) VALUES (?, ?, ?, ?, ?, ?)',
      )
      for (const r of read(file)) {
        insert.run(r.signature, r.pool, r.wallet, r.units, r.createdAt, sealJson(r.shipping, redemptionAad(r.signature)))
      }
      imported.push(file)
    }
    setMeta('legacy_json_import', JSON.stringify({ at: new Date().toISOString(), files: imported.map((f) => path.basename(f)) }), t)
  }, d)
  for (const file of imported) fs.renameSync(file, `${file}.imported`)
  if (imported.length) console.warn(`Imported ${imported.length} legacy JSON store file(s) into ${dbPath()}; the *.imported copies can be deleted`)
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
