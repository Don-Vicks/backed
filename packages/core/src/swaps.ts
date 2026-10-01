// Shared pieces of every curve and resale swap: slippage, the chain clock, referrals, quote summaries.
// Kept free of SDK clients so chain.ts, live.ts and resale.ts can all import it without cycles.
import BN from 'bn.js'
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'
import { AccountLayout, AccountState, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { SwapQuote2Result } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { USDC_DECIMALS, VOUCHER_DECIMALS } from './engine'
import { SwapError } from './errors'

// One slippage setting for every swap the app builds. Requests may pick 10–500 bps (0.1–5%).
export const DEFAULT_SLIPPAGE_BPS = 100
export const MIN_SLIPPAGE_BPS = 10
export const MAX_SLIPPAGE_BPS = 500

export { SwapError } from './errors' // defined there so pure modules (voucher-units.ts) can throw it

export function slippageBps(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_SLIPPAGE_BPS
  const bps = Number(value)
  if (!Number.isInteger(bps) || bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) {
    throw new SwapError(`slippageBps must be a whole number from ${MIN_SLIPPAGE_BPS} to ${MAX_SLIPPAGE_BPS}`, 400)
  }
  return bps
}

// The SDK quote functions throw plain Errors; these are the ones a user can cause or fix.
export function toSwapError(e: unknown): unknown {
  const message = e instanceof Error ? e.message : ''
  if (/Virtual pool is completed/i.test(message)) return new SwapError('This campaign has reached its goal', 409)
  if (/Amount is zero/i.test(message)) return new SwapError('Amount is too small', 400)
  if (/Insufficient Liquidity|Not enough liquidity/i.test(message)) return new SwapError('Not enough liquidity on the curve for this amount', 409)
  return e
}

// Unix time as the programs see it (Clock sysvar). DBC fee schedules and DAMM v2 timestamp pools
// run on this clock; getBlockTime can be null or throw on pruned RPC nodes.
export async function chainNow(connection: Connection): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
  // Layout: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64
  if (!info || info.data.length < 40) return Math.floor(Date.now() / 1000)
  return Number(info.data.readBigInt64LE(32))
}

export type ChainClock = { slot: number; unixTime: number }

// Slot and chain time from the Clock sysvar in one read, for quotes that need both (DAMM v2 vesting
// and fee schedules). Unlike chainNow it never falls back to the wall clock: it throws.
export async function chainClock(connection: Connection): Promise<ChainClock> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
  if (!info || info.data.length < 40) throw new Error('Clock sysvar not readable')
  return { slot: Number(info.data.readBigUInt64LE(0)), unixTime: Number(info.data.readBigInt64LE(32)) }
}

// A `?ref=<wallet>` becomes that wallet's USDC account, or null when using it would break or game
// the buy: unparseable, the buyer themselves, or an account that is missing, not an SPL Token
// account, for another mint, or frozen. The buyer never pays rent for the referrer's account.
export async function resolveReferral(
  connection: Connection,
  usdcMint: PublicKey,
  ref: unknown, // straight from a query string or JSON body
  buyer: PublicKey,
): Promise<PublicKey | null> {
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
    return null // an RPC error (429, timeout) on the referrer's account costs the referral, not the buy
  }
}

// UI amount -> raw token units. Rejects what the routes would otherwise turn into a bn.js 500:
// non-finite input (JSON reads 1e400 as Infinity) and raw values past 2^53, beyond exact Number math.
export function toRawAmount(amount: number, decimals: number): BN {
  if (!Number.isFinite(amount) || amount < 0) throw new SwapError('Enter a valid amount', 400)
  const raw = Math.round(amount * 10 ** decimals)
  if (!Number.isSafeInteger(raw)) throw new SwapError('Amount is too large', 400)
  return new BN(raw)
}

// Raw token units -> a UI amount at full precision (1148420 at 6 decimals -> "1.14842").
export function formatRawAmount(raw: bigint | BN, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

const toNum = (bn: BN, decimals: number) => Number(bn.toString()) / 10 ** decimals
const totalFee = (q: SwapQuote2Result) => q.tradingFee.add(q.protocolFee).add(q.referralFee)

export type BuyQuote = {
  vouchers: number // expected vouchers out
  minVouchers: number // what the transaction accepts at worst (slippage applied)
  spentUsdc: number // USDC actually taken; below the amount asked when the buy reaches the goal
  capped: boolean // the buy stops at the goal and the rest stays in the wallet
  feeUsdc: number
  feePct: number // of spentUsdc
  slippageBps: number
}

// PartialFill buy quote (USDC in, vouchers out; fees are taken from the USDC side).
export function summarizeBuyQuote(q: SwapQuote2Result, bps: number): BuyQuote {
  const spent = toNum(q.includedFeeInputAmount, USDC_DECIMALS)
  const feeUsdc = toNum(totalFee(q), USDC_DECIMALS)
  return {
    vouchers: toNum(q.outputAmount, VOUCHER_DECIMALS),
    minVouchers: toNum(q.minimumAmountOut ?? new BN(0), VOUCHER_DECIMALS),
    spentUsdc: spent,
    capped: !q.amountLeft.isZero(),
    feeUsdc,
    feePct: spent > 0 ? (feeUsdc / spent) * 100 : 0,
    slippageBps: bps,
  }
}

export type SellQuote = {
  vouchers: number // vouchers sold
  usdc: number // expected USDC out, after fees
  minUsdc: number
  feeUsdc: number
  feePct: number // of the gross proceeds
  slippageBps: number
}

// ExactIn sell quote (vouchers in, USDC out; fees are taken from the USDC side).
export function summarizeSellQuote(q: SwapQuote2Result, bps: number): SellQuote {
  const usdc = toNum(q.outputAmount, USDC_DECIMALS)
  const feeUsdc = toNum(totalFee(q), USDC_DECIMALS)
  return {
    vouchers: toNum(q.includedFeeInputAmount, VOUCHER_DECIMALS),
    usdc,
    minUsdc: toNum(q.minimumAmountOut ?? new BN(0), USDC_DECIMALS),
    feeUsdc,
    feePct: usdc + feeUsdc > 0 ? (feeUsdc / (usdc + feeUsdc)) * 100 : 0,
    slippageBps: bps,
  }
}
