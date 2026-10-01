// Back by whole pre-order units on the curve. DBC swap2 in ExactOut mode buys exactly N vouchers for
// at most the quoted USDC plus slippage; the last buy before the goal switches to PartialFill and
// takes everything left, so whole-unit buys alone still complete the campaign (voucher-units.ts).
import BN from 'bn.js'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { AccountLayout, AccountState, TOKEN_PROGRAM_ID, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  SwapMode,
  swapQuoteExactOut,
  swapQuotePartialFill,
  type PoolConfig,
  type SwapQuote2Result,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { dbcClient } from './chain'
import { USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'
import { chainUnixTime } from './unlock'
import { UnitsError, checkUnits, maxUnitsLeft, planUnitsBuy, sweepMinOut, topUpRaw, unitsToRaw, type UnitsBuyMode } from './voucher-units'

// Slippage on the USDC a units buy may spend (ExactOut) or the vouchers it must get (sweep).
export const UNITS_SLIPPAGE_BPS = 100
const MIN_SLIPPAGE_BPS = 10
const MAX_SLIPPAGE_BPS = 500
const BPS = 10_000

const toNum = (bn: BN, decimals: number) => Number(bn.toString()) / 10 ** decimals
const toBig = (bn: BN) => BigInt(bn.toString())
const toBN = (n: bigint) => new BN(n.toString())

export function unitsSlippageBps(value: unknown): number {
  if (value === undefined || value === null || value === '') return UNITS_SLIPPAGE_BPS
  const bps = Number(value)
  if (!Number.isInteger(bps) || bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
    throw new UnitsError(`slippageBps must be a whole number from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}`, 400)
  }
  return bps
}

// The pool, its config and the chain clock its fee schedule runs on, read once per quote or build.
export type CurveState = { virtualPool: VirtualPool; config: PoolConfig; now: number }

export async function readCurve(connection: Connection, pool: PublicKey | string): Promise<CurveState> {
  const client = dbcClient(connection)
  const virtualPool = await client.state.getPool(pool)
  if (!virtualPool) throw new UnitsError('Unknown campaign pool', 400)
  const [config, now] = await Promise.all([client.state.getPoolConfig(virtualPool.poolState.config), chainUnixTime(connection)])
  if (!config) throw new Error(`config ${virtualPool.poolState.config.toBase58()} not found`)
  return { virtualPool, config, now }
}

const isCompleted = ({ virtualPool, config }: CurveState) =>
  Number(virtualPool.poolState.isMigrated) === 1 || virtualPool.poolState.quoteReserve.gte(config.migrationQuoteThreshold)

// Everything left on the curve before the goal and what taking it costs: a PartialFill quote offering
// far more USDC than the rest of the curve can take (DBC fees stay below 100%, so 100x always covers it).
function sweepQuote(curve: CurveState, hasReferral: boolean): SwapQuote2Result {
  const { virtualPool, config, now } = curve
  const quoteLeft = config.migrationQuoteThreshold.sub(virtualPool.poolState.quoteReserve)
  const offer = quoteLeft.muln(100).addn(10 ** USDC_DECIMALS)
  return swapQuotePartialFill(virtualPool, config, false, offer, 0, hasReferral, new BN(now), false)
}

// Vouchers left on the curve before the goal (raw). 0 once the goal is reached.
export function unitsLeftRaw(curve: CurveState): bigint {
  if (isCompleted(curve)) return BigInt(0)
  return toBig(sweepQuote(curve, false).outputAmount)
}

export type UnitsQuoteOptions = { slippageBps?: number; hasReferral?: boolean }

// A units buy, planned against one read of the curve. Amounts are raw; quoteSummary() makes them human.
export type UnitsPlan = {
  mode: UnitsBuyMode
  amountOut: BN // vouchers delivered
  amountIn: BN // expected USDC spent, fee included
  maxAmountIn: BN // ExactOut: the most the transaction may spend. Sweep: what it offers (the unspent rest stays)
  minAmountOut: BN // sweep only: the fewest vouchers it accepts (at least the units asked for); ExactOut delivers amountOut or fails
  fee: BN
  remaining: BN // vouchers left on the curve before this buy
  slippageBps: number
}

export function planUnits(curve: CurveState, wantRaw: bigint, opts: UnitsQuoteOptions = {}): UnitsPlan {
  const slippageBps = unitsSlippageBps(opts.slippageBps)
  const hasReferral = !!opts.hasReferral
  if (isCompleted(curve)) throw new UnitsError('This campaign has reached its goal', 409)
  const sweep = sweepQuote(curve, hasReferral)
  const remaining = sweep.outputAmount
  const mode = planUnitsBuy(wantRaw, toBig(remaining))
  if (mode === 'sweep') {
    // Offer the sweep cost plus slippage; DBC stops at the goal and takes only what it needs. The
    // minimum out never drops below the units asked for, so a front-run fails it (sweepMinOut).
    return {
      mode,
      amountOut: remaining,
      amountIn: sweep.includedFeeInputAmount,
      maxAmountIn: sweep.includedFeeInputAmount.muln(BPS + slippageBps).divn(BPS).addn(1),
      minAmountOut: toBN(sweepMinOut(wantRaw, toBig(remaining), slippageBps)),
      fee: sweep.tradingFee.add(sweep.protocolFee).add(sweep.referralFee),
      remaining,
      slippageBps,
    }
  }
  const { virtualPool, config, now } = curve
  const q = swapQuoteExactOut(virtualPool, config, false, toBN(wantRaw), slippageBps, hasReferral, new BN(now), false)
  return {
    mode,
    amountOut: toBN(wantRaw),
    amountIn: q.includedFeeInputAmount,
    maxAmountIn: q.maximumAmountIn ?? q.includedFeeInputAmount,
    minAmountOut: toBN(wantRaw),
    fee: q.tradingFee.add(q.protocolFee).add(q.referralFee),
    remaining,
    slippageBps,
  }
}

export type UnitsQuote = {
  mode: UnitsBuyMode
  vouchers: number // exactly the units asked for, or everything left when this buy completes the goal
  usdc: number // expected USDC spent, fee included
  maxUsdc: number // the most the transaction can spend
  feeUsdc: number
  feePct: number // of usdc
  completesGoal: boolean
  unitsLeft: number // vouchers left on the curve before this buy
  maxUnits: number // the most whole units one buy can ask for now
  slippageBps: number
}

export function summarizeUnits(plan: UnitsPlan): UnitsQuote {
  const usdc = toNum(plan.amountIn, USDC_DECIMALS)
  const feeUsdc = toNum(plan.fee, USDC_DECIMALS)
  return {
    mode: plan.mode,
    vouchers: toNum(plan.amountOut, VOUCHER_DECIMALS),
    usdc,
    maxUsdc: toNum(plan.maxAmountIn, USDC_DECIMALS),
    feeUsdc,
    feePct: usdc > 0 ? (feeUsdc / usdc) * 100 : 0,
    completesGoal: plan.mode === 'sweep',
    unitsLeft: toNum(plan.remaining, VOUCHER_DECIMALS),
    maxUnits: maxUnitsLeft(toBig(plan.remaining)),
    slippageBps: plan.slippageBps,
  }
}

export async function quoteBuyUnits(connection: Connection, pool: PublicKey | string, units: number, opts: UnitsQuoteOptions = {}): Promise<UnitsQuote> {
  const want = unitsToRaw(checkUnits(units))
  return summarizeUnits(planUnits(await readCurve(connection, pool), want, opts))
}

// The vouchers that turn a wallet's fractional balance into the next whole unit (raw), or 0.
export async function topUpNeeded(connection: Connection, owner: PublicKey, baseMint: PublicKey): Promise<bigint> {
  const account = await getAccount(connection, getAssociatedTokenAddressSync(baseMint, owner)).catch(() => null)
  return topUpRaw(account ? account.amount : BigInt(0))
}

export async function quoteTopUp(connection: Connection, pool: PublicKey | string, owner: PublicKey, baseMint: PublicKey, opts: UnitsQuoteOptions = {}) {
  const want = await topUpNeeded(connection, owner, baseMint)
  if (want === BigInt(0)) throw new UnitsError('Your vouchers are already whole', 400)
  return summarizeUnits(planUnits(await readCurve(connection, pool), want, opts))
}

// The swap2 transaction for a plan: ExactOut with the quote's maximumAmountIn, or, for the last buy,
// PartialFill up to the goal with a quote-derived minimum out.
export async function buildUnitsSwapTx(
  connection: Connection,
  buyer: PublicKey,
  pool: PublicKey,
  plan: UnitsPlan,
  referralTokenAccount: PublicKey | null = null,
): Promise<Transaction> {
  const common = { owner: buyer, pool, swapBaseForQuote: false, referralTokenAccount }
  const client = dbcClient(connection)
  return plan.mode === 'exactOut'
    ? client.pool.swap2({ ...common, swapMode: SwapMode.ExactOut, amountOut: plan.amountOut, maximumAmountIn: plan.maxAmountIn })
    : client.pool.swap2({ ...common, swapMode: SwapMode.PartialFill, amountIn: plan.maxAmountIn, minimumAmountOut: plan.minAmountOut })
}

export type BuyUnitsOptions = { referral?: PublicKey | null; slippageBps?: number }

// Back exactly `units` pre-orders (or, as the last buy, everything left up to the goal).
export async function buildBuyUnitsTx(connection: Connection, buyer: PublicKey, pool: PublicKey, units: number, opts: BuyUnitsOptions = {}) {
  const want = unitsToRaw(checkUnits(units))
  const plan = planUnits(await readCurve(connection, pool), want, { slippageBps: opts.slippageBps, hasReferral: !!opts.referral })
  return { tx: await buildUnitsSwapTx(connection, buyer, pool, plan, opts.referral ?? null), plan, quote: summarizeUnits(plan) }
}

// Top a fractional balance (left by a USDC-amount buy) up to the next whole voucher.
export async function buildTopUpTx(connection: Connection, buyer: PublicKey, pool: PublicKey, baseMint: PublicKey, opts: BuyUnitsOptions = {}) {
  const want = await topUpNeeded(connection, buyer, baseMint)
  if (want === BigInt(0)) throw new UnitsError('Your vouchers are already whole', 400)
  const plan = planUnits(await readCurve(connection, pool), want, { slippageBps: opts.slippageBps, hasReferral: !!opts.referral })
  return { tx: await buildUnitsSwapTx(connection, buyer, pool, plan, opts.referral ?? null), plan, quote: summarizeUnits(plan) }
}

// A `ref` wallet's USDC account, or null when using it would break or game the buy: unparseable, the
// buyer themselves, or an account that is missing, not an SPL Token account, for another mint, or
// frozen. The buyer never pays rent for the referrer's account, and a failed lookup costs the
// referral, not the buy.
export async function unitsReferral(connection: Connection, usdcMint: PublicKey, ref: unknown, buyer: PublicKey): Promise<PublicKey | null> {
  if (typeof ref !== 'string' || !ref) return null
  let referrer: PublicKey
  try {
    referrer = new PublicKey(ref)
  } catch {
    return null
  }
  if (referrer.equals(buyer)) return null
  const ata = getAssociatedTokenAddressSync(usdcMint, referrer, true)
  try {
    const info = await connection.getAccountInfo(ata)
    if (!info || !info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length < AccountLayout.span) return null
    const account = AccountLayout.decode(info.data.subarray(0, AccountLayout.span))
    if (!account.mint.equals(usdcMint) || account.state !== AccountState.Initialized) return null
    return ata
  } catch {
    return null
  }
}

// The launch (drop-bot) fee right now and when it reaches the normal fee, for warnings in the UI and
// the Blink. From the pool's activation time and the campaign's window.
export function launchFeeWindow(curve: CurveState, windowSec: number): { endsAt: number; secondsLeft: number } {
  const endsAt = Number(curve.virtualPool.poolState.activationPoint.toString()) + windowSec
  return { endsAt, secondsLeft: Math.max(0, endsAt - curve.now) }
}
