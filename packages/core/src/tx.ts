import { Connection, Keypair, Transaction, VersionedTransaction } from '@solana/web3.js'
import { explorerTx } from './network'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Waits until the cluster hands out a blockhash other than `previous` (one block, ~0.4 s).
async function nextBlockhash(connection: Connection, previous: string) {
  for (let i = 0; i < 20; i++) {
    const latest = await connection.getLatestBlockhash('confirmed')
    if (latest.blockhash !== previous) return latest
    await sleep(400)
  }
  throw new Error('no new blockhash after 8s')
}

// A transaction that provably changed nothing: it failed simulation (never sent) or failed on-chain.
// Any other error from send() may come after the transaction landed.
export class TxNotExecutedError extends Error {}

// Sends per fee payer run one at a time (a faucet burst queues instead of racing the admin graduation).
const payerQueues = new Map<string, Promise<unknown>>()

// Signs, simulates the exact bytes it then sends, sends them and confirms against the same blockhash.
// Two identical transactions (same signer, same instructions) sharing a blockhash have the same
// signature, and the second simulates as AlreadyProcessed: that one is re-signed on the next blockhash.
// Sends by one fee payer are serialized, so the second always sees the first as processed.
// All SDK methods return unsigned transactions; this attaches the blockhash and fee payer (signers[0]).
export function send(connection: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  const payer = signers[0].publicKey.toBase58()
  const run = (payerQueues.get(payer) ?? Promise.resolve()).catch(() => {}).then(() => sendNow(connection, tx, signers, label))
  payerQueues.set(payer, run)
  run.finally(() => {
    if (payerQueues.get(payer) === run) payerQueues.delete(payer)
  }).catch(() => {})
  return run
}

async function sendNow(connection: Connection, tx: Transaction, signers: Keypair[], label: string): Promise<string> {
  let latest = await connection.getLatestBlockhash('confirmed')
  for (let attempt = 0; ; attempt++) {
    tx.recentBlockhash = latest.blockhash
    tx.lastValidBlockHeight = latest.lastValidBlockHeight
    tx.feePayer = signers[0].publicKey
    tx.sign(...signers)
    const raw = tx.serialize()

    const sim = await connection.simulateTransaction(VersionedTransaction.deserialize(raw), { sigVerify: true, commitment: 'confirmed' })
    if (sim.value.err === 'AlreadyProcessed' && attempt < 2) {
      latest = await nextBlockhash(connection, latest.blockhash)
      continue
    }
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).slice(-15).join('\n  ')
      throw new TxNotExecutedError(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n  ${logs}`)
    }

    const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 })
    const result = await connection.confirmTransaction(
      { signature, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      'confirmed',
    )
    if (result.value.err) throw new TxNotExecutedError(`${label}: failed on-chain ${JSON.stringify(result.value.err)} (${signature})`)
    console.log(`  ✓ ${label}\n    ${explorerTx(signature)}`)
    return signature
  }
}
