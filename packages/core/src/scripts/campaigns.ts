// pnpm core:campaigns list
// pnpm core:campaigns remove <pool> [<pool> ...] [--yes]
// Removes campaigns from this environment's list (the database), e.g. leftover test campaigns before a demo.
// It only edits the app's own records; nothing on-chain changes. Without --yes it shows what it would remove.
import { transaction } from '../db'
import { getNetwork } from '../network'
import { listCampaigns } from '../store'

const [command, ...rest] = process.argv.slice(2)
const yes = rest.includes('--yes')
const pools = rest.filter((a) => !a.startsWith('--'))

function main() {
  const all = listCampaigns()
  if (command === 'list') {
    console.log(`${all.length} campaigns on ${getNetwork().name}`)
    for (const c of all) console.log(`${c.pool}  ${c.campaign.name.padEnd(24)} ${c.createdAt.slice(0, 16)}  tier ${c.trust.tier}`)
    return
  }
  if (command === 'remove' && pools.length) {
    const found = pools.map((p) => all.find((c) => c.pool === p)).filter((c): c is NonNullable<typeof c> => !!c)
    const missing = pools.filter((p) => !found.some((c) => c.pool === p))
    if (missing.length) throw new Error(`not found: ${missing.join(', ')}`)
    for (const c of found) console.log(`${yes ? 'removing' : 'would remove'} ${c.pool}  ${c.campaign.name}`)
    if (!yes) return console.log('Add --yes to remove them.')
    transaction((d) => {
      for (const c of found) d.prepare('DELETE FROM campaigns WHERE pool = ?').run(c.pool)
    })
    console.log(`Removed ${found.length}.`)
    return
  }
  throw new Error('usage: campaigns list | campaigns remove <pool> [<pool> ...] [--yes]')
}

try {
  main()
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
}
