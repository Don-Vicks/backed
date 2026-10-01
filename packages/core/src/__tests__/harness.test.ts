// The localnet harness without a validator: what start.sh clones, the inspect math, and that the
// shell scripts parse. The chain side runs in localnet/*.test.ts (pnpm core:test:localnet).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import BN from 'bn.js'
import { Connection, Keypair } from '@solana/web3.js'
import { DAMM_V2_MIGRATION_FEE_ADDRESS, MigrationFeeOption, deriveDammV2PoolAddress } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DBC_POOL_AUTHORITY, LOCALNET_ACCOUNTS, LOCALNET_PROGRAMS, seedLocalnet, seededFiles } from '../localnet'
import { MIGRATION_FEE_OPTION } from '../engine'
import { resalePoolAddress } from '../chain'
import { pctOf, resalePoolAddressFor } from '../inspect'

const coreDir = path.join(__dirname, '..', '..')
const scriptsDir = path.join(coreDir, '..', '..', 'scripts', 'localnet')

test('start.sh clones the mainnet DBC, DAMM v2, Metaplex and Locker programs', () => {
  assert.deepEqual(
    Object.values(LOCALNET_PROGRAMS).map((p) => p.toBase58()),
    [
      'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
      'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
      'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',
      'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn',
    ],
  )
})

test('start.sh clones every DAMM v2 migration config, the one campaigns use and Customizable', () => {
  const accounts = LOCALNET_ACCOUNTS.map((a) => a.toBase58())
  assert.equal(accounts.length, DAMM_V2_MIGRATION_FEE_ADDRESS.length)
  assert.ok(accounts.includes(DAMM_V2_MIGRATION_FEE_ADDRESS[MIGRATION_FEE_OPTION].toBase58()))
  assert.ok(accounts.includes(DAMM_V2_MIGRATION_FEE_ADDRESS[MigrationFeeOption.Customizable].toBase58()))
  assert.ok(accounts.includes('A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck'))
})

test('the DBC pool authority start.sh funds is the PDA migrations draw rent from', () => {
  assert.equal(DBC_POOL_AUTHORITY.toBase58(), 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM')
})

test('localnet-accounts prints one `<kind> <address>` per line for the shell scripts', () => {
  const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', 'src/scripts/localnet-accounts.ts'], {
    cwd: coreDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const lines = out.trim().split('\n').map((l) => l.split(' '))
  assert.equal(lines.filter(([k]) => k === 'program').length, 4)
  assert.equal(lines.filter(([k]) => k === 'account').length, DAMM_V2_MIGRATION_FEE_ADDRESS.length)
  assert.deepEqual(lines.find(([k]) => k === 'pool-authority'), ['pool-authority', DBC_POOL_AUTHORITY.toBase58()])
  for (const l of lines) assert.equal(l.length, 2)
})

test('localnet shell scripts parse', () => {
  for (const f of ['lib.sh', 'start.sh', 'stop.sh', 'dump.sh']) execFileSync('bash', ['-n', path.join(scriptsDir, f)])
})

test('pctOf: share in percent to 0.01%, on u128-sized liquidity', () => {
  const pool = new BN('238947855635305356735895551')
  assert.equal(pctOf(pool.muln(4).divn(5).addn(1), pool), 80)
  assert.equal(pctOf(pool.divn(5), pool), 19.99) // floors: a hair under 20%
  assert.equal(pctOf(new BN(1234), new BN(10_000)), 12.34)
  assert.equal(pctOf(pool, pool), 100)
  assert.equal(pctOf(new BN(1), new BN(0)), 0)
})

test('inspect finds the resale pool from the migration fee option in the pool\'s own config', () => {
  const baseMint = Keypair.generate().publicKey
  const quoteMint = Keypair.generate().publicKey
  for (const option of [MigrationFeeOption.FixedBps200, MigrationFeeOption.Customizable, MigrationFeeOption.FixedBps25]) {
    assert.equal(
      resalePoolAddressFor({ migrationFeeOption: option, quoteMint }, baseMint).toBase58(),
      deriveDammV2PoolAddress(DAMM_V2_MIGRATION_FEE_ADDRESS[option], baseMint, quoteMint).toBase58(),
    )
  }
  // A FixedBps200 pool and a Customizable one with the same mints graduate into different pools.
  assert.notEqual(
    resalePoolAddressFor({ migrationFeeOption: MigrationFeeOption.FixedBps200, quoteMint }, baseMint).toBase58(),
    resalePoolAddressFor({ migrationFeeOption: MigrationFeeOption.Customizable, quoteMint }, baseMint).toBase58(),
  )
  // An option the SDK has no config for falls back to the one new campaigns use.
  assert.equal(
    resalePoolAddressFor({ migrationFeeOption: 99 as MigrationFeeOption, quoteMint }, baseMint).toBase58(),
    resalePoolAddress(baseMint, quoteMint).toBase58(),
  )
})

test('seedLocalnet refuses a root that already holds localnet keys or a mock USDC', async () => {
  // The refusal comes before any RPC call, so no validator is needed.
  const connection = new Connection('http://127.0.0.1:1', 'confirmed')
  for (const file of ['platform.json', 'mock-usdc.json']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-seed-'))
    try {
      assert.deepEqual(seededFiles(root), [])
      const keys = path.join(root, 'keys', 'localnet')
      fs.mkdirSync(keys, { recursive: true })
      fs.writeFileSync(path.join(keys, file), 'existing')
      await assert.rejects(seedLocalnet(connection, root), /already seeded \(keys\/localnet\/.*: seed a fresh PREORDER_ROOT/)
      assert.equal(fs.readFileSync(path.join(keys, file), 'utf8'), 'existing')
      assert.deepEqual(fs.readdirSync(keys), [file])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
})
