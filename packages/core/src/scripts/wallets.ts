// Creates the test wallets (if missing) and tops them up from FUNDER_KEYPAIR. Devnet only.
import { LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js'
import { getConnection, getNetwork } from '../network'
import { WALLET_ROLES, loadFunder, loadOrCreateKeypair } from '../wallets'
import { send } from '../tx'

const TARGET_SOL: Record<string, number> = { platform: 1.5, maker: 0.3, backer1: 0.3, backer2: 0.3, backer3: 0.3 }

async function main() {
  if (getNetwork().name !== 'devnet') throw new Error('wallets script only runs on devnet')
  const connection = getConnection()
  const funder = loadFunder()

  const tx = new Transaction()
  for (const role of WALLET_ROLES) {
    const kp = loadOrCreateKeypair(role)
    const balance = await connection.getBalance(kp.publicKey)
    const target = TARGET_SOL[role] * LAMPORTS_PER_SOL
    console.log(`${role.padEnd(9)} ${kp.publicKey.toBase58()}  ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`)
    if (balance < target) {
      tx.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: target - balance }))
    }
  }
  if (tx.instructions.length === 0) return console.log('All wallets already funded.')
  await send(connection, tx, [funder], `fund ${tx.instructions.length} wallets from funder`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
