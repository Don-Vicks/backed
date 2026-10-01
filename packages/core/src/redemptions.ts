// Redemptions: a backer burns 1+ whole voucher on-chain, then submits shipping details off-chain.
// The server only records a redemption after checking the burn itself on-chain.
// Shipping details are stored sealed (AES-256-GCM, seal.ts) and only opened for the maker.
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { Connection, PublicKey } from '@solana/web3.js'
import { VOUCHER_DECIMALS } from './engine'
import { db, redemptionAad } from './db'
import { openJsonAny, sealJson, shippingKeys } from './seal'
import type { CampaignRecord } from './store'

export type Shipping = { name: string; email: string; address: string; country: string }
export type Redemption = { pool: string; signature: string; wallet: string; units: number; shipping: Shipping; createdAt: string }

type RedemptionRow = { signature: string; pool: string; wallet: string; units: number; created_at: string; shipping_ct: string }

// A listed redemption whose shipping details no key opens (SHIPPING_KEY changed without
// SHIPPING_KEY_PREVIOUS) comes back with shipping: null and an error; the other rows still show.
export type ListedRedemption = Omit<Redemption, 'shipping'> & { shipping: Shipping | null; error?: string }

export function listRedemptions(pool: string): ListedRedemption[] {
  const rows = db().prepare('SELECT * FROM redemptions WHERE pool = ? ORDER BY created_at DESC, rowid DESC').all(pool) as RedemptionRow[]
  const keys = shippingKeys()
  return rows.map((r) => {
    const base = { pool: r.pool, signature: r.signature, wallet: r.wallet, units: r.units, createdAt: r.created_at }
    try {
      return { ...base, shipping: openJsonAny<Shipping>(r.shipping_ct, redemptionAad(r.signature), keys) }
    } catch (e) {
      return { ...base, shipping: null, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

// Returns the number of whole vouchers the wallet burned in this transaction, or throws.
export async function verifyBurn(connection: Connection, record: CampaignRecord, signature: string, wallet: PublicKey): Promise<number> {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' })
  if (!tx) throw new Error('Burn transaction not found yet; try again in a few seconds')
  if (tx.meta?.err) throw new Error('Burn transaction failed on-chain')
  let burned = BigInt(0)
  for (const ix of tx.transaction.message.instructions) {
    if (!('parsed' in ix) || ix.program !== 'spl-token') continue
    const { type, info } = ix.parsed as { type: string; info: Record<string, any> }
    if ((type === 'burn' || type === 'burnChecked') && info.mint === record.baseMint && info.authority === wallet.toBase58()) {
      burned += BigInt(info.amount ?? info.tokenAmount?.amount ?? 0)
    }
  }
  const units = Number(burned / BigInt(10 ** VOUCHER_DECIMALS))
  if (units < 1) throw new Error('That transaction does not burn a whole voucher from your wallet for this campaign')
  return units
}

// One redemption per burn signature (the primary key), so a burn can never be claimed twice.
export function saveRedemption(r: Redemption) {
  const sealed = sealJson(r.shipping, redemptionAad(r.signature))
  try {
    db()
      .prepare('INSERT INTO redemptions (signature, pool, wallet, units, created_at, shipping_ct) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.signature, r.pool, r.wallet, r.units, r.createdAt, sealed)
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: redemptions\.signature/.test(e.message)) throw new Error('This redemption was already submitted')
    throw e
  }
}

// Maker sign-in: the wallet signs ordersMessage(), a short, time-stamped message; valid for 10 minutes.
export { ordersMessage } from './messages'

export function verifyWalletMessage(message: string, signatureBase58: string, wallet: PublicKey, maxAgeMs = 10 * 60_000) {
  const issued = /Issued at: (.+)$/.exec(message)?.[1]
  if (!issued || Math.abs(Date.now() - Date.parse(issued)) > maxAgeMs) throw new Error('Sign-in expired; sign again')
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signatureBase58), wallet.toBytes())
  if (!ok) throw new Error('Signature does not match the wallet')
}
