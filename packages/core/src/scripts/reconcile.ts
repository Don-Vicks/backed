// pnpm --filter @preorder/core reconcile
// Lists pending campaigns whose pool landed on-chain (the browser never confirmed) and expires the
// ones that never will, then prunes old rows. The web server runs the same job every RECONCILE_INTERVAL_SEC.
import { getConnection, getNetwork } from '../network'
import { dbPath } from '../db'
import { listPending, pruneStore } from '../store'
import { reconcilePending } from '../listing'

async function main() {
  console.log(`Reconciling ${listPending().length} pending campaign(s) on ${getNetwork().name} (${dbPath()})`)
  const result = await reconcilePending(getConnection())
  for (const pool of result.listed) console.log(`  listed   ${pool}`)
  for (const pool of result.expired) console.log(`  expired  ${pool}`)
  for (const pool of result.waiting) console.log(`  waiting  ${pool}`)
  for (const { pool, error } of result.failed) console.log(`  failed   ${pool}: ${error}`)
  const pruned = pruneStore()
  console.log(`Pruned ${pruned.pending} expired pending, ${pruned.rate} idle rate bucket(s), ${pruned.faucetClaims} old faucet claim(s)`)
  if (result.failed.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e.stack ?? e)
  process.exit(1)
})
