// pnpm --filter @preorder/core platform:claim [--unsigned] [--keep-leftover] [pool ...]
// Collects what the platform (DBC partner) is owed on every campaign in the store, or on the pools
// given: curve trading fees and resale-pool fees (to PLATFORM_TREASURY, else the fee claimer),
// leftover vouchers (burned unless --keep-leftover) and any surplus. Signs and sends when this machine
// holds the fee claimer's key; otherwise, or with --unsigned, prints each transaction as unsigned
// base58 for the claimer to sign (e.g. import into a Squads multisig).
import { getConnection, getNetwork } from '../network'
import { buildPlatformClaimTxs, platformTreasury, readPlatformEarnings, type PlatformTotals } from '../platform'
import { getCampaign, listCampaigns, type CampaignRecord } from '../store'
import { claimerKey, signOrPrint } from './claimer'

const usd = (n: number) => `$${n.toFixed(6)}`

function summary(t: PlatformTotals) {
  return [
    `curve fees ${usd(t.curveFeesUnclaimedUsdc)} unclaimed (${usd(t.curveFeesClaimedUsdc)} claimed)`,
    `resale fees ${usd(t.resaleFeesUnclaimedUsdc)} unclaimed`,
    `locked resale liquidity ${usd(t.resaleLiquidityUsdc)} + ${t.resaleLiquidityVouchers.toFixed(6)} vouchers`,
    `leftover ${t.leftoverVouchers.toFixed(6)} vouchers`,
    `surplus ${usd(t.surplusUsdc)}`,
  ].join(' · ')
}

async function main() {
  const args = process.argv.slice(2)
  const unsigned = args.includes('--unsigned')
  const burnLeftover = !args.includes('--keep-leftover')
  const pools = args.filter((a) => !a.startsWith('--'))
  const records: CampaignRecord[] = pools.length
    ? pools.map((p) => {
        const r = getCampaign(p)
        if (!r) throw new Error(`unknown campaign ${p}`)
        return r
      })
    : listCampaigns()
  const connection = getConnection()
  const treasury = platformTreasury()
  console.log(`${getNetwork().name}: ${records.length} campaign(s); USDC to ${treasury ? treasury.toBase58() : 'each config’s fee claimer'}`)

  const earnings = await readPlatformEarnings(connection, records)
  for (const c of earnings.campaigns) console.log(`- ${c.name} (${c.pool}) ${summary(c)}`)
  for (const pool of earnings.failed) console.log(`- ${pool}: chain state not readable, skipped`)
  console.log(`Total: ${summary(earnings.totals)}`)

  let built = 0
  for (const record of records.filter((r) => !earnings.failed.includes(r.pool))) {
    const claims = await buildPlatformClaimTxs(connection, record, { treasury, burnLeftover })
    for (const claim of claims) {
      built++
      const key = claimerKey(claim.signer, unsigned)
      await signOrPrint(connection, claim.tx, claim.signer, key, `${record.campaign.name}: ${claim.label} (${claim.amount.toString()} raw)`)
    }
  }
  if (!built) console.log('Nothing to claim.')
}

main().catch((e) => {
  console.error('FAILED', e instanceof Error ? e.message : e)
  process.exit(1)
})

