import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { closeDb, dataDir as dataDir_, db, dbPath, getMeta, legacyPlaintextFiles, MIGRATIONS, storeDurability, transaction } from '../db'
import { repoRoot } from '../paths'
import {
  FAUCET_RETENTION_MS,
  PENDING_TTL_MS,
  RATE_RETENTION_MS,
  countFaucetClaims,
  expirePending,
  getCampaign,
  getMetadata,
  getPending,
  listCampaigns,
  listPending,
  promotePending,
  prunePending,
  pruneStore,
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

test('redemptions: a ciphertext moved to another row does not open, and the other rows still list', () => {
  saveRedemption(redemption('S1'))
  saveRedemption(redemption('S2'))
  const s1 = db().prepare('SELECT shipping_ct FROM redemptions WHERE signature = ?').get('S1') as { shipping_ct: string }
  db().prepare('UPDATE redemptions SET shipping_ct = ? WHERE signature = ?').run(s1.shipping_ct, 'S2')
  const rows = listRedemptions('P1')
  assert.equal(rows.length, 2)
  const bad = rows.find((r) => r.signature === 'S2')!
  assert.equal(bad.shipping, null)
  assert.match(bad.error!, /Cannot decrypt/)
  assert.deepEqual(rows.find((r) => r.signature === 'S1')!.shipping, redemption('S1').shipping)
})

test('redemptions: setting SHIPPING_KEY later, and rotating it, keeps every order readable', () => {
  const env = { ...process.env }
  try {
    delete process.env.SHIPPING_KEY
    delete process.env.SHIPPING_KEY_PREVIOUS
    saveRedemption(redemption('S1')) // dev key
    const first = crypto.randomBytes(32).toString('hex')
    process.env.SHIPPING_KEY = first
    saveRedemption(redemption('S2'))
    assert.deepEqual(listRedemptions('P1').map((r) => r.shipping?.name), ['Ada Lovelace', 'Ada Lovelace'])
    process.env.SHIPPING_KEY = crypto.randomBytes(32).toString('base64')
    process.env.SHIPPING_KEY_PREVIOUS = first
    saveRedemption(redemption('S3'))
    assert.ok(listRedemptions('P1').every((r) => r.shipping?.name === 'Ada Lovelace'))
    // Without the previous key only the row it sealed is unreadable.
    delete process.env.SHIPPING_KEY_PREVIOUS
    const rows = listRedemptions('P1')
    assert.deepEqual(rows.filter((r) => !r.shipping).map((r) => r.signature), ['S2'])
  } finally {
    process.env.SHIPPING_KEY = env.SHIPPING_KEY
    process.env.SHIPPING_KEY_PREVIOUS = env.SHIPPING_KEY_PREVIOUS
    if (env.SHIPPING_KEY === undefined) delete process.env.SHIPPING_KEY
    if (env.SHIPPING_KEY_PREVIOUS === undefined) delete process.env.SHIPPING_KEY_PREVIOUS
  }
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
  // Plaintext shipping data does not outlive the import.
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.startsWith('redemptions')), [])
  assert.deepEqual(legacyPlaintextFiles(), [])
  const report = JSON.parse(getMeta('legacy_json_import')!) as { files: { file: string; rows: number }[] }
  assert.deepEqual(report.files.map((f) => [f.file, f.rows]), [['campaigns.localnet.json', 2], ['pending.localnet.json', 1], ['metadata.localnet.json', 1], ['redemptions.localnet.json', 1]])

  // A file that shows up later is not imported again (the import ran once).
  fs.writeFileSync(path.join(dataDir, 'campaigns.localnet.json'), JSON.stringify([record('LATE')]))
  closeDb()
  assert.equal(getCampaign('LATE'), undefined)
})

test('a torn or invalid legacy file never takes the store down', () => {
  const dataDir = process.env.DATA_DIR!
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'campaigns.localnet.json'), '[{"pool":"x"') // torn write
  fs.writeFileSync(path.join(dataDir, 'pending.localnet.json'), JSON.stringify([{ nope: 1 }, record('PEND')]))
  const { units: _, ...noUnits } = redemption('RS1')
  fs.writeFileSync(path.join(dataDir, 'redemptions.localnet.json'), JSON.stringify([noUnits, redemption('RS2', 'LEGACY')]))
  const errors: unknown[] = []
  const error = console.error
  console.error = (...args: unknown[]) => void errors.push(args.join(' '))
  try {
    assert.deepEqual(listCampaigns(), [])
    saveCampaign(record('NEW'))
  } finally {
    console.error = error
  }
  assert.ok(fs.existsSync(path.join(dataDir, 'campaigns.localnet.json.failed')))
  assert.equal(getPending('PEND')?.pool, 'PEND', 'valid rows of a file with a bad row are imported')
  assert.deepEqual(listRedemptions('LEGACY').map((r) => r.signature), ['RS2'])
  // A redemptions file with a skipped row is kept (renamed) for repair, and /api/status flags it.
  assert.deepEqual(legacyPlaintextFiles(), ['redemptions.localnet.json.failed'])
  assert.ok(errors.some((e) => String(e).includes('campaigns.localnet.json')), 'the log names the file')
  assert.ok(errors.some((e) => /redemptions\.localnet\.json, row 0: units/.test(String(e))), 'and the row')
})

test('legacy redemptions wait for a usable SHIPPING_KEY on mainnet; the store opens meanwhile', () => {
  const env = { ...process.env }
  const error = console.error
  try {
    process.env.NETWORK = 'mainnet'
    delete process.env.SHIPPING_KEY
    const dataDir = process.env.DATA_DIR!
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'campaigns.mainnet.json'), JSON.stringify([record('M1')]))
    fs.writeFileSync(path.join(dataDir, 'redemptions.mainnet.json'), JSON.stringify([redemption('RS1', 'M1')]))
    console.error = () => {}
    assert.equal(getCampaign('M1')?.pool, 'M1')
    assert.ok(fs.existsSync(path.join(dataDir, 'redemptions.mainnet.json')), 'left in place')
    closeDb()
    process.env.SHIPPING_KEY = crypto.randomBytes(32).toString('hex')
    assert.equal(listRedemptions('M1')[0].shipping?.name, 'Ada Lovelace', 'imported on the next open')
    assert.ok(!fs.existsSync(path.join(dataDir, 'redemptions.mainnet.json')))
  } finally {
    console.error = error
    closeDb()
    process.env.NETWORK = env.NETWORK
    if (env.SHIPPING_KEY === undefined) delete process.env.SHIPPING_KEY
    else process.env.SHIPPING_KEY = env.SHIPPING_KEY
  }
})

test('DATA_DIR: a trailing slash is the same directory, a relative one is taken from the repo root', () => {
  const dataDir = process.env.DATA_DIR!
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'campaigns.localnet.json'), JSON.stringify([record('L1')]))
  process.env.DATA_DIR = `${dataDir}/`
  assert.equal(getCampaign('L1')?.pool, 'L1')
  assert.equal(dataDir_({ DATA_DIR: 'store' }), path.join(repoRoot(), 'store'))
  assert.equal(dataDir_({ DATA_DIR: '/abs/store' }), '/abs/store')
})

test('durability: on Railway the store must sit under the attached volume', () => {
  const base = { NETWORK: 'devnet', DATA_DIR: '/app/data' }
  assert.equal(storeDurability({ ...base, RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }).durable, true)
  assert.equal(storeDurability({ ...base, RAILWAY_VOLUME_MOUNT_PATH: '/data' }).durable, false)
  assert.equal(storeDurability({ ...base, RAILWAY_ENVIRONMENT: 'production' }).durable, false, 'DATA_DIR set but no volume')
  assert.equal(storeDurability({ NETWORK: 'devnet', DATA_DIR: '/app/data-2', RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }).durable, false)
  assert.equal(storeDurability({ NETWORK: 'devnet', DATA_DIR: '/app/data/db', RAILWAY_VOLUME_MOUNT_PATH: '/app/data' }).durable, true)
  assert.equal(storeDurability(base).durable, true)
  assert.equal(storeDurability({ NETWORK: 'devnet' }).durable, false)
  assert.equal(storeDurability({ NETWORK: 'localnet' }).durable, true)
})

test('transaction: an error SQLite already rolled back for still surfaces', () => {
  assert.throws(
    () =>
      transaction((d) => {
        d.exec('ROLLBACK')
        throw new Error('original')
      }),
    /original/,
  )
  saveCampaign(record('P1')) // the handle is still usable
})

test('expiring a pending build drops its metadata; pruning keeps fresh rows', () => {
  const t0 = Date.now()
  saveMetadata('dead', { name: 'Mug', symbol: 'MUG', description: '', image: '' })
  saveMetadata('live', { name: 'Mug', symbol: 'MUG', description: '', image: '' })
  const uri = (id: string) => ({ ...record('x').campaign, uri: `https://backed.test/m/${id}` })
  savePending(record('DEAD', { campaign: uri('dead') }), t0 - PENDING_TTL_MS - 1)
  savePending(record('LIVE', { campaign: uri('live') }), t0)
  assert.equal(getPending('DEAD'), undefined, 'pruned on the next save')
  assert.equal(getMetadata('dead'), undefined)
  assert.ok(getMetadata('live'))
  expirePending('LIVE')
  assert.equal(getMetadata('live'), undefined)
  assert.equal(prunePending(t0), 0)

  takeRateToken('old', 1, 1, t0 - RATE_RETENTION_MS - 1)
  takeRateToken('new', 1, 1, t0)
  recordFaucetClaim('W1', null, t0 - FAUCET_RETENTION_MS - 1)
  recordFaucetClaim('W2', null, t0)
  assert.deepEqual(pruneStore(t0), { pending: 0, rate: 1, faucetClaims: 1 })
  assert.equal(countFaucetClaims(0), 1)
  assert.equal(takeRateToken('new', 1, 0, t0), false, 'a live bucket keeps its state')
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
