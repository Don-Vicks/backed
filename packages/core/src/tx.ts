import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { explorerTx } from './network'

const usedBlockhashes = new Set<string>()

// Two identical transactions (same signer, same instructions) sharing a blockhash have the same
// signature, and the second is rejected as AlreadyProcessed; waiting for a new blockhash avoids that.
async function freshBlockhash(connection: Connection) {
  for (let i = 0; i < 20; i++) {
    const latest = await connection.getLatestBlockhash('confirmed')
    if (!usedBlockhashes.has(latest.blockhash)) {
      usedBlockhashes.add(latest.blockhash)
      return latest
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error('no unused blockhash after 8s')
}

// All SDK methods return unsigned transactions; this attaches a fresh blockhash + fee payer,
// simulates first, and only then sends.
export async function send(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  label: string,
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await freshBlockhash(connection)
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.feePayer = signers[0].publicKey
  tx.sign(...signers)

  const sim = await connection.simulateTransaction(tx)
  if (sim.value.err) {
    const logs = (sim.value.logs ?? []).slice(-15).join('\n  ')
    throw new Error(`${label}: simulation failed ${JSON.stringify(sim.value.err)}\n  ${logs}`)
  }

  const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
  console.log(`  ✓ ${label}\n    ${explorerTx(sig)}`)
  return sig
}
