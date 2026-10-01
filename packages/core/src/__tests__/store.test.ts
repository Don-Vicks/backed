import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeDb, db, dbPath, MIGRATIONS } from '../db'
import {
  PENDING_TTL_MS,
  countFaucetClaims,
  getCampaign,
  getMetadata,
  getPending,
  listCampaigns,
  listPending,
  promotePending,
  recordFaucetClaim,
  saveCampaign,
  saveMetadata,
  savePending,
  takePending,
  takeRateToken,
  type CampaignRecord,
} from '../store'
import { listRedemptions, saveRedemption, type Redemption } from '../redemptions'

// Every test gets its own DATA_DIR (and so its own database file).
function freshDataDir() {
  closeDb()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-store-'))
  process.env.DATA_DIR = path.join(dir, 'data')
  process.env.NETWORK = 'localnet'
  return dir
}
beforeEach(() => {
  freshDataDir()
})

const record = (pool: string, over: Partial<CampaignRecord> = {}): CampaignRecord => ({
  pool,
  config: `cfg-${pool}`,
  baseMint: `mint-${pool}`,
  usdcMint: 'usdc',
  maker: 'maker',
  createdAt: new Date().toISOString(),
  createSignature: '',
  campaign: { name: 'Mug', symbol: 'MUG', uri: '', plan: { tiers: [{ units: 2, startPrice: 3 }], finalPrice: 4, makerSharePct: 10 }, dropBot: { startFeeBps: 1500, windowSec: 60 }, normalFeeBps: 100 },
  trust: { tier: 'C', score: 0, reasons: [], maxMakerSharePct: 10 },
  goalUsdc: 6,
  totalUnits: 2,
  fields: [],
  ...over,
})

const redemption = (signature: string, pool = 'P1'): Redemption => ({
  pool,
  signature,
  wallet: 'W',
  units: 1,
  shipping: { name: 'Ada Lovelace', email: 'ada@example.com', address: '12 Analytical St', country: 'UK' },
  createdAt: new Date().toISOString(),
})

test('store lives in DATA_DIR as backed.<network>.sqlite with every migration applied', () => {
  saveCampaign(record('P1'))
  assert.equal(dbPath(), path.join(process.env.DATA_DIR!, 'backed.localnet.sqlite'))
  assert.ok(fs.existsSync(dbPath()))
  const applied = db().prepare('SELECT name FROM schema_migrations').all() as { name: string }[]
  assert.deepEqual(applied.map((r) => r.name), MIGRATIONS.map((m) => m.name))
  assert.equal((db().prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal')
})

test('saveCampaign is idempotent and listCampaigns is newest first', () => {
  saveCampaign(record('P1', { createdAt: '2026-01-01T00:00:00.000Z' }))
  saveCampaign(record('P2', { createdAt: '2026-01-02T00:00:00.000Z' }))
  saveCampaign(record('P1', { createdAt: '2026-01-01T00:00:00.000Z', createSignature: 'sig' }))
  assert.deepEqual(listCampaigns().map((c) => c.pool), ['P2', 'P1'])
  assert.equal(getCampaign('P1')?.createSignature, 'sig')
  assert.equal(getCampaign('nope'), undefined)
})

test('a config belongs to one campaign only', () => {
  saveCampaign(record('P1', { config: 'shared' }))
  assert.throws(() => saveCampaign(record('P2', { config: 'shared' })), /already belongs to another campaign/)
  assert.deepEqual(listCampaigns().map((c) => c.pool), ['P1'])
})

test('pending: read without consuming, promote atomically, promote again is a no-op', () => {
  savePending(record('P1'))
  assert.equal(getPending('P1')?.pool, 'P1')
  assert.equal(getPending('P1')?.pool, 'P1', 'reading twice still finds it')
  const listed = promotePending('P1', 'SIG')
  assert.equal(listed?.createSignature, 'SIG')
  assert.equal(getPending('P1'), undefined)
  assert.equal(getCampaign('P1')?.createSignature, 'SIG')
  // A second confirm keeps the first signature.
  assert.equal(promotePending('P1', 'OTHER')?.createSignature, 'SIG')
  assert.equal(listCampaigns().length, 1)
  assert.equal(promotePending('unknown', 'SIG'), undefined)
})

test('pending: no count-based eviction, rows expire after the 24h TTL', () => {
  const t0 = Date.now()
  savePending(record('OLD'), t0 - PENDING_TTL_MS - 5000)
  for (let i = 0; i < 60; i++) savePending(record(`P${i}`), t0 - 1000)
  assert.ok(getPending('P0'), '60 fresh builds do not evict the first one')
  assert.equal(getPending('OLD'), undefined, 'expired row pruned on the next write')
  assert.equal(listPending().length, 60)
  assert.equal(listPending()[0].createdAtMs, t0 - 1000)
})

test('takePending still consumes (compatibility)', () => {
  savePending(record('P1'))
  assert.equal(takePending('P1')?.pool, 'P1')
  assert.equal(takePending('P1'), undefined)
})

test('metadata round trip; unknown and inherited keys are not found', () => {
  saveMetadata('abc', { name: 'Mug', symbol: 'MUG', description: 'd', image: '' })
  assert.deepEqual(getMetadata('abc'), { name: 'Mug', symbol: 'MUG', description: 'd', image: '' })
  assert.equal(getMetadata('__proto__'), undefined)
  assert.equal(getMetadata('constructor'), undefined)
})

test('redemptions: one per burn signature, shipping sealed at rest and opened for the maker', () => {
  saveRedemption(redemption('S1'))
  assert.throws(() => saveRedemption(redemption('S1')), /already submitted/)
  saveRedemption(redemption('S2', 'P2'))
  const rows = listRedemptions('P1')
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0].shipping, redemption('S1').shipping)
  const raw = db().prepare('SELECT shipping_ct FROM redemptions WHERE signature = ?').get('S1') as { shipping_ct: string }
  assert.ok(!raw.shipping_ct.includes('Ada') && raw.shipping_ct.startsWith('v1.'))
  const file = fs.readFileSync(dbPath())
  assert.ok(!file.includes('Analytical'), 'no plaintext address in the database file')
})

test('redemptions: a ciphertext moved to another row does not open', () => {
  saveRedemption(redemption('S1'))
  saveRedemption(redemption('S2'))
  const s1 = db().prepare('SELECT shipping_ct FROM redemptions WHERE signature = ?').get('S1') as { shipping_ct: string }
  db().prepare('UPDATE redemptions SET shipping_ct = ? WHERE signature = ?').run(s1.shipping_ct, 'S2')
  assert.throws(() => listRedemptions('P1'), /Cannot decrypt/)
})

test('legacy JSON files are imported once on first open and renamed', () => {
  const dataDir = process.env.DATA_DIR!
  fs.mkdirSync(dataDir, { recursive: true })
  const r = record('LEGACY')
  fs.writeFileSync(path.join(dataDir, 'campaigns.localnet.json'), JSON.stringify([r, record('L2')]))
  fs.writeFileSync(path.join(dataDir, 'pending.localnet.json'), JSON.stringify([record('PEND')]))
  fs.writeFileSync(path.join(dataDir, 'metadata.localnet.json'), JSON.stringify({ m1: { name: 'Mug', symbol: 'MUG', description: '', image: '' } }))
  fs.writeFileSync(path.join(dataDir, 'redemptions.localnet.json'), JSON.stringify([redemption('RS1', 'LEGACY')]))
  // A devnet file is left for the devnet database.
  fs.writeFileSync(path.join(dataDir, 'campaigns.devnet.json'), JSON.stringify([record('DEV')]))

  assert.deepEqual(getCampaign('LEGACY'), r)
  assert.equal(listCampaigns().length, 2)
  assert.equal(getPending('PEND')?.pool, 'PEND')
  assert.equal(getMetadata('m1')?.name, 'Mug')
  assert.deepEqual(listRedemptions('LEGACY')[0].shipping, redemption('RS1').shipping)
  assert.ok(fs.existsSync(path.join(dataDir, 'campaigns.localnet.json.imported')))
  assert.ok(!fs.existsSync(path.join(dataDir, 'campaigns.localnet.json')))
  assert.ok(fs.existsSync(path.join(dataDir, 'campaigns.devnet.json')))

  // A file that shows up later is not imported again (the import ran once).
  fs.writeFileSync(path.join(dataDir, 'campaigns.localnet.json'), JSON.stringify([record('LATE')]))
  closeDb()
  assert.equal(getCampaign('LATE'), undefined)
})

test('the database survives reopening (another process, a restart)', () => {
  saveCampaign(record('P1'))
  saveRedemption(redemption('S1'))
  closeDb()
  assert.equal(getCampaign('P1')?.pool, 'P1')
  assert.equal(listRedemptions('P1').length, 1)
})

test('rate tokens: a bucket empties and refills', () => {
  const t0 = 1_000_000
  assert.equal(takeRateToken('ip:1', 2, 1, t0), true)
  assert.equal(takeRateToken('ip:1', 2, 1, t0), true)
  assert.equal(takeRateToken('ip:1', 2, 1, t0), false)
  assert.equal(takeRateToken('ip:2', 2, 1, t0), true, 'buckets are per key')
  assert.equal(takeRateToken('ip:1', 2, 1, t0 + 1000), true, 'one token back after a second')
  assert.equal(takeRateToken('ip:1', 2, 1, t0 + 1000), false)
})

test('faucet claims are counted per wallet, per IP and in total', () => {
  const t0 = 5_000_000
  recordFaucetClaim('W1', '1.1.1.1', t0)
  recordFaucetClaim('W2', '1.1.1.1', t0 + 10)
  recordFaucetClaim('W1', '2.2.2.2', t0 - 100)
  assert.equal(countFaucetClaims(t0, { wallet: 'W1' }), 1)
  assert.equal(countFaucetClaims(t0 - 100, { wallet: 'W1' }), 2)
  assert.equal(countFaucetClaims(t0, { ip: '1.1.1.1' }), 2)
  assert.equal(countFaucetClaims(t0 - 100), 3)
})
