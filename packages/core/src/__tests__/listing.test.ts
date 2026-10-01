import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { closeDb } from '../db'
import { getCampaign, getPending, listCampaigns, savePending, type CampaignRecord } from '../store'
import { ListingError, confirmListing, findCreateSignature, reconcilePending, verifyCreateTx } from '../listing'

beforeEach(() => {
  closeDb()
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'preorder-listing-'))
  process.env.NETWORK = 'localnet'
})

const DBC = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()
const sig = () => bs58.encode(Keypair.generate().secretKey) // 64 bytes, like a signature

type FakeTx = { err?: unknown; keys: { address: string; signer: boolean }[] }
// Just the Connection calls listing.ts makes.
function fakeChain() {
  const pools = new Set<string>()
  const txs = new Map<string, FakeTx>()
  const history = new Map<string, { signature: string; err: unknown }[]>() // newest first, like the RPC
  const conn = {
    getAccountInfo: async (key: PublicKey) => (pools.has(key.toBase58()) ? { owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID } : null),
    getParsedTransaction: async (s: string) => {
      const tx = txs.get(s)
      if (!tx) return null
      return {
        meta: { err: tx.err ?? null },
        transaction: { message: { accountKeys: tx.keys.map((k) => ({ pubkey: new PublicKey(k.address), signer: k.signer })) } },
      }
    },
    getSignaturesForAddress: async (key: PublicKey) => history.get(key.toBase58()) ?? [],
  }
  // A create transaction: lands the pool, signed by the maker.
  const land = (r: CampaignRecord, over: Partial<FakeTx> = {}) => {
    const s = sig()
    pools.add(r.pool)
    txs.set(s, { keys: [{ address: r.maker, signer: true }, { address: r.pool, signer: false }, { address: DBC, signer: false }], ...over })
    history.set(r.pool, [{ signature: sig(), err: null }, { signature: s, err: null }])
    return s
  }
  return { conn: conn as unknown as Connection, land, pools, txs, history }
}

const record = (): CampaignRecord => {
  const pool = Keypair.generate().publicKey.toBase58()
  return {
    pool,
    config: Keypair.generate().publicKey.toBase58(),
    baseMint: Keypair.generate().publicKey.toBase58(),
    usdcMint: 'usdc',
    maker: Keypair.generate().publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    createSignature: '',
    campaign: { name: 'Mug', symbol: 'MUG', uri: '', plan: { tiers: [{ units: 2, startPrice: 3 }], finalPrice: 4, makerSharePct: 10 }, dropBot: { startFeeBps: 1500, windowSec: 60 }, normalFeeBps: 100 },
    trust: { tier: 'C', score: 0, reasons: [], maxMakerSharePct: 10 },
    goalUsdc: 6,
    totalUnits: 2,
    fields: [],
  }
}

const rejects = (p: Promise<unknown>, status: number, re: RegExp) =>
  assert.rejects(p, (e: unknown) => e instanceof ListingError && e.status === status && re.test(e.message))

test('confirm lists the campaign, and confirming again returns ok without a second row', async () => {
  const chain = fakeChain()
  const r = record()
  savePending(r)
  const s = chain.land(r)
  const first = await confirmListing(chain.conn, r.pool, s, { waitMs: 0 })
  assert.equal(first.alreadyListed, false)
  assert.equal(first.record.createSignature, s)
  const again = await confirmListing(chain.conn, r.pool, s, { waitMs: 0 })
  assert.equal(again.alreadyListed, true)
  assert.equal(listCampaigns().length, 1)
  assert.equal(getPending(r.pool), undefined)
})

test('confirm before the pool lands keeps the pending row and asks to retry', async () => {
  const chain = fakeChain()
  const r = record()
  savePending(r)
  await rejects(confirmListing(chain.conn, r.pool, sig(), { waitMs: 0 }), 409, /not found on-chain yet/)
  assert.ok(getPending(r.pool), 'pending row survives a failed confirm')
})

test('confirm waits for a pool that lands during the server-side poll', async () => {
  const chain = fakeChain()
  const r = record()
  savePending(r)
  let s = ''
  setTimeout(() => (s = chain.land(r)), 300)
  const listed = await confirmListing(chain.conn, r.pool, undefined, { waitMs: 5000 })
  assert.equal(listed.record.createSignature, s, 'signature found on-chain when the client has none')
})

test('confirm rejects unknown pools and bad or foreign signatures', async () => {
  const chain = fakeChain()
  await rejects(confirmListing(chain.conn, record().pool, sig(), { waitMs: 0 }), 404, /Unknown campaign/)
  const r = record()
  savePending(r)
  chain.land(r)
  await rejects(confirmListing(chain.conn, r.pool, 'not-a-signature', { waitMs: 0 }), 400, /not a transaction signature/)
  await rejects(confirmListing(chain.conn, r.pool, sig(), { waitMs: 0 }), 409, /not found yet/) // unknown signature: null, never ok
  const other = record()
  const foreign = chain.land(other)
  await rejects(confirmListing(chain.conn, r.pool, foreign, { waitMs: 0 }), 400, /did not create this campaign/)
  assert.equal(getCampaign(r.pool), undefined)
})

test('verifyCreateTx requires success and the maker as signer', async () => {
  const chain = fakeChain()
  const r = record()
  const failed = chain.land(r, { err: { InstructionError: [0, 'Custom'] } })
  await rejects(verifyCreateTx(chain.conn, r, failed), 400, /failed on-chain/)
  const unsigned = chain.land(r, { keys: [{ address: r.maker, signer: false }, { address: r.pool, signer: false }, { address: DBC, signer: false }] })
  await rejects(verifyCreateTx(chain.conn, r, unsigned), 400, /not signed by the maker/)
  await verifyCreateTx(chain.conn, r, chain.land(r))
})

test('findCreateSignature returns the oldest successful signature', async () => {
  const chain = fakeChain()
  const pool = record().pool
  chain.history.set(pool, [
    { signature: 'newest', err: null },
    { signature: 'create', err: null },
    { signature: 'failed-first', err: { InstructionError: [0, 'x'] } },
  ])
  assert.equal(await findCreateSignature(chain.conn, pool), 'create')
  assert.equal(await findCreateSignature(chain.conn, record().pool), null)
})

test('reconcile lists landed pools, expires dead ones after the grace period, keeps fresh ones', async () => {
  const chain = fakeChain()
  const now = Date.now()
  const landed = record()
  const dead = record()
  const fresh = record()
  savePending(landed, now - 60 * 60_000)
  savePending(dead, now - 60 * 60_000)
  savePending(fresh, now - 1000)
  chain.land(landed)
  const result = await reconcilePending(chain.conn, { now })
  assert.deepEqual(result.listed, [landed.pool])
  assert.deepEqual(result.expired, [dead.pool])
  assert.deepEqual(result.waiting, [fresh.pool])
  assert.deepEqual(result.failed, [])
  assert.ok(getCampaign(landed.pool)?.createSignature)
  assert.equal(getPending(dead.pool), undefined)
  assert.ok(getPending(fresh.pool))
})
