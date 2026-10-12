// Redemptions: the server builds a burn of 1+ whole voucher whose memo names a new redemption id; the
// backer's wallet signs it and hands it back with the shipping details. The server keeps the details
// (as a pending redemption) only for a burn its owner signed, sends it, and records the order once the
// burn checks out on-chain. A burn can only ever be claimed for the details sent with it.
// Orders and pending redemptions live in the durable store (db.ts); shipping details are sealed
// (AES-256-GCM, seal.ts) to the burn's signature and only opened for the maker.
import { randomBytes } from 'crypto'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionExpiredBlockheightExceededError, TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DAMM_V2_PROGRAM_ID, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { VOUCHER_DECIMALS } from './engine'
import { MEMO_PROGRAM_ID, REDEEM_MEMO_PREFIX, buildRedeemTx, dbcClient } from './chain'
import { db, redemptionAad, transaction } from './db'
import { openJsonAny, sealJson, shippingKeys } from './seal'
import { getCampaign, type CampaignRecord } from './store'
import { HttpError } from './errors'
import { friendlyTxError } from './tx-errors'
import { SEALED_PREFIX } from './inbox-crypto'

export type Shipping = { name: string; email: string; address: string; country: string }
// Shipping details at rest: sealJson output (AES-256-GCM under SHIPPING_KEY), bound to the burn signature
// (redemptionAad), so a sealed value moved to another row does not open.
export type SealedShipping = string

// A burn its wallet signed, kept from just before the server sends it until its order is recorded or it
// is known not to have landed: the server sends and confirms in one request, so a row outlives that
// request only when the confirmation was lost (an RPC failure, a restart).
export type PendingRedemption = {
  id: string
  pool: string
  wallet: string
  units: number
  shipping: SealedShipping
  createdAt: string
  signature: string // the signed burn's
  lastValidBlockHeight: number // past this height a burn that has not landed never will
}
// An order. Orders recorded before memo-bound redemptions have no id. Saved with the shipping details
// sealed (a pending redemption's) or plain (sealed on save); null once the maker marks it shipped.
export type Redemption = {
  id?: string
  pool: string
  signature: string
  wallet: string
  units: number
  shipping: SealedShipping | Shipping | null
  createdAt: string
  shippedAt?: string
}
// What the maker sees: shipping opened. null once shipped, or when no configured key opens it
// (SHIPPING_KEY changed without SHIPPING_KEY_PREVIOUS), which sets unreadable and error; the other
// rows still show.
// `sealed`: details a backer sealed to the maker's inbox key (inbox-crypto.ts); the server cannot open
// them, so they go to the maker's browser as they are and shipping stays null here.
export type RedemptionView = Omit<Redemption, 'shipping'> & { shipping: Shipping | null; sealed?: string; unreadable?: true; error?: string }
export type ListedRedemption = RedemptionView

const UNIT = BigInt(10 ** VOUCHER_DECIMALS)

// Seals shipping details for the order (or pending redemption) of a burn signature.
export const sealShipping = (shipping: Shipping, signature: string, key?: Buffer): SealedShipping =>
  sealJson(shipping, redemptionAad(signature), key)

// --- Storage: orders and pending redemptions in the durable store ---------------------------------

type RedemptionRow = {
  signature: string
  id: string | null
  pool: string
  wallet: string
  units: number
  created_at: string
  shipping_ct: string | null
  shipped_at: string | null
}

const fromRow = (r: RedemptionRow): Redemption => ({
  ...(r.id ? { id: r.id } : {}),
  pool: r.pool,
  signature: r.signature,
  wallet: r.wallet,
  units: r.units,
  shipping: r.shipping_ct,
  createdAt: r.created_at,
  ...(r.shipped_at ? { shippedAt: r.shipped_at } : {}),
})

// The maker's orders, newest first, with shipping details opened.
export function listRedemptions(pool: string): RedemptionView[] {
  const rows = db().prepare('SELECT * FROM redemptions WHERE pool = ? ORDER BY created_at DESC, rowid DESC').all(pool) as RedemptionRow[]
  const keys = rows.some((r) => r.shipping_ct && !r.shipping_ct.startsWith(SEALED_PREFIX)) ? shippingKeys() : []
  return rows.map((r) => {
    const base = { ...fromRow(r), shipping: null }
    if (!r.shipping_ct) return base
    if (r.shipping_ct.startsWith(SEALED_PREFIX)) return { ...base, sealed: r.shipping_ct }
    try {
      return { ...base, shipping: openJsonAny<Shipping>(r.shipping_ct, redemptionAad(r.signature), keys) }
    } catch (e) {
      return { ...base, unreadable: true as const, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

export function getRedemption(id: string): Redemption | undefined {
  const row = db().prepare('SELECT * FROM redemptions WHERE id = ?').get(id) as RedemptionRow | undefined
  return row && fromRow(row)
}

// One order per burn signature and per redemption id, so a burn can never be claimed twice.
export function saveRedemption(r: Redemption) {
  const shipping = r.shipping === null || typeof r.shipping === 'string' ? r.shipping : sealShipping(r.shipping, r.signature)
  try {
    db()
      .prepare('INSERT INTO redemptions (signature, id, pool, wallet, units, created_at, shipping_ct, shipped_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.signature, r.id ?? null, r.pool, r.wallet, r.units, r.createdAt, shipping, r.shippedAt ?? null)
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: redemptions\.(signature|id)/.test(e.message)) {
      throw new HttpError('This redemption was already submitted', 409)
    }
    throw e
  }
}

// The maker shipped it: the record stays (units, burn, dates) but the shipping details are deleted.
// Returns false when the pool has no such order.
export function markRedemptionShipped(pool: string, signature: string, now = new Date()): boolean {
  const result = db()
    .prepare('UPDATE redemptions SET shipping_ct = NULL, shipped_at = COALESCE(shipped_at, ?) WHERE pool = ? AND signature = ?')
    .run(now.toISOString(), pool, signature)
  return Number(result.changes) > 0
}

// Pending rows are kept long enough to recover a burn whose confirm never arrived. The table is capped:
// when it is full, new redemptions wait (429) and no row younger than the retention is ever dropped,
// since it may be the only record of a burn. Each row needs a burn its wallet signed, a few at a time
// per wallet (MAX_OPEN_REDEMPTIONS), so filling it takes many funded wallets.
export const PENDING_REDEMPTION_RETENTION_MS = 30 * 24 * 60 * 60_000
export const MAX_PENDING_REDEMPTIONS = 5000

type PendingRedemptionRow = {
  id: string
  pool: string
  wallet: string
  units: number
  signature: string
  created_at: number
  last_valid_block_height: number
  shipping_ct: string
}

const pendingFromRow = (r: PendingRedemptionRow): PendingRedemption => ({
  id: r.id,
  pool: r.pool,
  wallet: r.wallet,
  units: r.units,
  shipping: r.shipping_ct,
  createdAt: new Date(r.created_at).toISOString(),
  signature: r.signature,
  lastValidBlockHeight: r.last_valid_block_height,
})

export function savePendingRedemption(p: PendingRedemption, now = Date.now()) {
  transaction((d) => {
    d.prepare('DELETE FROM pending_redemptions WHERE created_at < ?').run(now - PENDING_REDEMPTION_RETENTION_MS)
    const { n } = d.prepare('SELECT COUNT(*) AS n FROM pending_redemptions WHERE id != ?').get(p.id) as { n: number }
    if (n >= MAX_PENDING_REDEMPTIONS) throw new HttpError('Redemptions are busy right now. Try again in a few minutes.', 429)
    const createdAt = Date.parse(p.createdAt)
    d.prepare(
      `INSERT INTO pending_redemptions (id, pool, wallet, units, signature, created_at, last_valid_block_height, shipping_ct) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pool = excluded.pool, wallet = excluded.wallet, units = excluded.units, signature = excluded.signature,
         created_at = excluded.created_at, last_valid_block_height = excluded.last_valid_block_height, shipping_ct = excluded.shipping_ct`,
    ).run(p.id, p.pool, p.wallet, p.units, p.signature, Number.isFinite(createdAt) ? createdAt : now, p.lastValidBlockHeight, p.shipping)
  })
}

export function getPendingRedemption(id: string): PendingRedemption | undefined {
  const row = db().prepare('SELECT * FROM pending_redemptions WHERE id = ?').get(id) as PendingRedemptionRow | undefined
  return row && pendingFromRow(row)
}

export function listPendingRedemptions(pool: string, wallet: string): PendingRedemption[] {
  const rows = db().prepare('SELECT * FROM pending_redemptions WHERE pool = ? AND wallet = ? ORDER BY created_at DESC').all(pool, wallet) as PendingRedemptionRow[]
  return rows.map(pendingFromRow)
}

export function countPendingRedemptions(pool: string, wallet: string): number {
  return (db().prepare('SELECT COUNT(*) AS n FROM pending_redemptions WHERE pool = ? AND wallet = ?').get(pool, wallet) as { n: number }).n
}

export function removePendingRedemption(id: string) {
  db().prepare('DELETE FROM pending_redemptions WHERE id = ?').run(id)
}

// --- The flow: prepare, submit (sign, send, confirm) and recover -----------------------------------

// Pending rows one wallet may have open in a campaign: burns sent whose confirmation was lost. They
// clear as the page finishes them, so this only stops a wallet from filling the table.
export const MAX_OPEN_REDEMPTIONS = 5

export const newRedemptionId = () => randomBytes(12).toString('base64url') // 16 characters

// The campaign has graduated and the wallet is not the pool's creator (409 otherwise).
async function requireRedeemable(connection: Connection, record: CampaignRecord, wallet: PublicKey) {
  const virtualPool = await dbcClient(connection).state.getPool(new PublicKey(record.pool))
  if (!virtualPool) throw new HttpError('Campaign pool not found', 404)
  if (Number(virtualPool.poolState.isMigrated) !== 1) throw new HttpError('Redemptions open once the campaign graduates', 409)
  // The maker's vouchers come back from the resale pool when production funds unlock; they are not orders.
  if (virtualPool.poolState.creator.equals(wallet)) throw new HttpError('The maker’s own vouchers can’t be redeemed as orders', 409)
}

// Checks that the campaign has graduated, the wallet is not the pool's creator and holds the vouchers.
// Returns a new redemption id and the burn transaction (unsigned, no blockhash) whose memo names it.
// Nothing is stored: anyone may ask, for any wallet, and only the wallet's signature makes it count.
export async function prepareRedemption(connection: Connection, record: CampaignRecord, wallet: PublicKey, units = 1) {
  await requireRedeemable(connection, record, wallet)
  const baseMint = new PublicKey(record.baseMint)
  const account = await getAccount(connection, getAssociatedTokenAddressSync(baseMint, wallet)).catch(() => null)
  if (!account || account.amount < BigInt(units) * UNIT) throw new HttpError(`You need ${units} whole voucher${units === 1 ? '' : 's'} to redeem`, 400)
  const id = newRedemptionId()
  return { id, tx: buildRedeemTx(wallet, baseMint, id, units) }
}

// Instructions a signed burn may carry besides the redemption's own: the priority fee.
const FEE_PROGRAMS = [ComputeBudgetProgram.programId.toBase58()]

// A decoded instruction's keys carry the message's flags (the fee payer is writable everywhere), so a key
// only has to be at least the signer and writable the built one asked for.
const sameInstruction = (a: TransactionInstruction, b: TransactionInstruction) =>
  a.programId.equals(b.programId) &&
  a.data.equals(b.data) &&
  a.keys.length === b.keys.length &&
  a.keys.every((k, i) => k.pubkey.equals(b.keys[i].pubkey) && (k.isSigner || !b.keys[i].isSigner) && (k.isWritable || !b.keys[i].isWritable))

// A signed burn handed back for redemption `id`: one signature, its fee payer's, valid; and exactly the
// instructions buildRedeemTx makes for that wallet and id, plus priority-fee ones. Returns the wallet.
export function checkSignedRedeemTx(record: CampaignRecord, tx: Transaction, id: string, units = 1): PublicKey {
  const wallet = tx.feePayer
  if (!wallet || tx.signatures.length !== 1 || !tx.signatures[0].publicKey.equals(wallet) || !tx.verifySignatures(true)) {
    throw new HttpError('That transaction is not signed by its wallet', 400)
  }
  const expected = buildRedeemTx(wallet, new PublicKey(record.baseMint), id, units).instructions
  const own = tx.instructions.filter((ix) => !FEE_PROGRAMS.includes(ix.programId.toBase58()))
  if (own.length !== expected.length || !own.every((ix, i) => sameInstruction(ix, expected[i]))) {
    throw new HttpError('That is not the redemption transaction built for you; start again', 400)
  }
  return wallet
}

// 503: the burn was sent but its order is not known to be recorded; it may have landed. The page finds
// it again through findUnfinishedRedemptions. No other answer of submit is a 503.
const STILL_LANDING = 'Your burn was sent but isn’t confirmed yet. Your order is finished automatically once it lands; reload in a minute.'
const EXPIRED = 'That transaction has expired before it landed. Approve the new one.' // isExpiredTxError matches it

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Takes the burn the wallet signed for `id` with the shipping details, keeps them as a pending
// redemption, sends the burn and confirms it, then records the order. A 4xx, or an error that is not an
// HttpError, means nothing was burned (refused, failed simulation, expired, failed on-chain, an RPC
// failure before sending); a 503 means the burn may have landed, and the pending row lets
// findUnfinishedRedemptions finish it. Sending the same signed burn again is harmless.
// `shipping` is the plain details (sealed here under SHIPPING_KEY) or details the backer already sealed to
// the maker's inbox key, which the server keeps as they are.
export async function submitRedemption(connection: Connection, record: CampaignRecord, raw: Buffer, id: string, shipping: Shipping | string, now = new Date()) {
  let tx: Transaction
  try {
    tx = Transaction.from(raw)
  } catch {
    throw new HttpError('tx is not a transaction', 400)
  }
  const wallet = checkSignedRedeemTx(record, tx, id)
  const signature = bs58.encode(tx.signature!)
  const done = getRedemption(id)
  if (done) {
    if (done.signature !== signature) throw new HttpError('This redemption was already confirmed with another burn', 409)
    return { redemption: done, already: true }
  }
  let pending = getPendingRedemption(id)
  if (pending && pending.signature !== signature) throw new HttpError('This redemption was already sent with another burn', 409)
  if (!pending) {
    await requireRedeemable(connection, record, wallet)
    if (countPendingRedemptions(record.pool, wallet.toBase58()) >= MAX_OPEN_REDEMPTIONS) {
      throw new HttpError('You have redemptions that haven’t finished yet. Reload the page to finish them, then try again.', 429)
    }
    // The exact bytes, simulated first: a burn that would fail is never sent, and nothing is kept.
    const sim = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: true, commitment: 'confirmed' })
    const err = sim.value.err
    if (err === 'BlockhashNotFound') throw new HttpError(EXPIRED, 400)
    if (err && err !== 'AlreadyProcessed') {
      const message = `${JSON.stringify(err)} ${(sim.value.logs ?? []).join(' ')}`
      throw new HttpError(`The burn was not sent. ${friendlyTxError(message) ?? 'It would fail on-chain; nothing was burned.'}`, 400)
    }
    pending = {
      id,
      pool: record.pool,
      wallet: wallet.toBase58(),
      units: 1,
      shipping: typeof shipping === 'string' ? shipping : sealShipping(shipping, signature),
      createdAt: now.toISOString(),
      signature,
      // A blockhash that simulates is at most this many blocks from expiry.
      lastValidBlockHeight: (await connection.getBlockHeight('confirmed')) + 150,
    }
    savePendingRedemption(pending, now.getTime())
  }
  try {
    await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 })
    const result = await connection.confirmTransaction(
      { signature, blockhash: tx.recentBlockhash!, lastValidBlockHeight: pending.lastValidBlockHeight },
      'confirmed',
    )
    if (result.value.err) {
      removePendingRedemption(id)
      throw new HttpError(`The burn failed on-chain, so no voucher was used. ${friendlyTxError(JSON.stringify(result.value.err)) ?? 'Try again.'}`, 400)
    }
  } catch (e) {
    if (e instanceof HttpError) throw e
    if (!(e instanceof TransactionExpiredBlockheightExceededError)) throw new HttpError(STILL_LANDING, 503)
    const status = await connection
      .getSignatureStatuses([signature], { searchTransactionHistory: true })
      .then((r) => r.value[0], () => Promise.reject(new HttpError(STILL_LANDING, 503)))
    if (!status || status.err) {
      removePendingRedemption(id)
      throw new HttpError(status ? 'The burn failed on-chain, so no voucher was used. Try again.' : EXPIRED, 400)
    }
  }
  // Landed. The RPC may need a moment to return it in full.
  for (let attempt = 0; ; attempt++) {
    try {
      return await confirmRedemption(connection, id, signature, now)
    } catch (e) {
      if (!(e instanceof HttpError) || (e.status === 409 && attempt >= 3)) throw new HttpError(STILL_LANDING, 503)
      if (e.status !== 409) throw e
      await sleep(1000)
    }
  }
}

// Programs a redemption never calls: the curve and the resale pool.
const POOL_PROGRAMS = [DAMM_V2_PROGRAM_ID.toBase58(), DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()]

// The text of a memo instruction, parsed by the RPC or (should it not parse one) from its raw data.
function memoText(ix: { programId: PublicKey } & ({ parsed: unknown } | { data: string })): string | null {
  if (!ix.programId.equals(MEMO_PROGRAM_ID)) return null
  if ('parsed' in ix) return typeof ix.parsed === 'string' ? ix.parsed : null
  return Buffer.from(bs58.decode(ix.data)).toString('utf8')
}

// Returns the units burned for a pending redemption. The transaction must have succeeded, carry exactly
// one redeem memo, naming this redemption, and burn exactly its units of this campaign's vouchers from
// its wallet. It never counts if it calls the curve or the resale pool (a maker unlocking production
// funds burns the vouchers it gets back) or if the pool's on-chain creator signed it.
// Throws an HttpError for a burn that doesn't count; RPC failures propagate as they are.
export async function verifyRedeemBurn(
  connection: Connection,
  record: CampaignRecord,
  pending: PendingRedemption,
  signature: string,
  creator: PublicKey | null,
): Promise<number> {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  if (!tx) throw new HttpError('Burn transaction not found yet; try again in a few seconds', 409)
  if (tx.meta?.err) throw new HttpError('Burn transaction failed on-chain', 400)
  const top = tx.transaction.message.instructions
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions)
  if ([...top, ...inner].some((ix) => POOL_PROGRAMS.includes(ix.programId.toBase58()))) {
    throw new HttpError('That transaction trades or moves pool liquidity; it is not a redemption', 400)
  }
  if (creator && tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey.equals(creator))) {
    throw new HttpError('The campaign’s creator signed that transaction; it is not a redemption', 400)
  }
  const memos = top.map(memoText).filter((m): m is string => m !== null && m.startsWith(REDEEM_MEMO_PREFIX))
  if (memos.length !== 1 || memos[0] !== REDEEM_MEMO_PREFIX + pending.id) throw new HttpError('That burn was not made for this redemption', 400)
  let burned = BigInt(0)
  for (const ix of top) {
    if (!('parsed' in ix) || ix.program !== 'spl-token') continue
    const { type, info } = ix.parsed as { type: string; info: Record<string, any> }
    if ((type === 'burn' || type === 'burnChecked') && info.mint === record.baseMint && info.authority === pending.wallet) {
      burned += BigInt(info.amount ?? info.tokenAmount?.amount ?? 0)
    }
  }
  if (burned !== BigInt(pending.units) * UNIT) {
    throw new HttpError(`That transaction does not burn exactly ${pending.units} whole voucher${pending.units === 1 ? '' : 's'} from your wallet for this campaign`, 400)
  }
  return pending.units
}

// Records the order for a pending redemption once its burn (the one sent for it) checks out. Safe to
// repeat: the same burn again answers with the order already recorded. A burn that landed but can never
// count (400) drops the pending row, so it is not offered again.
export async function confirmRedemption(connection: Connection, id: string, signature: string, now = new Date()) {
  const done = getRedemption(id)
  if (done) {
    if (done.signature !== signature) throw new HttpError('This redemption was already confirmed with another burn', 409)
    return { redemption: done, already: true }
  }
  const pending = getPendingRedemption(id)
  if (!pending) throw new HttpError('Redemption not found. It may have expired; start again.', 404)
  if (pending.signature !== signature) throw new HttpError('That is not the burn sent for this redemption', 400)
  const record = getCampaign(pending.pool)
  if (!record) throw new HttpError('Campaign not found', 404)
  const virtualPool = await dbcClient(connection).state.getPool(new PublicKey(record.pool))
  let units: number
  try {
    units = await verifyRedeemBurn(connection, record, pending, signature, virtualPool?.poolState.creator ?? null)
  } catch (e) {
    if (e instanceof HttpError && e.status === 400) removePendingRedemption(id)
    throw e
  }
  const redemption: Redemption = { id, pool: pending.pool, signature, wallet: pending.wallet, units, shipping: pending.shipping, createdAt: now.toISOString() }
  transaction(() => {
    saveRedemption(redemption)
    removePendingRedemption(id)
  })
  return { redemption, already: false }
}

export type UnfinishedRedemption = { id: string; signature: string; units: number; createdAt: string }

// This wallet's pending redemptions whose burn landed but whose order was never recorded (the server
// lost the confirmation), by the status of the burn each one was sent with. The caller confirms each with
// confirmRedemption, which checks the burn in full. Rows whose burn failed, or expired without landing,
// are dropped here: nothing was burned for them.
export async function findUnfinishedRedemptions(connection: Connection, record: CampaignRecord, wallet: PublicKey): Promise<UnfinishedRedemption[]> {
  const pending = listPendingRedemptions(record.pool, wallet.toBase58())
  if (pending.length === 0) return []
  const statuses = (await connection.getSignatureStatuses(pending.map((p) => p.signature), { searchTransactionHistory: true })).value
  const height = statuses.some((s) => !s) ? await connection.getBlockHeight('confirmed') : 0
  const found: UnfinishedRedemption[] = []
  pending.forEach((p, i) => {
    const s = statuses[i]
    if (s?.err || (!s && height > p.lastValidBlockHeight)) removePendingRedemption(p.id)
    else if (s && s.confirmationStatus !== 'processed') found.push({ id: p.id, signature: p.signature, units: p.units, createdAt: p.createdAt })
  })
  return found
}
// --- Maker sign-in ---------------------------------------------------------------------------------

// The maker signs ordersMessage() for this site; it is good for a few minutes after its date.
export { ordersMessage } from './messages'
export const SIGN_IN_MAX_AGE_MS = 5 * 60_000
export const SIGN_IN_MAX_SKEW_MS = 30_000 // a wallet's clock may run a little ahead

// `expected` rebuilds the message for a date: the message must be exactly that text, dated within the
// last few minutes (not in the future), and signed by `wallet`.
export function verifyWalletMessage(message: string, signatureBase58: string, wallet: PublicKey, expected: (issuedAt: string) => string, now = Date.now()) {
  const issued = /\nIssued at: ([^\n]+)$/.exec(message)?.[1]
  if (!issued || message !== expected(issued)) throw new Error('That sign-in message is not for this page; sign again')
  const at = Date.parse(issued)
  if (!Number.isFinite(at)) throw new Error('That sign-in message has no valid date; sign again')
  if (at > now + SIGN_IN_MAX_SKEW_MS) throw new Error('That sign-in is dated in the future; check your device clock and sign again')
  if (now - at > SIGN_IN_MAX_AGE_MS) throw new Error('Sign-in expired; sign again')
  let ok = false
  try {
    ok = nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signatureBase58), wallet.toBytes())
  } catch {
    ok = false // not base58, or not 64 bytes
  }
  if (!ok) throw new Error('Signature does not match the wallet')
}
