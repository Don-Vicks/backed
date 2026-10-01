// Listing: a campaign built by POST /api/campaigns sits in the pending table until its pool exists
// on-chain and the create transaction checks out; then it is listed. The confirm route, the reconcile
// script, POST /api/admin/reconcile and the server's background job all go through here.
import bs58 from 'bs58'
import { Connection, PublicKey } from '@solana/web3.js'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { HttpError } from './errors'
import { expirePending, getCampaign, getPending, listPending, promotePending, type CampaignRecord } from './store'

// status: the HTTP status the web app returns; retry: the client should try again shortly.
export class ListingError extends HttpError {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly retry = false) {
    super(message, status)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DBC = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()

export async function poolExists(connection: Connection, pool: string): Promise<boolean> {
  const info = await connection.getAccountInfo(new PublicKey(pool), 'confirmed')
  return !!info && info.owner.toBase58() === DBC
}

// The pool's oldest successful transaction is the one that created it. One page (1000 signatures)
// covers a pool that is at most a day old; the reconcile job may look further.
export async function findCreateSignature(connection: Connection, pool: string, maxPages = 1): Promise<string | null> {
  let before: string | undefined
  let oldest: string | null = null
  for (let page = 0; page < maxPages; page++) {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(pool), { before, limit: 1000 }, 'confirmed')
    for (const s of sigs) if (!s.err) oldest = s.signature
    if (sigs.length < 1000) return oldest
    before = sigs[sigs.length - 1].signature
  }
  return oldest
}

function isSignature(signature: string) {
  try {
    return bs58.decode(signature).length === 64
  } catch {
    return false
  }
}

// The transaction must have succeeded, touched the pool through the DBC program and be signed by the maker.
export async function verifyCreateTx(connection: Connection, record: CampaignRecord, signature: string, waitMs = 0): Promise<void> {
  if (!isSignature(signature)) throw new ListingError('signature is not a transaction signature', 400)
  const deadline = Date.now() + waitMs
  let tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  while (!tx && Date.now() < deadline) {
    await sleep(1000)
    tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  }
  if (!tx) throw new ListingError('Create transaction not found yet; try again in a few seconds', 409, true)
  if (tx.meta?.err) throw new ListingError('The create transaction failed on-chain', 400)
  const keys = tx.transaction.message.accountKeys
  const has = (address: string, signer = false) => keys.some((k) => k.pubkey.toBase58() === address && (!signer || k.signer))
  if (!has(record.pool) || !has(DBC)) throw new ListingError('That transaction did not create this campaign', 400)
  if (!has(record.maker, true)) throw new ListingError('The create transaction is not signed by the maker', 400)
}

// Concurrent callers with the same key share one run (the confirm route takes no credentials, so
// parallel requests must not multiply RPC calls).
const inflight: Map<string, Promise<unknown>> = ((globalThis as { __preorderListing?: Map<string, Promise<unknown>> }).__preorderListing ??= new Map())
function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const started = run().finally(() => inflight.delete(key))
  inflight.set(key, started)
  return started
}

// Polls once a second until the pool exists or the deadline passes; one poll per pool however many wait.
function waitForPool(connection: Connection, pool: string, waitMs: number): Promise<boolean> {
  return singleFlight(`pool:${pool}`, async () => {
    const deadline = Date.now() + waitMs
    while (!(await poolExists(connection, pool))) {
      if (Date.now() >= deadline) return false
      await sleep(1000)
    }
    return true
  })
}

// Idempotent: a listed campaign returns as is. Otherwise waits up to waitMs for the pool to appear
// (the server's RPC can lag the wallet's), verifies the create transaction, then lists it and drops
// the pending row. The client's signature is only a hint: one the RPC does not know (or that failed)
// is replaced by the pool's create transaction found on-chain (maxPages of signatures), so a made-up
// signature costs a few calls and never a poll.
export function confirmListing(
  connection: Connection,
  pool: string,
  signature?: string,
  { waitMs = 15_000, maxPages = 1 }: { waitMs?: number; maxPages?: number } = {},
): Promise<{ record: CampaignRecord; alreadyListed: boolean }> {
  return singleFlight(`confirm:${pool}:${signature ?? ''}`, async () => {
    const listed = getCampaign(pool)
    if (listed) return { record: listed, alreadyListed: true }
    const pending = getPending(pool)
    if (!pending) throw new ListingError('Unknown campaign', 404)
    if (signature && !isSignature(signature)) throw new ListingError('signature is not a transaction signature', 400)
    const deadline = Date.now() + waitMs
    if (!(await waitForPool(connection, pool, waitMs))) {
      throw new ListingError('Pool not found on-chain yet; try again in a few seconds', 409, true)
    }
    let sig = signature
    if (sig) {
      const status = (await connection.getSignatureStatuses([sig])).value[0]
      if (!status || status.err) sig = undefined
    }
    sig ||= (await findCreateSignature(connection, pool, maxPages)) ?? undefined
    if (!sig) throw new ListingError('Create transaction not found yet; try again in a few seconds', 409, true)
    await verifyCreateTx(connection, pending, sig, Math.max(0, deadline - Date.now()))
    // Another run (a different signature, the reconcile job) may have listed it meanwhile.
    const alreadyListed = !!getCampaign(pool)
    const record = promotePending(pool, sig)
    if (!record) throw new ListingError('Unknown campaign', 404)
    return { record, alreadyListed }
  })
}

// A pending pool that is not on-chain this long after its build never will be: the create
// transaction's blockhash expired long before.
export const PENDING_GRACE_MS = 10 * 60_000

export type ReconcileResult = { listed: string[]; expired: string[]; waiting: string[]; failed: { pool: string; error: string }[] }

// Lists pending campaigns whose pool landed (even if the browser never confirmed) and expires the
// ones that never will.
export async function reconcilePending(connection: Connection, { graceMs = PENDING_GRACE_MS, now = Date.now() } = {}): Promise<ReconcileResult> {
  const result: ReconcileResult = { listed: [], expired: [], waiting: [], failed: [] }
  for (const { record, createdAtMs } of listPending()) {
    try {
      if (await poolExists(connection, record.pool)) {
        await confirmListing(connection, record.pool, undefined, { waitMs: 0, maxPages: 10 })
        result.listed.push(record.pool)
      } else if (now - createdAtMs > graceMs) {
        expirePending(record.pool)
        result.expired.push(record.pool)
      } else {
        result.waiting.push(record.pool)
      }
    } catch (e) {
      if (e instanceof ListingError && e.retry) result.waiting.push(record.pool)
      else result.failed.push({ pool: record.pool, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
