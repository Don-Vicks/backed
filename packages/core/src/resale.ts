// After graduation: the DAMM v2 resale pool, and what the maker has earned.
// Token A of the resale pool is the voucher, token B is USDC (both 6 decimals).
import BN from 'bn.js'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token'
import { CpAmm, getPriceFromSqrtPrice, getUnClaimLpFee } from '@meteora-ag/cp-amm-sdk'
import { dbcClient, resalePoolAddress } from './chain'
import { USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'
import type { CampaignRecord } from './store'
import { DEFAULT_SLIPPAGE_BPS, chainNow, slippageBps, toRawAmount } from './swaps'

export type ResaleSide = 'buy' | 'sell' // buy = USDC → vouchers, sell = vouchers → USDC

export type MakerEarnings = {
  curveFeesUnclaimedUsdc: number // maker's share of bonding-curve trading fees, not yet claimed
  curveFeesClaimedUsdc: number
  resaleFeesUnclaimedUsdc: number // resale-pool fees earned by the maker's locked position, USDC side
  resaleFeesUnclaimedVouchers: number // …and voucher side
  positions: number
}

export type ResaleView = {
  pool: string
  priceUsdc: number
  vouchersInPool: number
  usdcInPool: number
  maker: MakerEarnings
}

const toNum = (bn: BN | bigint, decimals: number) => Number(bn.toString()) / 10 ** decimals

function resalePool(record: CampaignRecord) {
  return resalePoolAddress(new PublicKey(record.baseMint), new PublicKey(record.usdcMint))
}

export async function readMakerEarnings(connection: Connection, record: CampaignRecord): Promise<MakerEarnings> {
  const fees = await dbcClient(connection).state.getPoolFeeBreakdown(record.pool)
  const out: MakerEarnings = {
    curveFeesUnclaimedUsdc: toNum(fees.creator.unclaimedQuoteFee, USDC_DECIMALS),
    curveFeesClaimedUsdc: toNum(fees.creator.claimedQuoteFee, USDC_DECIMALS),
    resaleFeesUnclaimedUsdc: 0,
    resaleFeesUnclaimedVouchers: 0,
    positions: 0,
  }
  const cpAmm = new CpAmm(connection)
  const pool = resalePool(record)
  const poolState = await cpAmm.fetchPoolState(pool).catch(() => null)
  if (!poolState) return out
  const positions = await cpAmm.getUserPositionByPool(pool, new PublicKey(record.maker))
  out.positions = positions.length
  for (const p of positions) {
    const fee = getUnClaimLpFee(poolState, p.positionState)
    out.resaleFeesUnclaimedVouchers += toNum(fee.feeTokenA, VOUCHER_DECIMALS)
    out.resaleFeesUnclaimedUsdc += toNum(fee.feeTokenB, USDC_DECIMALS)
  }
  return out
}

export async function readResale(connection: Connection, record: CampaignRecord): Promise<ResaleView | null> {
  const cpAmm = new CpAmm(connection)
  const pool = resalePool(record)
  const poolState = await cpAmm.fetchPoolState(pool).catch(() => null)
  if (!poolState) return null
  const [vaultA, vaultB, maker] = await Promise.all([
    getAccount(connection, poolState.tokenAVault),
    getAccount(connection, poolState.tokenBVault),
    readMakerEarnings(connection, record),
  ])
  return {
    pool: pool.toBase58(),
    priceUsdc: getPriceFromSqrtPrice(poolState.sqrtPrice, VOUCHER_DECIMALS, USDC_DECIMALS).toNumber(),
    vouchersInPool: toNum(vaultA.amount, VOUCHER_DECIMALS),
    usdcInPool: toNum(vaultB.amount, USDC_DECIMALS),
    maker,
  }
}

async function quoteRaw(connection: Connection, record: CampaignRecord, side: ResaleSide, amount: number, bps: number) {
  const cpAmm = new CpAmm(connection)
  const pool = resalePool(record)
  const [poolState, slot, now] = await Promise.all([cpAmm.fetchPoolState(pool), connection.getSlot(), chainNow(connection)])
  const inputMint = side === 'buy' ? poolState.tokenBMint : poolState.tokenAMint
  const inDecimals = side === 'buy' ? USDC_DECIMALS : VOUCHER_DECIMALS
  const inAmount = toRawAmount(amount, inDecimals) // 400 rather than a bn.js assertion for huge amounts
  const quote = cpAmm.getQuote({
    inAmount,
    inputTokenMint: inputMint,
    slippage: slippageBps(bps), // basis points
    poolState,
    currentTime: now,
    currentSlot: slot,
    tokenADecimal: VOUCHER_DECIMALS,
    tokenBDecimal: USDC_DECIMALS,
  })
  return { cpAmm, pool, poolState, inputMint, inAmount, quote }
}

export type ResaleQuote = { out: number; minOut: number; feeUsdcEquivalent: number; priceImpactPct: number }

export async function quoteResale(connection: Connection, record: CampaignRecord, side: ResaleSide, amount: number, bps = DEFAULT_SLIPPAGE_BPS): Promise<ResaleQuote> {
  const { quote } = await quoteRaw(connection, record, side, amount, bps)
  const outDecimals = side === 'buy' ? VOUCHER_DECIMALS : USDC_DECIMALS
  const inDecimals = side === 'buy' ? USDC_DECIMALS : VOUCHER_DECIMALS
  return {
    out: toNum(quote.swapOutAmount, outDecimals),
    minOut: toNum(quote.minSwapOutAmount, outDecimals),
    feeUsdcEquivalent: toNum(quote.totalFee, inDecimals),
    priceImpactPct: Number(quote.priceImpact.toString()),
  }
}

export async function buildResaleSwapTx(connection: Connection, record: CampaignRecord, wallet: PublicKey, side: ResaleSide, amount: number, bps = DEFAULT_SLIPPAGE_BPS) {
  const { cpAmm, pool, poolState, inputMint, inAmount, quote } = await quoteRaw(connection, record, side, amount, bps)
  return cpAmm.swap({
    payer: wallet,
    pool,
    inputTokenMint: inputMint,
    outputTokenMint: side === 'buy' ? poolState.tokenAMint : poolState.tokenBMint,
    amountIn: inAmount,
    minimumAmountOut: quote.minSwapOutAmount,
    tokenAMint: poolState.tokenAMint,
    tokenBMint: poolState.tokenBMint,
    tokenAVault: poolState.tokenAVault,
    tokenBVault: poolState.tokenBVault,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
  })
}

// One transaction: claim the maker's curve trading fees and every resale-pool position's fees.
export async function buildMakerClaimTx(connection: Connection, record: CampaignRecord): Promise<Transaction | null> {
  const maker = new PublicKey(record.maker)
  const tx = new Transaction()
  const fees = await dbcClient(connection).state.getPoolFeeBreakdown(record.pool)
  if (fees.creator.unclaimedQuoteFee.gtn(0) || fees.creator.unclaimedBaseFee.gtn(0)) {
    const claim = await dbcClient(connection).creator.claimCreatorTradingFee({
      creator: maker,
      payer: maker,
      pool: new PublicKey(record.pool),
      maxBaseAmount: fees.creator.unclaimedBaseFee,
      maxQuoteAmount: fees.creator.unclaimedQuoteFee,
    })
    tx.add(...claim.instructions)
  }
  const cpAmm = new CpAmm(connection)
  const pool = resalePool(record)
  const poolState = await cpAmm.fetchPoolState(pool).catch(() => null)
  if (poolState) {
    for (const p of await cpAmm.getUserPositionByPool(pool, maker)) {
      const fee = getUnClaimLpFee(poolState, p.positionState)
      if (fee.feeTokenA.isZero() && fee.feeTokenB.isZero()) continue
      const claim = await cpAmm.claimPositionFee({
        owner: maker,
        position: p.position,
        pool,
        positionNftAccount: p.positionNftAccount,
        tokenAMint: poolState.tokenAMint,
        tokenBMint: poolState.tokenBMint,
        tokenAVault: poolState.tokenAVault,
        tokenBVault: poolState.tokenBVault,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        feePayer: maker,
      })
      tx.add(...claim.instructions)
    }
  }
  return tx.instructions.length ? tx : null
}
