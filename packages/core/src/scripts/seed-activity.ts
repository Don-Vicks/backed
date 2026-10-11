// pnpm core:seed:activity: makes the demo campaigns look lived-in on devnet/localnet. Gives each one a
// display name for its maker and has the test backer wallets (keys/<network>/backer1-3.json) buy a few
// units, so the campaign list and pages show real progress instead of $0. Safe to re-run: names are only
// filled in when missing, and a campaign that already has sales is left alone.
import { PublicKey } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { getConnection, getNetwork, explorerAccount } from '../network'
import { loadWallets } from '../wallets'
import { send } from '../tx'
import { buildBuyTx, getUsdcMint } from '../chain'
import { devnetFaucet, readCampaignsLive } from '../live'
import { listCampaigns, saveCampaign } from '../store'

type Plan = { makerName: string; buys: { backer: 'backer1' | 'backer2' | 'backer3'; usdc: number }[] }

const PLANS: Record<string, Plan> = {
  'Studio Hoodie': { makerName: 'Porto Studio', buys: [{ backer: 'backer1', usdc: 76 }, { backer: 'backer2', usdc: 38 }] },
  'Hand-Thrown Mug': { makerName: 'Clay & Kiln', buys: [{ backer: 'backer2', usdc: 48 }, { backer: 'backer3', usdc: 24 }] },
  'Aurora 65 Keyboard': { makerName: 'Northkey Labs', buys: [{ backer: 'backer3', usdc: 120 }] },
}

async function main() {
  const net = getNetwork().name
  if (net === 'mainnet') throw new Error('seed:activity uses test wallets and mock USDC; it does not run on mainnet')
  const connection = getConnection()
  const wallets = loadWallets()
  const usdcMint = getUsdcMint()

  const usdcOf = async (owner: PublicKey) => {
    try {
      return Number((await getAccount(connection, getAssociatedTokenAddressSync(usdcMint, owner))).amount) / 1e6
    } catch {
      return 0
    }
  }

  for (const record of listCampaigns()) {
    const plan = PLANS[record.campaign.name]
    if (!plan) continue
    if (!record.campaign.makerName) {
      saveCampaign({ ...record, campaign: { ...record.campaign, makerName: plan.makerName } })
      console.log(`• ${record.campaign.name}: maker shown as "${plan.makerName}"`)
    }
    const [live] = await readCampaignsLive(connection, [record])
    if (live && live.unitsSold > 0) {
      console.log(`• ${record.campaign.name}: already has ${live.unitsSold.toFixed(2)} units sold, skipped`)
      continue
    }
    for (const { backer, usdc } of plan.buys) {
      const kp = wallets[backer]
      while ((await usdcOf(kp.publicKey)) < usdc) await devnetFaucet(connection, kp.publicKey) // 50 mock USDC per call
      await send(connection, (await buildBuyTx(connection, kp.publicKey, new PublicKey(record.pool), usdc)).tx, [kp], `${backer} backs ${record.campaign.name} with ${usdc} USDC`)
    }
    console.log(`• ${record.campaign.name}: ${plan.buys.length} backer(s) in. ${explorerAccount(new PublicKey(record.pool))}`)
  }
}

main().catch((e) => {
  console.error(e.stack ?? e)
  process.exit(1)
})
