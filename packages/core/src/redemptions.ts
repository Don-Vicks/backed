// Redemptions: a backer burns 1+ whole voucher on-chain, then submits shipping details off-chain.
// The server only records a redemption after checking the burn itself on-chain.
import fs from 'fs'
import path from 'path'
import bs58 from 'bs58'
import nacl from 'tweetnacl'
import { Connection, PublicKey } from '@solana/web3.js'
import { getNetwork } from './network'
import { repoRoot } from './paths'
import { VOUCHER_DECIMALS } from './engine'
import type { CampaignRecord } from './store'

export type Shipping = { name: string; email: string; address: string; country: string }
export type Redemption = { pool: string; signature: string; wallet: string; units: number; shipping: Shipping; createdAt: string }

const redemptionsPath = () => path.join(repoRoot(), 'data', `redemptions.${getNetwork().name}.json`)
const readAll = (): Redemption[] => (fs.existsSync(redemptionsPath()) ? JSON.parse(fs.readFileSync(redemptionsPath(), 'utf8')) : [])

export function listRedemptions(pool: string): Redemption[] {
  return readAll().filter((r) => r.pool === pool)
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

export function saveRedemption(r: Redemption) {
  const all = readAll()
  if (all.some((x) => x.signature === r.signature)) throw new Error('This redemption was already submitted')
  fs.mkdirSync(path.dirname(redemptionsPath()), { recursive: true })
  fs.writeFileSync(redemptionsPath(), JSON.stringify([r, ...all], null, 2))
}

// Maker sign-in: the wallet signs ordersMessage(), a short, time-stamped message; valid for 10 minutes.
export { ordersMessage } from './messages'

export function verifyWalletMessage(message: string, signatureBase58: string, wallet: PublicKey, maxAgeMs = 10 * 60_000) {
  const issued = /Issued at: (.+)$/.exec(message)?.[1]
  if (!issued || Math.abs(Date.now() - Date.parse(issued)) > maxAgeMs) throw new Error('Sign-in expired; sign again')
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signatureBase58), wallet.toBytes())
  if (!ok) throw new Error('Signature does not match the wallet')
}
