// Live, read-only views of a campaign for the web app (numbers already in human units).
import BN from 'bn.js'
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync, getMint } from '@solana/spl-token'
import { getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { dbcClient, getUsdcMint, resalePoolAddress, toUsdcRaw } from './chain'
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

export type BuyQuote = { vouchers: number; feeUsdc: number; feePct: number; minVouchers: number }

export async function quoteBuy(connection: Connection, poolAddress: string, usdc: number): Promise<BuyQuote> {
  const client = dbcClient(connection)
  const virtualPool = (await client.state.getPool(poolAddress))!
  const config = (await client.state.getPoolConfig(virtualPool.poolState.config))!
  const slot = await connection.getSlot()
  const q = client.pool.swapQuote({
    virtualPool,
    config,
    swapBaseForQuote: false,
    amountIn: toUsdcRaw(usdc),
    slippageBps: 100,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint: new BN((await connection.getBlockTime(slot))!),
  })
  const feeUsdc = toNum(q.tradingFee.add(q.protocolFee), USDC_DECIMALS)
  return {
    vouchers: toNum(q.outputAmount, VOUCHER_DECIMALS),
    feeUsdc,
    feePct: (feeUsdc / usdc) * 100,
    minVouchers: toNum(q.minimumAmountOut, VOUCHER_DECIMALS),
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
