import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { closeDb } from '../db'
import { PENDING_TTL_MS, getCampaign, getMetadata, getPending, listCampaigns, saveMetadata, savePending, type CampaignRecord } from '../store'
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
  const calls = { getAccountInfo: 0, getSignaturesForAddress: 0, getParsedTransaction: 0 }
  const conn = {
    getAccountInfo: async (key: PublicKey) => {
      calls.getAccountInfo++
      return pools.has(key.toBase58()) ? { owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID } : null
    },
    getSignatureStatuses: async (sigs: string[]) => ({
      value: sigs.map((s) => (txs.has(s) ? { err: txs.get(s)!.err ?? null, confirmationStatus: 'confirmed' } : null)),
    }),
    getParsedTransaction: async (s: string) => {
      calls.getParsedTransaction++
      const tx = txs.get(s)
      if (!tx) return null
      return {
        meta: { err: tx.err ?? null },
        transaction: { message: { accountKeys: tx.keys.map((k) => ({ pubkey: new PublicKey(k.address), signer: k.signer })) } },
      }
    },
    getSignaturesForAddress: async (key: PublicKey) => {
      calls.getSignaturesForAddress++
      return history.get(key.toBase58()) ?? []
    },
  }
  // A create transaction: lands the pool, signed by the maker.
  const land = (r: CampaignRecord, over: Partial<FakeTx> = {}) => {
    const s = sig()
    pools.add(r.pool)
    txs.set(s, { keys: [{ address: r.maker, signer: true }, { address: r.pool, signer: false }, { address: DBC, signer: false }], ...over })
    history.set(r.pool, [{ signature: sig(), err: null }, { signature: s, err: null }])
    return s
  }
  return { conn: conn as unknown as Connection, land, pools, txs, history, calls }
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
  const other = record()
  const foreign = chain.land(other)
  await rejects(confirmListing(chain.conn, r.pool, foreign, { waitMs: 0 }), 400, /did not create this campaign/)
  assert.equal(getCampaign(r.pool), undefined)
})

test('a junk signature is rejected before any wait; an unknown one falls back to the create tx on-chain', async () => {
  const chain = fakeChain()
  const r = record()
  savePending(r)
  await rejects(confirmListing(chain.conn, r.pool, 'junk', { waitMs: 5000 }), 400, /not a transaction signature/)
  assert.equal(chain.calls.getAccountInfo, 0)
  const s = chain.land(r)
  const listed = await confirmListing(chain.conn, r.pool, sig(), { waitMs: 5000 })
  assert.equal(listed.record.createSignature, s, 'listed with the real create signature')
  assert.equal(chain.calls.getParsedTransaction, 1, 'the made-up signature is never polled')
})

test('concurrent confirms of one pool share a single wait', async () => {
  const chain = fakeChain()
  const r = record()
  savePending(r)
  let s = ''
  setTimeout(() => (s = chain.land(r)), 1500)
  const results = await Promise.all([
    confirmListing(chain.conn, r.pool, undefined, { waitMs: 5000 }),
    confirmListing(chain.conn, r.pool, undefined, { waitMs: 5000 }),
    confirmListing(chain.conn, r.pool, sig(), { waitMs: 5000 }),
    confirmListing(chain.conn, r.pool, sig(), { waitMs: 5000 }),
  ])
  assert.ok(results.every((x) => x.record.createSignature === s))
  assert.ok(chain.calls.getAccountInfo <= 4, `one poll for all waiters (got ${chain.calls.getAccountInfo} calls)`)
  assert.equal(results.filter((x) => !x.alreadyListed).length >= 1, true)
  assert.equal(listCampaigns().length, 1)
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

test('reconcile drops the token metadata of a build that never landed', async () => {
  const chain = fakeChain()
  const now = Date.now()
  const dead = record()
  dead.campaign = { ...dead.campaign, uri: 'https://backed.test/m/deadmeta' }
  saveMetadata('deadmeta', { name: 'Mug', symbol: 'MUG', description: '', image: '' })
  savePending(dead, now - 60 * 60_000)
  const result = await reconcilePending(chain.conn, { now })
  assert.deepEqual(result.expired, [dead.pool])
  assert.equal(getMetadata('deadmeta'), undefined)
})

test('reconcile keeps a split create whose config landed without its pool resumable until the pending TTL', async () => {
  const chain = fakeChain()
  const now = Date.now()
  const stopped = record()
  stopped.campaign = { ...stopped.campaign, uri: 'https://backed.test/m/stoppedmeta' }
  saveMetadata('stoppedmeta', { name: 'Mug', symbol: 'MUG', description: '', image: '' })
  savePending(stopped, now - 60 * 60_000)
  chain.pools.add(stopped.config) // createConfig landed, createPool did not
  const result = await reconcilePending(chain.conn, { now })
  assert.deepEqual(result.waiting, [stopped.pool])
  assert.deepEqual(result.expired, [])
  assert.ok(getPending(stopped.pool), 'still there for POST /api/campaigns/<pool>/resume')
  assert.ok(getMetadata('stoppedmeta'), 'the resumed pool reuses the metadata')

  const later = await reconcilePending(chain.conn, { now: now + PENDING_TTL_MS })
  assert.deepEqual(later.expired, [stopped.pool], 'expired once the pending TTL is up')
  assert.equal(getMetadata('stoppedmeta'), undefined)
})
