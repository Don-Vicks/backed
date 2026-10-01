import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComputeBudgetProgram, Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js'
import {
  DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS,
  PRIORITY_FEE_MIN_MICROLAMPORTS,
  isComputeUnitPrice,
  priorityFeeFromRecent,
  priorityFeeMax,
  withPriorityFee,
} from '../priority'

test('p75 of recent fees, clamped to the min and max', () => {
  assert.equal(priorityFeeFromRecent([10_000, 20_000, 30_000, 40_000, 50_000], 1_000_000), 40_000)
  assert.equal(priorityFeeFromRecent([], 1_000_000), PRIORITY_FEE_MIN_MICROLAMPORTS)
  assert.equal(priorityFeeFromRecent([0, 0, 0], 1_000_000), PRIORITY_FEE_MIN_MICROLAMPORTS)
  assert.equal(priorityFeeFromRecent([5e9, 6e9], 1_000_000), 1_000_000)
  assert.equal(priorityFeeFromRecent([NaN, -5, 3_000], 1_000_000), 3_000)
})

test('PRIORITY_FEE_MAX_MICROLAMPORTS overrides the cap and is validated', () => {
  assert.equal(priorityFeeMax({}), DEFAULT_PRIORITY_FEE_MAX_MICROLAMPORTS)
  assert.equal(priorityFeeMax({ PRIORITY_FEE_MAX_MICROLAMPORTS: '5000000' }), 5_000_000)
  assert.throws(() => priorityFeeMax({ PRIORITY_FEE_MAX_MICROLAMPORTS: 'lots' }), /whole number/)
  assert.throws(() => priorityFeeMax({ PRIORITY_FEE_MAX_MICROLAMPORTS: '10' }), /whole number/)
})

const payer = Keypair.generate().publicKey
const transfer = () => {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  tx.feePayer = payer
  return tx
}
const fakeConnection = (fees: number[] | Error) => {
  const seen: unknown[] = []
  const conn = {
    getRecentPrioritizationFees: async (config: unknown) => {
      seen.push(config)
      if (fees instanceof Error) throw fees
      return fees.map((prioritizationFee, slot) => ({ slot, prioritizationFee }))
    },
  } as unknown as Connection
  return { conn, seen }
}
const price = (tx: Transaction) => tx.instructions.find(isComputeUnitPrice)!.data.readBigUInt64LE(1)

test('adds one compute-unit price from the fees on the written accounts, first', async () => {
  const { conn, seen } = fakeConnection([100_000, 200_000, 300_000, 400_000, 500_000])
  const tx = await withPriorityFee(transfer(), conn, 'mainnet')
  assert.equal(tx.instructions.length, 2)
  assert.ok(isComputeUnitPrice(tx.instructions[0]))
  assert.equal(price(tx), BigInt(400_000))
  const locked = (seen[0] as { lockedWritableAccounts: { toBase58(): string }[] }).lockedWritableAccounts.map((k) => k.toBase58())
  assert.ok(locked.includes(payer.toBase58()))
  // Never a compute-unit limit.
  assert.ok(!tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2))
  // Idempotent: a second pass leaves the existing price alone.
  await withPriorityFee(tx, conn, 'mainnet')
  assert.equal(tx.instructions.filter(isComputeUnitPrice).length, 1)
})

test('skipped on localnet; a failed lookup falls back to the minimum', async () => {
  const { conn, seen } = fakeConnection([1_000_000])
  assert.equal((await withPriorityFee(transfer(), conn, 'localnet')).instructions.length, 1)
  assert.equal(seen.length, 0)
  const failing = fakeConnection(new Error('429'))
  const tx = await withPriorityFee(transfer(), failing.conn, 'devnet')
  assert.equal(price(tx), BigInt(PRIORITY_FEE_MIN_MICROLAMPORTS))
})
