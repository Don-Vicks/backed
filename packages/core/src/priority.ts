// Priority fees for wallet-signed transactions. The price is the 75th percentile of recent fees paid on
// the accounts the transaction writes, clamped. Only a compute-unit price is added, never a limit: the
// SDK sets its own limit where it needs one (migrate asks for 600k).
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { getNetwork, type NetworkName } from './network'

export const PRIORITY_FEE_MIN_MICROLAMPORTS = 1_000
export const DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS = 1_000_000 // 0.0004 SOL at 400k CU
const SET_COMPUTE_UNIT_PRICE = 3 // ComputeBudget instruction index
const MAX_LOCKED_ACCOUNTS = 128 // getRecentPrioritizationFees limit

export function priorityFeeMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PRIORITY_FEE_MAX_MICROLAMPORTS?.trim()
  if (!raw) return DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS
  const max = Number(raw)
  if (!Number.isSafeInteger(max) || max < PRIORITY_FEE_MIN_MICROLAMPORTS) {
    throw new Error(`PRIORITY_FEE_MAX_MICROLAMPORTS must be a whole number ≥ ${PRIORITY_FEE_MIN_MICROLAMPORTS}`)
  }
  return max
}

// p75 of the recent per-slot fees (micro-lamports per CU), clamped to [min, max].
export function priorityFeeFromRecent(fees: number[], max = priorityFeeMax()): number {
  const sorted = fees.filter((f) => Number.isFinite(f) && f >= 0).sort((a, b) => a - b)
  const p75 = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.75)] : 0
  return Math.min(max, Math.max(PRIORITY_FEE_MIN_MICROLAMPORTS, Math.ceil(p75)))
}

export const isComputeUnitPrice = (ix: TransactionInstruction) =>
  ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === SET_COMPUTE_UNIT_PRICE

function writableAccounts(tx: Transaction): PublicKey[] {
  const keys = new Map<string, PublicKey>()
  if (tx.feePayer) keys.set(tx.feePayer.toBase58(), tx.feePayer)
  for (const ix of tx.instructions) for (const k of ix.keys) if (k.isWritable) keys.set(k.pubkey.toBase58(), k.pubkey)
  return [...keys.values()].slice(0, MAX_LOCKED_ACCOUNTS)
}

// Prepends a compute-unit price unless the transaction already has one. Call it before any signature:
// it changes the message. Skipped on localnet, where there is no fee market. A failed fee lookup
// falls back to the minimum rather than failing the transaction.
export async function withPriorityFee(tx: Transaction, connection: Connection, network: NetworkName = getNetwork().name) {
  if (network === 'localnet' || tx.instructions.some(isComputeUnitPrice)) return tx
  const recent = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts(tx) }).catch(() => [])
  const microLamports = priorityFeeFromRecent(recent.map((f) => f.prioritizationFee))
  tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
  return tx
}
