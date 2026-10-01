// pnpm --filter @preorder/core partner:metadata [--unsigned]
// One-off: the platform's on-chain partner listing (DBC PartnerMetadata: name, website, logo) for the
// fee claimer new campaigns use. The website is PUBLIC_BASE_URL (on localnet, else WEB_URL or
// http://localhost:3100). Signs when this machine holds the claimer's key, else prints it unsigned.
import { getConnection, getNetwork } from '../network'
import { buildPartnerMetadataTx, partnerListing, readPartnerListing } from '../metadata'
import { resolvePublicOrigin } from '../origin'
import { platformFeeClaimer } from '../wallets'
import { claimerKey, signOrPrint } from './claimer'

async function main() {
  const net = getNetwork()
  const origin = resolvePublicOrigin(process.env, net.name, process.env.WEB_URL || 'http://localhost:3100')
  const connection = getConnection()
  const claimer = platformFeeClaimer()
  const tx = await buildPartnerMetadataTx(connection, claimer, origin)
  if (!tx) {
    console.log(`${net.name}: ${claimer.toBase58()} already has a partner listing: ${JSON.stringify(await readPartnerListing(connection, claimer))}`)
    return
  }
  const key = claimerKey(claimer, process.argv.includes('--unsigned'))
  await signOrPrint(connection, tx, claimer, key, `create partner listing ${JSON.stringify(partnerListing(origin))}`)
  if (key) console.log(`  reads back: ${JSON.stringify(await readPartnerListing(connection, claimer))}`)
}

main().catch((e) => {
  console.error('FAILED', e instanceof Error ? e.message : e)
  process.exit(1)
})
