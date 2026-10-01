import { test } from 'node:test'
import assert from 'node:assert/strict'
import BN from 'bn.js'
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, type AccountInfo } from '@solana/web3.js'
import { ACCOUNT_SIZE, AccountLayout, AccountState, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import type { SwapQuote2Result } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
  DEFAULT_SLIPPAGE_BPS,
  SwapError,
  chainNow,
  resolveReferral,
  slippageBps,
  summarizeBuyQuote,
  summarizeSellQuote,
  toSwapError,
} from '../swaps'

// A Connection that only answers getAccountInfo from a map.
function fakeConnection(accounts: Map<string, AccountInfo<Buffer>>): Connection {
  return { getAccountInfo: async (key: PublicKey) => accounts.get(key.toBase58()) ?? null } as unknown as Connection
}

function tokenAccount(mint: PublicKey, owner: PublicKey, state = AccountState.Initialized, program = TOKEN_PROGRAM_ID): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  AccountLayout.encode(
    {
      mint,
      owner,
      amount: BigInt(0),
      delegateOption: 0,
      delegate: PublicKey.default,
      state,
      isNativeOption: 0,
      isNative: BigInt(0),
      delegatedAmount: BigInt(0),
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  )
  return { data, owner: program, lamports: 2_039_280, executable: false, rentEpoch: 0 }
}

test('slippage defaults to 100 bps and only accepts whole bps from 10 to 500', () => {
  assert.equal(DEFAULT_SLIPPAGE_BPS, 100)
  assert.equal(slippageBps(undefined), 100)
  assert.equal(slippageBps(null), 100)
  assert.equal(slippageBps(''), 100)
  assert.equal(slippageBps(10), 10)
  assert.equal(slippageBps('250'), 250)
  assert.equal(slippageBps(500), 500)
  for (const bad of [0, 1, 9, 501, 1.5, 'x', -100]) {
    assert.throws(() => slippageBps(bad), (e: unknown) => e instanceof SwapError && e.status === 400, String(bad))
  }
})

test('SDK quote errors become SwapErrors with an HTTP status', () => {
  const completed = toSwapError(new Error('Virtual pool is completed'))
  assert.ok(completed instanceof SwapError && completed.status === 409)
  const zero = toSwapError(new Error('Amount is zero'))
  assert.ok(zero instanceof SwapError && zero.status === 400)
  const liquidity = toSwapError(new Error('Insufficient Liquidity'))
  assert.ok(liquidity instanceof SwapError && liquidity.status === 409)
  const other = new Error('Math overflow')
  assert.equal(toSwapError(other), other)
})

test('chainNow reads unix_timestamp from the Clock sysvar', async () => {
  const data = Buffer.alloc(40)
  data.writeBigUInt64LE(BigInt(123), 0) // slot
  data.writeBigInt64LE(BigInt(1_700_000_000), 32)
  const clock: AccountInfo<Buffer> = { data, owner: PublicKey.default, lamports: 1, executable: false, rentEpoch: 0 }
  assert.equal(await chainNow(fakeConnection(new Map([[SYSVAR_CLOCK_PUBKEY.toBase58(), clock]]))), 1_700_000_000)
  // No clock account (a broken RPC): fall back to the local clock rather than 0, the maximum fee.
  const now = Math.floor(Date.now() / 1000)
  assert.ok(Math.abs((await chainNow(fakeConnection(new Map()))) - now) <= 2)
})

test('resolveReferral returns the referrer USDC account only when it is usable', async () => {
  const usdc = Keypair.generate().publicKey
  const otherMint = Keypair.generate().publicKey
  const buyer = Keypair.generate().publicKey
  const referrer = Keypair.generate().publicKey
  const ata = getAssociatedTokenAddressSync(usdc, referrer, true)
  const withAccount = (info: AccountInfo<Buffer>) => fakeConnection(new Map([[ata.toBase58(), info]]))

  const good = withAccount(tokenAccount(usdc, referrer))
  assert.deepEqual(await resolveReferral(good, usdc, referrer.toBase58(), buyer), ata)

  // Bad input never throws: the buy goes ahead without a referral.
  for (const ref of [undefined, null, '', 'not-a-key', 42, {}]) {
    assert.equal(await resolveReferral(good, usdc, ref, buyer), null, String(ref))
  }
  assert.equal(await resolveReferral(good, usdc, buyer.toBase58(), buyer), null, 'self-referral')
  assert.equal(await resolveReferral(fakeConnection(new Map()), usdc, referrer.toBase58(), buyer), null, 'missing account')
  assert.equal(await resolveReferral(withAccount(tokenAccount(otherMint, referrer)), usdc, referrer.toBase58(), buyer), null, 'wrong mint')
  assert.equal(await resolveReferral(withAccount(tokenAccount(usdc, referrer, AccountState.Frozen)), usdc, referrer.toBase58(), buyer), null, 'frozen')
  assert.equal(
    await resolveReferral(withAccount(tokenAccount(usdc, referrer, AccountState.Initialized, TOKEN_2022_PROGRAM_ID)), usdc, referrer.toBase58(), buyer),
    null,
    'not owned by the Token program',
  )
})

const raw = (n: number) => new BN(Math.round(n * 1e6))
function quote(q: { in: number; out: number; left?: number; min: number; trading: number; protocol: number; referral?: number }): SwapQuote2Result {
  return {
    amountLeft: raw(q.left ?? 0),
    includedFeeInputAmount: raw(q.in),
    excludedFeeInputAmount: raw(q.in - q.trading - q.protocol - (q.referral ?? 0)),
    outputAmount: raw(q.out),
    nextSqrtPrice: new BN(1),
    tradingFee: raw(q.trading),
    protocolFee: raw(q.protocol),
    referralFee: raw(q.referral ?? 0),
    minimumAmountOut: raw(q.min),
  } as SwapQuote2Result
}

test('buy quote reports the USDC actually spent and the fee against it', () => {
  const full = summarizeBuyQuote(quote({ in: 10, out: 2.4, min: 2.376, trading: 0.08, protocol: 0.02 }), 100)
  assert.deepEqual(full, { vouchers: 2.4, minVouchers: 2.376, spentUsdc: 10, capped: false, feeUsdc: 0.1, feePct: 1, slippageBps: 100 })

  // 1000 asked, 35 spent: the buy reaches the goal and the fee is a share of the 35.
  const capped = summarizeBuyQuote(quote({ in: 35, out: 6.2, left: 964.65, min: 6.138, trading: 0.28, protocol: 0.07 }), 100)
  assert.equal(capped.capped, true)
  assert.equal(capped.spentUsdc, 35)
  assert.ok(Math.abs(capped.feePct - 1) < 1e-9)
})

test('sell quote reports net USDC and the fee against the gross proceeds', () => {
  const q = summarizeSellQuote(quote({ in: 2, out: 9.9, min: 9.801, trading: 0.08, protocol: 0.02 }), 100)
  assert.equal(q.vouchers, 2)
  assert.equal(q.usdc, 9.9)
  assert.equal(q.minUsdc, 9.801)
  assert.ok(Math.abs(q.feeUsdc - 0.1) < 1e-9)
  assert.ok(Math.abs(q.feePct - 1) < 1e-9)
})
