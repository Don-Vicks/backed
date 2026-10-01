// Live, read-only views of a campaign for the web app (numbers already in human units).
import BN from 'bn.js'
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { SwapMode, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { dbcClient, getUsdcMint, quoteCurveSwap, resalePoolAddress, toUsdcRaw, toVoucherRaw } from './chain'
import { DEFAULT_SLIPPAGE_BPS, SwapError, summarizeBuyQuote, summarizeSellQuote, type BuyQuote, type SellQuote } from './swaps'
import { USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'
import type { CampaignRecord } from './store'
import { getNetwork, isTestNetwork } from './network'
import { loadKeypair } from './wallets'
import { send } from './tx'

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

export async function readCampaignLive(connection: Connection, record: CampaignRecord): Promise<CampaignLive> {
  const client = dbcClient(connection)
  const pool = new PublicKey(record.pool)
  const virtualPool = await client.state.getPool(pool)
  if (!virtualPool) throw new Error(`pool ${record.pool} not found`)
  const s = virtualPool.poolState
  const price = getPriceFromSqrtPrice(s.sqrtPrice, VOUCHER_DECIMALS, USDC_DECIMALS).toNumber()
  const mint = await getMint(connection, new PublicKey(record.baseMint))
  const migrated = Number(s.isMigrated) === 1
  const progress = migrated ? 1 : await client.state.getPoolQuoteTokenCurveProgress(pool)

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
    unitsSold: migrated ? record.campaign.plan.tiers.reduce((a, t) => a + t.units, 0) : toNum(new BN(mint.supply.toString()).sub(s.baseReserve), VOUCHER_DECIMALS),
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
