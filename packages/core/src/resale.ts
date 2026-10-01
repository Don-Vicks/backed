// After graduation: the DAMM v2 resale pool, and what the maker has earned.
// Token A of the resale pool is the voucher, token B is USDC (both 6 decimals). Every resale pool we
// open collects its fees in USDC only (the Customizable QuoteToken mode, and the fixed 2% config of
// older campaigns), so there are no voucher-side royalties to show or claim.
import BN from 'bn.js'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, getAccount } from '@solana/spl-token'
import { CpAmm, getPriceFromSqrtPrice, getUnClaimLpFee, type PoolState } from '@meteora-ag/cp-amm-sdk'
import { dbcClient, readResaleConfig, resolveResalePool } from './chain'
import { USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'
import { makerRoyaltyBps } from './royalty'
import type { CampaignRecord } from './store'
import { DEFAULT_SLIPPAGE_BPS, chainClock, chainNow, slippageBps, toRawAmount } from './swaps'
import { ttlCache } from './cache'
import { backerFloor, makerLp, type BackerFloor, type MakerLp } from './unlock'

export type ResaleSide = 'buy' | 'sell' // buy = USDC → vouchers, sell = vouchers → USDC

export type MakerEarnings = {
  curveFeesUnclaimedUsdc: number // maker's share of bonding-curve trading fees, not yet claimed
  curveFeesClaimedUsdc: number
  resaleFeesUnclaimedUsdc: number // resale-pool fees earned by the maker's positions (USDC only)
  positions: number
  liquidityShareBps: number // the maker's positions as a share of resale-pool liquidity
  lp: MakerLp | null // the maker's resale-pool liquidity: unlockable now, still vesting, permanent
}

// The maker's royalty, all from chain: maker royalty = poolFeeBps × (1 − protocolFeePct) × maker liquidity share.
export type ResaleRoyalty = {
  poolFeeBps: number // base fee on every resale trade (the DBC config's migrated pool fee)
  dynamicFee: boolean // a volatility fee is added on top when the price moves fast
  protocolFeePct: number // Meteora's share of each trade's fee, from the resale pool
  makerLiquidityBps: number
  makerRoyaltyBps: number // what the maker earns per trade now, before any volatility fee
}

export type ResaleView = {
  pool: string
  priceUsdc: number
  vouchersInPool: number
  usdcInPool: number
  maker: MakerEarnings
  floor: BackerFloor | null // exit value of one voucher, now and at the permanent floor
  royalty: ResaleRoyalty | null
}

const toNum = (bn: BN | bigint, decimals: number) => Number(bn.toString()) / 10 ** decimals

// `chain`: the resale pool state and chain time when the caller has already read them (readResale).
export async function readMakerEarnings(
  connection: Connection,
  record: CampaignRecord,
  chain?: { poolState: PoolState | null; now: number },
): Promise<MakerEarnings> {
  const fees = await dbcClient(connection).state.getPoolFeeBreakdown(record.pool)
  const out: MakerEarnings = {
    curveFeesUnclaimedUsdc: toNum(fees.creator.unclaimedQuoteFee, USDC_DECIMALS),
    curveFeesClaimedUsdc: toNum(fees.creator.claimedQuoteFee, USDC_DECIMALS),
    resaleFeesUnclaimedUsdc: 0,
    positions: 0,
    liquidityShareBps: 0,
    lp: null,
  }
  const cpAmm = new CpAmm(connection)
  const pool = await resolveResalePool(connection, record)
  const poolState = chain ? chain.poolState : await cpAmm.fetchPoolState(pool).catch(() => null)
  if (!poolState) return out
  const [positions, now] = await Promise.all([cpAmm.getUserPositionByPool(pool, new PublicKey(record.maker)), chain?.now ?? chainNow(connection)])
  out.positions = positions.length
  out.lp = makerLp(cpAmm, poolState, positions.map((p) => p.positionState), now)
  let liquidity = new BN(0)
  for (const p of positions) {
    out.resaleFeesUnclaimedUsdc += toNum(getUnClaimLpFee(poolState, p.positionState).feeTokenB, USDC_DECIMALS)
    const s = p.positionState
    liquidity = liquidity.add(s.unlockedLiquidity).add(s.vestedLiquidity).add(s.permanentLockedLiquidity)
  }
  if (!poolState.liquidity.isZero()) out.liquidityShareBps = liquidity.muln(10_000).div(poolState.liquidity).toNumber()
  return out
}

// One pool-state read and one Clock read serve the pool view, the maker's earnings and the backer floor.
export async function readResale(connection: Connection, record: CampaignRecord): Promise<ResaleView | null> {
  const cpAmm = new CpAmm(connection)
  const pool = await resolveResalePool(connection, record)
  const poolState = await cpAmm.fetchPoolState(pool).catch(() => null)
  if (!poolState) return null
  const clock = chainClock(connection)
  const [vaultA, vaultB, now, maker, config] = await Promise.all([
    getAccount(connection, poolState.tokenAVault),
    getAccount(connection, poolState.tokenBVault),
    clock,
    clock.then((c) => readMakerEarnings(connection, record, { poolState, now: c.unixTime })),
    readResaleConfig(connection, record.config).catch(() => null),
  ])
  let floor: BackerFloor | null = null
  try {
    floor = backerFloor(cpAmm, poolState, new PublicKey(record.baseMint), now)
  } catch {
    // a quote the SDK refuses (e.g. swaps disabled): the view still loads, without the floor
  }
  return {
    pool: pool.toBase58(),
    priceUsdc: getPriceFromSqrtPrice(poolState.sqrtPrice, VOUCHER_DECIMALS, USDC_DECIMALS).toNumber(),
    vouchersInPool: toNum(vaultA.amount, VOUCHER_DECIMALS),
    usdcInPool: toNum(vaultB.amount, USDC_DECIMALS),
    maker,
    floor,
    royalty: config && resaleRoyalty(config, poolState, maker.liquidityShareBps),
  }
}

// Pure: the royalty terms from the DBC config and the resale pool's own fee state.
export function resaleRoyalty(config: { poolFeeBps: number; dynamicFee: boolean }, poolState: PoolState, makerLiquidityBps: number): ResaleRoyalty {
  const protocolFeePct = poolState.poolFees.protocolFeePercent
  return {
    poolFeeBps: config.poolFeeBps,
    dynamicFee: config.dynamicFee,
    protocolFeePct,
    makerLiquidityBps,
    makerRoyaltyBps: makerRoyaltyBps(config.poolFeeBps, protocolFeePct, makerLiquidityBps),
  }
}

// What the campaign page polls (every 8 s per viewer): the resale pool and the maker's earnings, read
// at most once per pool per RESALE_TTL_MS, with concurrent reads of one pool sharing the RPC calls.
export const RESALE_TTL_MS = 5_000
export type ResaleAndEarnings = { resale: ResaleView | null; maker: MakerEarnings }
const resaleCache = ttlCache<ResaleAndEarnings>(RESALE_TTL_MS)

export function readResaleCached(connection: Connection, record: CampaignRecord): Promise<ResaleAndEarnings> {
  return resaleCache.get(record.pool, async () => {
    const resale = await readResale(connection, record)
    return { resale, maker: resale?.maker ?? (await readMakerEarnings(connection, record)) }
  })
}

async function quoteRaw(connection: Connection, record: CampaignRecord, side: ResaleSide, amount: number, bps: number) {
  const cpAmm = new CpAmm(connection)
  const pool = await resolveResalePool(connection, record)
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
  const pool = await resolveResalePool(connection, record)
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
