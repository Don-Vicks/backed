// Live, read-only views of a campaign for the web app (numbers already in human units).
import BN from 'bn.js'
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync, unpackMint } from '@solana/spl-token'
import { SwapMode, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { dbcClient, getUsdcMint, quoteCurveSwap, resalePoolAddress, toUsdcRaw, toVoucherRaw } from './chain'
import { DEFAULT_SLIPPAGE_BPS, SwapError, summarizeBuyQuote, summarizeSellQuote, type BuyQuote, type SellQuote } from './swaps'
import { USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'
import type { CampaignRecord } from './store'
import { getNetwork, isTestNetwork } from './network'
import { loadKeypair } from './wallets'
import { send } from './tx'
import { LruMap, ttlCache } from './cache'

export type CampaignStatus = 'funding' | 'funded' | 'reselling'

export type CampaignLive = {
  status: CampaignStatus
  progress: number // 0..1 toward the goal
  raisedUsdc: number
  goalUsdc: number
  priceUsdc: number // current curve price per voucher
  unitsSold: number
  tierIndex: number // which early-bird tier the price is in
  resalePool: string | null
  makerBudgetWithdrawn: boolean // DBC migrationFeeWithdrawStatus, creator bit = 0b10
}

const toNum = (bn: BN, decimals: number) => Number(bn.toString()) / 10 ** decimals

type DbcState = ReturnType<typeof dbcClient>['state']
type PoolConfigAccount = NonNullable<Awaited<ReturnType<DbcState['getPoolConfig']>>>
type PoolState = NonNullable<Awaited<ReturnType<DbcState['getPool']>>>['poolState']

// Every viewer polls, so live state is read at most once per pool per LIVE_TTL_MS and concurrent reads
// of one pool share a request. Configs never change after creation: they are read once.
export const LIVE_TTL_MS = 3_000
const liveCache = ttlCache<CampaignLive>(LIVE_TTL_MS)
const configCache = new LruMap<string, PoolConfigAccount>(5000)

export function readCampaignLive(connection: Connection, record: CampaignRecord): Promise<CampaignLive> {
  return liveCache.get(record.pool, async () => {
    const [live] = await fetchCampaignsLive(connection, [record])
    if (!live) throw new Error(`pool ${record.pool} not found`)
    return live
  })
}

// The listing: cached pools as they are, the rest in batched reads. null for a pool that can't be read.
export async function readCampaignsLive(connection: Connection, records: CampaignRecord[]): Promise<(CampaignLive | null)[]> {
  const out = records.map((r) => liveCache.fresh(r.pool) ?? null)
  const missing = records.flatMap((r, i) => (out[i] ? [] : [i]))
  if (missing.length) {
    const fetched = await fetchCampaignsLive(connection, missing.map((i) => records[i]))
    missing.forEach((i, j) => {
      out[i] = fetched[j]
      if (fetched[j]) liveCache.set(records[i].pool, fetched[j]!)
    })
  }
  return out
}

async function getAccounts(connection: Connection, keys: PublicKey[]) {
  const chunks: PublicKey[][] = []
  for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100)) // RPC limit per call
  return (await Promise.all(chunks.map((c) => connection.getMultipleAccountsInfo(c, 'confirmed')))).flat()
}

// Pools and mints in one getMultipleAccountsInfo (per 100 accounts), then any config not cached yet.
async function fetchCampaignsLive(connection: Connection, records: CampaignRecord[]): Promise<(CampaignLive | null)[]> {
  const coder = dbcClient(connection).state.program.coder.accounts
  const infos = await getAccounts(connection, records.flatMap((r) => [new PublicKey(r.pool), new PublicKey(r.baseMint)]))
  const pools = records.map((_, i) => {
    const info = infos[2 * i]
    try {
      return info ? (coder.decode('virtualPool', info.data).poolState as PoolState) : null
    } catch {
      return null // not a DBC pool
    }
  })
  const configKeys = [...new Set(pools.flatMap((p) => (p && !configCache.get(p.config.toBase58()) ? [p.config.toBase58()] : [])))]
  if (configKeys.length) {
    const configInfos = await getAccounts(connection, configKeys.map((k) => new PublicKey(k)))
    configInfos.forEach((info, i) => {
      if (info) configCache.set(configKeys[i], coder.decode('poolConfig', info.data) as PoolConfigAccount)
    })
  }
  return records.map((record, i) => {
    const s = pools[i]
    const config = s && configCache.get(s.config.toBase58())
    const mintInfo = infos[2 * i + 1]
    if (!s || !config || !mintInfo) return null
    return campaignLive(record, s, config, unpackMint(new PublicKey(record.baseMint), mintInfo).supply)
  })
}

function campaignLive(record: CampaignRecord, s: PoolState, config: PoolConfigAccount, mintSupply: bigint): CampaignLive {
  const price = getPriceFromSqrtPrice(s.sqrtPrice, VOUCHER_DECIMALS, USDC_DECIMALS).toNumber()
  const migrated = Number(s.isMigrated) === 1
  // As the SDK's getPoolQuoteTokenCurveProgress computes it, from the accounts already read.
  const threshold = Number(config.migrationQuoteThreshold.toString())
  const progress = migrated ? 1 : Math.min(1, Math.max(0, threshold > 0 ? Number(s.quoteReserve.toString()) / threshold : 0))

  // Tier = last tier whose start price is at or below the current price.
  const tiers = record.campaign.plan.tiers
  let tierIndex = 0
  tiers.forEach((t, i) => {
    if (price >= t.startPrice) tierIndex = i
  })

  return {
    status: migrated ? 'reselling' : progress >= 1 ? 'funded' : 'funding',
    progress,
    raisedUsdc: toNum(s.quoteReserve, USDC_DECIMALS),
    goalUsdc: record.goalUsdc,
    priceUsdc: price,
    unitsSold: migrated ? record.campaign.plan.tiers.reduce((a, t) => a + t.units, 0) : toNum(new BN(mintSupply.toString()).sub(s.baseReserve), VOUCHER_DECIMALS),
    tierIndex,
    makerBudgetWithdrawn: (Number((s as { migrationFeeWithdrawStatus?: number }).migrationFeeWithdrawStatus ?? 0) & 0b10) !== 0,
    resalePool: migrated ? resalePoolAddress(new PublicKey(record.baseMint), new PublicKey(record.usdcMint)).toBase58() : null,
  }
}

// Buy quote in the same mode the transaction uses (PartialFill): near the goal it reports the
// capped spend instead of failing, and once the goal is reached it throws a 409 SwapError.
export async function quoteBuy(connection: Connection, poolAddress: string, usdc: number, bps = DEFAULT_SLIPPAGE_BPS): Promise<BuyQuote> {
  const q = await quoteCurveSwap(connection, poolKey(poolAddress), {
    swapBaseForQuote: false,
    swapMode: SwapMode.PartialFill,
    amountIn: toUsdcRaw(usdc),
    slippageBps: bps,
  })
  return summarizeBuyQuote(q, bps)
}

// Exit quote: vouchers back to the curve for USDC (ExactIn), as buildSellBackTx sells them.
export async function quoteSell(connection: Connection, poolAddress: string, vouchers: number, bps = DEFAULT_SLIPPAGE_BPS): Promise<SellQuote> {
  const q = await quoteCurveSwap(connection, poolKey(poolAddress), {
    swapBaseForQuote: true,
    swapMode: SwapMode.ExactIn,
    amountIn: toVoucherRaw(vouchers),
    slippageBps: bps,
  })
  return summarizeSellQuote(q, bps)
}

function poolKey(address: string) {
  try {
    return new PublicKey(address)
  } catch {
    throw new SwapError('pool is not a valid Solana address', 400)
  }
}

// Devnet/localnet only: gives a wallet 50 mock USDC and a little SOL for fees, paid by the platform wallet.
export async function devnetFaucet(connection: Connection, wallet: PublicKey) {
  if (!isTestNetwork(getNetwork().name)) throw new Error('faucet is devnet/localnet only')
  const platform = loadKeypair('platform')
  const usdcMint = getUsdcMint()
  const ata = getAssociatedTokenAddressSync(usdcMint, wallet)
  const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(platform.publicKey, ata, wallet, usdcMint))
    .add(createMintToInstruction(usdcMint, ata, platform.publicKey, BigInt(toUsdcRaw(50).toString())))
  const sol = await connection.getBalance(wallet)
  if (sol < 0.02 * LAMPORTS_PER_SOL) {
    tx.add(SystemProgram.transfer({ fromPubkey: platform.publicKey, toPubkey: wallet, lamports: 0.05 * LAMPORTS_PER_SOL }))
  }
  return send(connection, tx, [platform], `faucet → ${wallet.toBase58()}`)
}
