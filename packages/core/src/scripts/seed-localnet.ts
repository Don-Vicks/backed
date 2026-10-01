// Seeds a local validator for manual runs, the web app and e2e: fresh wallets (platform, maker,
// backer1-3, referrer), SOL, a mock USDC mint and 1000 USDC per backer, all under PREORDER_ROOT
// (a new temp dir when unset), plus PREORDER_ROOT/.env.localnet to load before starting anything. It
// refuses a PREORDER_ROOT that already holds localnet keys or a mock USDC.
//   bash scripts/localnet/start.sh && pnpm core:seed:localnet
//   set -a; . <root>/.env.localnet; set +a; pnpm --dir apps/web dev -p 3201
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Connection } from '@solana/web3.js'
import { getNetwork } from '../network'
import { seedLocalnet } from '../localnet'

async function main() {
  const root = process.env.PREORDER_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'backed-localnet-'))
  const rpcUrl = getNetwork({ ...process.env, NETWORK: 'localnet' }).rpcUrl
  const seeded = await seedLocalnet(new Connection(rpcUrl, 'confirmed'), root)
  for (const [role, kp] of Object.entries(seeded.wallets)) console.log(`${role.padEnd(9)} ${kp.publicKey.toBase58()}`)
  console.log(`mock USDC ${seeded.usdcMint.toBase58()}`)
  console.log(`\nPREORDER_ROOT=${root}\nenv file: ${seeded.envFile}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
