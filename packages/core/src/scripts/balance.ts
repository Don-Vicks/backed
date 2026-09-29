import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { getConnection, getNetwork } from '../network'
import { WALLET_ROLES, loadKeypair } from '../wallets'

async function main() {
  const connection = getConnection()
  console.log(`Network: ${getNetwork().name}`)
  for (const role of WALLET_ROLES) {
    const kp = loadKeypair(role)
    const balance = await connection.getBalance(kp.publicKey)
    console.log(`${role.padEnd(9)} ${kp.publicKey.toBase58()}  ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
