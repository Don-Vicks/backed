// pnpm core:launch --campaign examples/hoodie.json [--tier A|B|C]
// Scores the maker (mainnet history) unless --tier is given, then creates the campaign on NETWORK.
import fs from 'fs'
import path from 'path'
import { Connection } from '@solana/web3.js'
import { explorerAccount, getConnection, getNetwork, trustRpcUrl } from '../network'
import { loadWallets } from '../wallets'
import { send } from '../tx'
import { MAX_MAKER_SHARE, scoreSignals, trustTier, type TrustResult, type TrustTierName } from '../trust'
import { buildCreateCampaignTx, createCampaignSteps, dbcClient, getUsdcMint } from '../chain'
import { saveCampaign } from '../store'
import { dbPath } from '../db'
import { repoRoot } from '../paths'
import type { Campaign } from '../engine'

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

async function main() {
  const file = arg('campaign')
  if (!file) throw new Error('usage: --campaign <file.json> [--tier A|B|C]')
  const campaign: Campaign = JSON.parse(fs.readFileSync(path.join(repoRoot(), file), 'utf8'))
  const connection = getConnection()
  const w = loadWallets()

  let trust: TrustResult
  const forced = arg('tier') as TrustTierName | undefined
  if (forced) {
    trust = { ...scoreSignals({ walletAgeDays: 0, txCount: 0, activeDays: 0, fundedByFreshWallet: false, truncated: false, partial: false }), tier: forced, maxMakerSharePct: MAX_MAKER_SHARE[forced], reasons: [`Tier set manually to ${forced}`] }
  } else {
    trust = await trustTier(new Connection(trustRpcUrl()), w.maker.publicKey)
  }
  console.log(`Maker trust tier ${trust.tier}: ${trust.reasons.join('; ')}`)

  const usdcMint = getUsdcMint()
  const built = await buildCreateCampaignTx({ connection, campaign, tier: trust.tier, maker: w.maker.publicKey, usdcMint })
  console.table(built.fields.map((f) => ({ input: f.input, value: f.value, 'DBC field': f.dbcField })))
  // The maker pays; a campaign too large for one transaction goes out as createConfig, then createPool.
  let sig = ''
  for (const step of createCampaignSteps(built, w.maker.publicKey)) {
    sig = await send(connection, step.tx, [w.maker, ...step.signers], `create "${campaign.name}" on ${getNetwork().name}`)
  }
  const threshold = await dbcClient(connection).state.getPoolMigrationQuoteThreshold(built.pool)

  saveCampaign({
    pool: built.pool.toBase58(),
    config: built.config.toBase58(),
    baseMint: built.baseMint.toBase58(),
    usdcMint: usdcMint.toBase58(),
    maker: w.maker.publicKey.toBase58(),
    createdAt: new Date().toISOString(),
    createSignature: sig,
    campaign,
    trust: { tier: trust.tier, score: trust.score, reasons: trust.reasons, maxMakerSharePct: trust.maxMakerSharePct },
    goalUsdc: Number(threshold.toString()) / 1e6,
    totalUnits: built.onChain.totalUnits,
    fields: built.fields,
  })
  console.log(`Pool ${explorerAccount(built.pool)}\nOn-chain goal ${(Number(threshold.toString()) / 1e6).toFixed(4)} USDC. Saved to ${dbPath()}`)
}

main().catch((e) => {
  console.error(e.stack ?? e)
  process.exit(1)
})
