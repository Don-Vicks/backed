// Redemptions: a backer gives shipping details first, then burns 1+ whole voucher in a transaction
// whose memo names that pending redemption. The server records the order only after checking that
// burn on-chain, so a burn can only ever be claimed for the details its owner signed for.
import fs from 'fs'
import path from 'path'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { Connection, PublicKey } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { DAMM_V2_PROGRAM_ID, DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { getNetwork, type NetworkName } from './network'
import { repoRoot } from './paths'
import { keysDir } from './wallets'
import { ConfigError } from './origin'
import { VOUCHER_DECIMALS } from './engine'
import { MEMO_PROGRAM_ID, REDEEM_MEMO_PREFIX, buildRedeemTx, dbcClient } from './chain'
import { getCampaign, writeFileAtomic, type CampaignRecord } from './store'
import { HttpError } from './errors'

export type Shipping = { name: string; email: string; address: string; country: string }
// Shipping details at rest: AES-256-GCM under SHIPPING_ENCRYPTION_KEY, bound to the pool and wallet.
export type SealedShipping = { v: 1; iv: string; tag: string; data: string }

// Built for a wallet, not yet burned (or burned, but the confirm never arrived).
export type PendingRedemption = { id: string; pool: string; wallet: string; units: number; shipping: SealedShipping; createdAt: string }
// An order. Older records have no id and plain shipping; shipping is null once the maker marks it shipped.
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
// What the maker sees: shipping opened (null once shipped, or when it cannot be decrypted).
export type RedemptionView = Omit<Redemption, 'shipping'> & { shipping: Shipping | null; unreadable?: true }

const UNIT = BigInt(10 ** VOUCHER_DECIMALS)

// --- Shipping encryption --------------------------------------------------------------------------

const KEY_HELP = 'SHIPPING_ENCRYPTION_KEY must be 32 bytes, as 64 hex characters or base64 (openssl rand -hex 32)'

function parseShippingKey(raw: string): Buffer {
  const text = raw.trim()
  const bytes = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, 'hex') : Buffer.from(text, 'base64')
  if (bytes.length !== 32) throw new ConfigError(KEY_HELP)
  return bytes
}

// For /api/health: a key that is set must parse, and mainnet must have one. Reads no file.
export function checkShippingKey(env: NodeJS.ProcessEnv = process.env, network: NetworkName = getNetwork().name) {
  const raw = env.SHIPPING_ENCRYPTION_KEY?.trim()
  if (raw) parseShippingKey(raw)
  else if (network === 'mainnet') throw new ConfigError('SHIPPING_ENCRYPTION_KEY must be set on mainnet')
}

// The key from the environment. Off mainnet, without one, a key is generated once into keys/<network>/
// next to the other local keys, so a dev server works out of the box. A deployed server sets the
// variable: a lost key makes every stored address unreadable.
export function shippingKey(): Buffer {
  checkShippingKey()
  const raw = process.env.SHIPPING_ENCRYPTION_KEY?.trim()
  if (raw) return parseShippingKey(raw)
  const file = path.join(keysDir(), 'shipping-key')
  if (!fs.existsSync(file)) {
    fs.mkdirSync(keysDir(), { recursive: true })
    try {
      fs.writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e // another request wrote it first
    }
  }
  return parseShippingKey(fs.readFileSync(file, 'utf8'))
}

const aad = (pool: string, wallet: string) => Buffer.from(`${pool}:${wallet}`)

export function sealShipping(shipping: Shipping, pool: string, wallet: string, key = shippingKey()): SealedShipping {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(aad(pool, wallet))
  const data = Buffer.concat([cipher.update(JSON.stringify(shipping), 'utf8'), cipher.final()])
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
}

// Throws when the key is wrong or the record was altered (or moved to another pool or wallet).
export function openShipping(stored: SealedShipping | Shipping | null, pool: string, wallet: string, key = shippingKey()): Shipping | null {
  if (!stored) return null
  if (!('v' in stored)) return stored // written before shipping details were encrypted
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(stored.iv, 'base64')).setAAD(aad(pool, wallet))
  decipher.setAuthTag(Buffer.from(stored.tag, 'base64'))
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8'))
}

// --- Storage: one JSON file per network for orders, one for pending redemptions -------------------

const redemptionsPath = () => path.join(repoRoot(), 'data', `redemptions.${getNetwork().name}.json`)
const readAll = (): Redemption[] => (fs.existsSync(redemptionsPath()) ? JSON.parse(fs.readFileSync(redemptionsPath(), 'utf8')) : [])

export function listRedemptions(pool: string): Redemption[] {
  return readAll().filter((r) => r.pool === pool)
}

export function getRedemption(id: string): Redemption | undefined {
  return readAll().find((r) => r.id === id)
}

export function saveRedemption(r: Redemption) {
  const all = readAll()
  if (all.some((x) => x.signature === r.signature || (r.id && x.id === r.id))) throw new HttpError('This redemption was already submitted', 409)
  writeFileAtomic(redemptionsPath(), JSON.stringify([r, ...all], null, 2))
}

// The maker shipped it: the record stays (units, burn, dates) but the shipping details are deleted.
// Returns false when the pool has no such order.
export function markRedemptionShipped(pool: string, signature: string, now = new Date()): boolean {
  const all = readAll()
  const r = all.find((x) => x.pool === pool && x.signature === signature)
  if (!r) return false
  r.shippedAt ??= now.toISOString()
  r.shipping = null
  writeFileAtomic(redemptionsPath(), JSON.stringify(all, null, 2))
  return true
}

// The maker's orders with shipping details opened. A record that does not decrypt (a changed key) is
// listed without them rather than failing the whole list.
export function listRedemptionViews(pool: string): RedemptionView[] {
  const rows = listRedemptions(pool)
  const key = rows.some((r) => r.shipping && 'v' in r.shipping) ? shippingKey() : undefined
  return rows.map((r) => {
    try {
      return { ...r, shipping: openShipping(r.shipping, r.pool, r.wallet, key) }
    } catch {
      return { ...r, shipping: null, unreadable: true as const }
    }
  })
}

// Pending rows are kept long enough to recover a burn whose confirm never arrived, and capped so a
// flood of prepares cannot fill the disk (the oldest go first).
export const PENDING_REDEMPTION_RETENTION_MS = 30 * 24 * 60 * 60_000
export const MAX_PENDING_REDEMPTIONS = 5000
const pendingRedemptionsPath = () => path.join(repoRoot(), 'data', `pending-redemptions.${getNetwork().name}.json`)
const readPendingRedemptions = (): PendingRedemption[] =>
  fs.existsSync(pendingRedemptionsPath()) ? JSON.parse(fs.readFileSync(pendingRedemptionsPath(), 'utf8')) : []

export function savePendingRedemption(p: PendingRedemption, now = Date.now()) {
  const kept = readPendingRedemptions().filter((x) => x.id !== p.id && now - Date.parse(x.createdAt) <= PENDING_REDEMPTION_RETENTION_MS)
  writeFileAtomic(pendingRedemptionsPath(), JSON.stringify([p, ...kept].slice(0, MAX_PENDING_REDEMPTIONS)))
}

export function getPendingRedemption(id: string): PendingRedemption | undefined {
  return readPendingRedemptions().find((p) => p.id === id)
}

export function listPendingRedemptions(pool: string, wallet: string): PendingRedemption[] {
  return readPendingRedemptions().filter((p) => p.pool === pool && p.wallet === wallet)
}

export function countPendingRedemptions(pool: string, wallet: string, sinceMs: number): number {
  return listPendingRedemptions(pool, wallet).filter((p) => Date.parse(p.createdAt) >= sinceMs).length
}

export function removePendingRedemption(id: string) {
  const all = readPendingRedemptions()
  if (!all.some((p) => p.id === id)) return
  writeFileAtomic(pendingRedemptionsPath(), JSON.stringify(all.filter((p) => p.id !== id)))
}

// --- The flow: prepare, burn, confirm (and recover) -----------------------------------------------

// A wallet may start this many redemptions per window (a blockhash's life and some): enough for
// retries, not for filling the pending file in someone else's name.
export const OPEN_REDEMPTIONS = { max: 5, windowMs: 2 * 60_000 }

export const newRedemptionId = () => randomBytes(12).toString('base64url') // 16 characters

// Checks that the campaign has graduated, the wallet is not the pool's creator and holds the vouchers,
// then stores the pending redemption with its shipping sealed. Returns it with the burn transaction
// (unsigned, no blockhash) whose memo names it.
export async function prepareRedemption(connection: Connection, record: CampaignRecord, wallet: PublicKey, shipping: Shipping, units = 1, now = Date.now()) {
  const virtualPool = await dbcClient(connection).state.getPool(new PublicKey(record.pool))
  if (!virtualPool) throw new HttpError('Campaign pool not found', 404)
  if (Number(virtualPool.poolState.isMigrated) !== 1) throw new HttpError('Redemptions open once the campaign graduates', 409)
  // The maker's vouchers come back from the resale pool when production funds unlock; they are not orders.
  if (virtualPool.poolState.creator.equals(wallet)) throw new HttpError('The maker’s own vouchers can’t be redeemed as orders', 409)
  const baseMint = new PublicKey(record.baseMint)
  const account = await getAccount(connection, getAssociatedTokenAddressSync(baseMint, wallet)).catch(() => null)
  if (!account || account.amount < BigInt(units) * UNIT) throw new HttpError(`You need ${units} whole voucher${units === 1 ? '' : 's'} to redeem`, 400)
  if (countPendingRedemptions(record.pool, wallet.toBase58(), now - OPEN_REDEMPTIONS.windowMs) >= OPEN_REDEMPTIONS.max) {
    throw new HttpError('You just started several redemptions. Finish one, or wait a minute and try again.', 429)
  }
  const pending: PendingRedemption = {
    id: newRedemptionId(),
    pool: record.pool,
    wallet: wallet.toBase58(),
    units,
    shipping: sealShipping(shipping, record.pool, wallet.toBase58()),
    createdAt: new Date(now).toISOString(),
  }
  savePendingRedemption(pending, now)
  return { pending, tx: buildRedeemTx(wallet, baseMint, pending.id, units) }
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

// Records the order for a pending redemption once its burn checks out. Safe to repeat: the same burn
// again answers with the order already recorded.
export async function confirmRedemption(connection: Connection, id: string, signature: string, now = new Date()) {
  const done = getRedemption(id)
  if (done) {
    if (done.signature !== signature) throw new HttpError('This redemption was already confirmed with another burn', 409)
    return { redemption: done, already: true }
  }
  const pending = getPendingRedemption(id)
  if (!pending) throw new HttpError('Redemption not found. It may have expired; start again.', 404)
  const record = getCampaign(pending.pool)
  if (!record) throw new HttpError('Campaign not found', 404)
  const virtualPool = await dbcClient(connection).state.getPool(new PublicKey(record.pool))
  const units = await verifyRedeemBurn(connection, record, pending, signature, virtualPool?.poolState.creator ?? null)
  const redemption: Redemption = { id, pool: pending.pool, signature, wallet: pending.wallet, units, shipping: pending.shipping, createdAt: now.toISOString() }
  saveRedemption(redemption)
  removePendingRedemption(id)
  return { redemption, already: false }
}

export type UnfinishedRedemption = { id: string; signature: string; units: number; createdAt: string }

// This wallet's pending redemptions whose burn landed but was never confirmed (a closed tab, a lost
// connection), found by their memo among the voucher account's recent signatures. The caller confirms
// each with confirmRedemption, which checks the burn in full.
export async function findUnfinishedRedemptions(connection: Connection, record: CampaignRecord, wallet: PublicKey): Promise<UnfinishedRedemption[]> {
  const pending = listPendingRedemptions(record.pool, wallet.toBase58())
  if (pending.length === 0) return []
  const byMemo = new Map(pending.map((p) => [REDEEM_MEMO_PREFIX + p.id, p]))
  const ata = getAssociatedTokenAddressSync(new PublicKey(record.baseMint), wallet)
  const sigs = await connection.getSignaturesForAddress(ata, { limit: 200 }, 'confirmed')
  const found: UnfinishedRedemption[] = []
  for (const s of sigs) {
    if (s.err || !s.memo) continue
    // The RPC lists a transaction's memos as "[len] text; [len] text".
    for (const [, text] of s.memo.matchAll(/\[\d+\] ([^;]*)/g)) {
      const p = byMemo.get(text.trim())
      if (p && !found.some((f) => f.id === p.id)) found.push({ id: p.id, signature: s.signature, units: p.units, createdAt: p.createdAt })
    }
  }
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
