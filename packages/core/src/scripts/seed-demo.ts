// pnpm core:seed:demo: opens three realistic campaigns (a hoodie, a mug, a keyboard) with product
// photos, so a fresh deploy or a local run has something real to look at. Run it once per environment.
//
// It creates them exactly like the web app does: photo stored and served by this app, token metadata
// at /m/<id>, the maker's trust tier read from their wallet history, the maker paying and signing.
// The maker is the wallet in keys/<network>/maker.json. Needs the network's PUBLIC_BASE_URL (the photo and
// metadata URLs are written into the campaign), so on a dev machine point it at your deployed app.
import fs from 'fs'
import path from 'path'
import { randomBytes } from 'crypto'
import { Connection } from '@solana/web3.js'
import { explorerAccount, getConnection, getNetwork, trustRpcUrl } from '../network'
import { loadWallets } from '../wallets'
import { send } from '../tx'
import { trustTier } from '../trust'
import { buildCreateCampaignTx, createCampaignSteps, dbcClient, getUsdcMint } from '../chain'
import { listCampaigns, saveCampaign, saveMetadata } from '../store'
import { saveImage } from '../images'
import { DEFAULT_DROP_BOT_WINDOW_SEC, campaignFromInput } from '../campaign-input'
import { resolvePublicOrigin } from '../origin'
import { repoRoot } from '../paths'

type Seed = { photo: string; input: Record<string, unknown> }

const SEEDS: Seed[] = [
  {
    photo: 'hoodie.jpg',
    input: {
      name: 'Studio Hoodie',
      makerName: 'Porto Studio',
      symbol: 'HOODIE',
      description: 'Heavyweight 450gsm cotton fleece, garment-dyed in sunset orange, embroidered chest logo. Made in small batches in Porto. Sizes S to XXL.',
      plan: { tiers: [{ units: 15, startPrice: 38 }, { units: 25, startPrice: 44 }], finalPrice: 55, makerSharePct: 10 },
      shipDays: 45,
    },
  },
  {
    photo: 'mug.jpg',
    input: {
      name: 'Hand-Thrown Mug',
      makerName: 'Clay & Kiln',
      symbol: 'MUG',
      description: 'A 350ml stoneware mug, thrown on the wheel and finished in a cream glaze with a single sunset band. Dishwasher safe. Every mug is slightly different.',
      plan: { tiers: [{ units: 20, startPrice: 24 }, { units: 40, startPrice: 29 }], finalPrice: 36, makerSharePct: 10 },
      shipDays: 30,
    },
  },
  {
    photo: 'keyboard.jpg',
    input: {
      name: 'Aurora 65 Keyboard',
      makerName: 'Northkey Labs',
      symbol: 'AURORA',
      description: 'A 65% hot-swappable mechanical keyboard with a CNC aluminium case, gasket mount and pre-lubed switches. Limited run of 25.',
      plan: { tiers: [{ units: 10, startPrice: 120 }, { units: 15, startPrice: 140 }], finalPrice: 165, makerSharePct: 10 },
      shipDays: 90,
    },
  },
]

async function main() {
  const net = getNetwork().name
  if (net === 'mainnet') throw new Error('seed:demo makes example campaigns; it does not run on mainnet')
  const origin = resolvePublicOrigin(process.env, net)
  const connection = getConnection()
  const w = loadWallets()
  const usdcMint = getUsdcMint()
  const existing = new Set(listCampaigns().map((c) => c.campaign.name))
  const trust = await trustTier(new Connection(trustRpcUrl()), w.maker.publicKey)
  console.log(`Maker ${w.maker.publicKey.toBase58()} on ${net}: trust tier ${trust.tier} (${trust.reasons.join('; ')})`)

  for (const seed of SEEDS) {
    const name = String(seed.input.name)
    if (existing.has(name)) {
      console.log(`• ${name}: already exists, skipped`)
      continue
    }
    const photo = fs.readFileSync(path.join(repoRoot(), 'examples/demo', seed.photo))
    const image = `${origin}/api/images/${saveImage(photo)}`
    const metaId = randomBytes(8).toString('base64url').slice(0, 10)
    const campaign = campaignFromInput({ ...seed.input, image, dropBot: { windowSec: DEFAULT_DROP_BOT_WINDOW_SEC } }, `${origin}/m/${metaId}`)
    const maxShare = trust.maxMakerSharePct
    if (campaign.plan.makerSharePct > maxShare) campaign.plan.makerSharePct = maxShare // a new wallet may take less

    console.log(`• ${name}`)
    const built = await buildCreateCampaignTx({ connection, campaign, tier: trust.tier, maker: w.maker.publicKey, usdcMint })
    let sig = ''
    for (const step of createCampaignSteps(built, w.maker.publicKey)) sig = await send(connection, step.tx, [w.maker, ...step.signers], `create "${name}"`)
    const threshold = await dbcClient(connection).state.getPoolMigrationQuoteThreshold(built.pool)
    saveMetadata(metaId, { name: campaign.name, symbol: campaign.symbol, description: campaign.description ?? '', image })
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
      migrationFeeOption: built.onChain.migrationFeeOption,
    })
    console.log(`  ${explorerAccount(built.pool)}\n  goal ${(Number(threshold.toString()) / 1e6).toFixed(2)} USDC`)
  }
}

main().catch((e) => {
  console.error(e.stack ?? e)
  process.exit(1)
})
