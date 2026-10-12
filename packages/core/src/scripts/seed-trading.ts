// pnpm --filter @preorder/core seed:trading [rounds] [gapSec]: devnet/localnet demo trading, so the campaign
// price charts have a history. Every gapSec (default 40) a test backer (keys/<network>/backer1-3.json)
// buys a few USDC of a funding campaign, or sells part of what it holds back to the curve. Buys stop at
// 60% of a campaign's goal, so no demo campaign graduates by accident. Mock USDC only.
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { getConnection, getNetwork } from '../network'
import { loadWallets } from '../wallets'
import { send } from '../tx'
import { buildBuyTx, buildSellBackTx, getUsdcMint } from '../chain'
import { devnetFaucet, readCampaignsLive } from '../live'
import { listCampaigns } from '../store'

const BACKERS = ['backer1', 'backer2', 'backer3'] as const
const pick = <T>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  if (getNetwork().name === 'mainnet') throw new Error('seed:trading uses test wallets and mock USDC; it does not run on mainnet')
  const rounds = Number(process.argv[2] ?? 30)
  const gapSec = Number(process.argv[3] ?? 40)
  const connection = getConnection()
  const wallets = loadWallets()
  const usdcMint = getUsdcMint()
  const balance = async (mint: PublicKey, owner: PublicKey) => {
    try {
      return new BN((await getAccount(connection, getAssociatedTokenAddressSync(mint, owner))).amount.toString())
    } catch {
      return new BN(0)
    }
  }

  for (let round = 1; round <= rounds; round++) {
    try {
      const records = listCampaigns()
      const lives = await readCampaignsLive(connection, records)
      const open = records.map((r, i) => ({ r, live: lives[i] })).filter((x) => x.live?.status === 'funding')
      if (open.length === 0) throw new Error('no funding campaigns to trade')
      const { r, live } = pick(open)
      const name = pick(BACKERS)
      const kp = wallets[name]
      const held = await balance(new PublicKey(r.baseMint), kp.publicKey)
      const sell = held.gt(new BN(0)) && (live!.progress > 0.6 || Math.random() < 0.3)
      if (sell) {
        const share = 20 + Math.floor(Math.random() * 40) // percent of what it holds
        const amount = held.muln(share).divn(100)
        await send(connection, (await buildSellBackTx(connection, kp.publicKey, new PublicKey(r.pool), amount)).tx, [kp], `${round}/${rounds} ${name} sells ${share}% of its ${r.campaign.name} vouchers`)
      } else {
        const usdc = Math.round((0.15 + Math.random() * 0.45) * live!.priceUsdc * 100) / 100 // a fraction of one unit, so prices move gently
        while ((await balance(usdcMint, kp.publicKey)).lt(new BN(Math.ceil(usdc * 1e6)))) await devnetFaucet(connection, kp.publicKey)
        await send(connection, (await buildBuyTx(connection, kp.publicKey, new PublicKey(r.pool), usdc)).tx, [kp], `${round}/${rounds} ${name} buys ${usdc} USDC of ${r.campaign.name}`)
      }
    } catch (e) {
      console.error(`round ${round} failed: ${e instanceof Error ? e.message : e}`) // a network blip skips one round
    }
    if (round < rounds) await sleep(gapSec * 1000 * (0.6 + Math.random() * 0.8))
  }
}

main().catch((e) => {
  console.error(e.stack ?? e)
  process.exit(1)
})
