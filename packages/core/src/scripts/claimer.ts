// Shared by the platform scripts: sign with the fee claimer's key when this machine holds it, else
// print the transaction unsigned (base58) for the claimer to sign elsewhere, e.g. a Squads proposal.
import bs58 from 'bs58'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { send } from '../tx'
import { hasKeypair, loadKeypair } from '../wallets'

// The platform key (PLATFORM_SECRET_KEY, else keys/<network>/platform.json) when it is `claimer`.
export function claimerKey(claimer: PublicKey, unsigned: boolean): Keypair | null {
  if (unsigned || !hasKeypair('platform')) return null
  const platform = loadKeypair('platform')
  return platform.publicKey.equals(claimer) ? platform : null
}

export async function signOrPrint(connection: Connection, tx: Transaction, claimer: PublicKey, key: Keypair | null, label: string) {
  if (key) return void (await send(connection, tx, [key], label))
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
  tx.recentBlockhash = blockhash
  tx.lastValidBlockHeight = lastValidBlockHeight
  tx.feePayer = claimer
  const raw = tx.serialize({ requireAllSignatures: false, verifySignatures: false })
  console.log(`  unsigned: ${label} (signer and fee payer ${claimer.toBase58()}, ${raw.length} bytes)\n    ${bs58.encode(raw)}`)
}
