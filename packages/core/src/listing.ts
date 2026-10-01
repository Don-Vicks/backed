// Listing: a campaign built by POST /api/campaigns sits in the pending table until its pool exists
// on-chain and the create transaction checks out; then it is listed. The confirm route, the reconcile
// script, POST /api/admin/reconcile and the server's background job all go through here.
import bs58 from 'bs58'
import { Connection, PublicKey } from '@solana/web3.js'
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { deletePending, getCampaign, getPending, listPending, promotePending, type CampaignRecord } from './store'

// status: the HTTP status the web app returns; retry: the client should try again shortly.
export class ListingError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly retry = false) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DBC = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()

export async function poolExists(connection: Connection, pool: string): Promise<boolean> {
  const info = await connection.getAccountInfo(new PublicKey(pool), 'confirmed')
  return !!info && info.owner.toBase58() === DBC
}

// The pool's oldest successful transaction is the one that created it.
export async function findCreateSignature(connection: Connection, pool: string, maxPages = 10): Promise<string | null> {
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

// The transaction must have succeeded, touched the pool through the DBC program and be signed by the maker.
export async function verifyCreateTx(connection: Connection, record: CampaignRecord, signature: string, waitMs = 0): Promise<void> {
  let bytes: Uint8Array
  try {
    bytes = bs58.decode(signature)
  } catch {
    bytes = new Uint8Array()
  }
  if (bytes.length !== 64) throw new ListingError('signature is not a transaction signature', 400)
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

// Idempotent: a listed campaign returns as is. Otherwise waits up to waitMs for the pool to appear
// (the server's RPC can lag the wallet's), verifies the create transaction (found on-chain when the
// client has no signature), then lists it and drops the pending row.
export async function confirmListing(
  connection: Connection,
  pool: string,
  signature?: string,
  { waitMs = 15_000 }: { waitMs?: number } = {},
): Promise<{ record: CampaignRecord; alreadyListed: boolean }> {
  const listed = getCampaign(pool)
  if (listed) return { record: listed, alreadyListed: true }
  const pending = getPending(pool)
  if (!pending) throw new ListingError('Unknown campaign', 404)
  const deadline = Date.now() + waitMs
  while (!(await poolExists(connection, pool))) {
    if (Date.now() >= deadline) throw new ListingError('Pool not found on-chain yet; try again in a few seconds', 409, true)
    await sleep(1000)
  }
  const sig = signature || (await findCreateSignature(connection, pool))
  if (!sig) throw new ListingError('Create transaction not found yet; try again in a few seconds', 409, true)
  await verifyCreateTx(connection, pending, sig, Math.max(0, deadline - Date.now()))
  const record = promotePending(pool, sig)
  if (!record) throw new ListingError('Unknown campaign', 404)
  return { record, alreadyListed: false }
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
        await confirmListing(connection, record.pool, undefined, { waitMs: 0 })
        result.listed.push(record.pool)
      } else if (now - createdAtMs > graceMs) {
        deletePending(record.pool)
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
