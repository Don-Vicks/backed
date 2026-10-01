import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { HISTORY_PAGES, readTrustSignals, scoreSignals, trustFixture, type TrustSignals } from '../trust'

const signals = (s: Partial<TrustSignals>): TrustSignals => ({
  walletAgeDays: 0,
  txCount: 0,
  activeDays: Math.min(s.txCount ?? 0, 60), // activity spread over two months unless a test says otherwise
  fundedByFreshWallet: false,
  truncated: false,
  partial: false,
  ...s,
})

test('brand-new wallet with no history is tier C', () => {
  const r = scoreSignals(signals({ walletAgeDays: 2, txCount: 3 }))
  assert.equal(r.tier, 'C')
  assert.equal(r.maxMakerSharePct, 10)
})

test('tier A takes a year of history and 500+ transactions; nothing self-attested counts', () => {
  assert.equal(scoreSignals(signals({ walletAgeDays: 800, txCount: 1000 })).tier, 'A')
  assert.equal(scoreSignals(signals({ walletAgeDays: 800, txCount: 1000 })).score, 65)
  assert.equal(scoreSignals(signals({ walletAgeDays: 800, txCount: 100 })).tier, 'B')
  assert.equal(scoreSignals(signals({ walletAgeDays: 200, txCount: 1000 })).tier, 'B')
  // The old self-attested "verified social" flag is ignored if a stale client still sends it.
  const r = scoreSignals({ ...signals({ walletAgeDays: 200, txCount: 60 }), verifiedSocial: true } as TrustSignals)
  assert.equal(r.tier, 'B')
  assert.ok(!r.reasons.some((x) => /social/i.test(x)))
})

test('transactions count only when spread over days: a burst of self-transfers buys nothing', () => {
  // An old wallet topped up with 1000 transactions in one sitting: the age counts, the burst does not.
  const farmed = scoreSignals(signals({ walletAgeDays: 800, txCount: 1000, activeDays: 1 }))
  assert.equal(farmed.tier, 'B')
  assert.equal(farmed.score, 40)
  assert.ok(farmed.reasons.includes('1000 transactions, but only over 1 active day (+0)'), farmed.reasons.join(' | '))
  assert.equal(scoreSignals(signals({ walletAgeDays: 800, txCount: 1000, activeDays: 29 })).tier, 'B', '500+ need 30 active days')
  assert.equal(scoreSignals(signals({ walletAgeDays: 800, txCount: 1000, activeDays: 29 })).score, 55, '...but 7+ days earn the 50+ step')
  assert.equal(scoreSignals(signals({ walletAgeDays: 800, txCount: 1000, activeDays: 30 })).tier, 'A')
})

test('being funded by a fresh wallet costs a tier', () => {
  const clean = scoreSignals(signals({ walletAgeDays: 400, txCount: 60 }))
  const sus = scoreSignals(signals({ walletAgeDays: 400, txCount: 60, fundedByFreshWallet: true }))
  assert.equal(clean.tier, 'B')
  assert.equal(sus.tier, 'C')
  assert.ok(sus.reasons.some((r) => r.includes('brand new')))
})

test('a truncated history reports its age as a lower bound', () => {
  const r = scoreSignals(signals({ walletAgeDays: 120.4, txCount: 10_000, truncated: true }))
  assert.ok(r.reasons.includes('Wallet is ≥ 120 days old (+25)'), r.reasons.join(' | '))
  assert.ok(r.reasons.some((x) => /first funder is not checked/.test(x)))
  assert.equal(r.tier, 'B')
})

test('TRUST_FIXTURES stand in for mainnet history on localnet only', () => {
  const TRUST_FIXTURES = JSON.stringify({ MAKER: { walletAgeDays: 800, txCount: 900, verifiedSocial: true }, BAD: { walletAgeDays: 2 } })
  const a = trustFixture('MAKER', { NETWORK: 'localnet', TRUST_FIXTURES })
  assert.deepEqual(a, { walletAgeDays: 800, txCount: 900, activeDays: 800, fundedByFreshWallet: false, truncated: false, partial: false })
  assert.equal(scoreSignals(a!).tier, 'A')
  assert.equal(scoreSignals(trustFixture('BAD', { NETWORK: 'localnet', TRUST_FIXTURES })!).tier, 'C')
  assert.equal(trustFixture('OTHER', { NETWORK: 'localnet', TRUST_FIXTURES }), null)
  assert.equal(trustFixture('MAKER', { NETWORK: 'devnet', TRUST_FIXTURES }), null)
  assert.equal(trustFixture('MAKER', { NETWORK: 'mainnet', TRUST_FIXTURES }), null)
  assert.throws(() => trustFixture('MAKER', { NETWORK: 'localnet', TRUST_FIXTURES: '{' }), /not valid JSON/)
})

// A Connection stand-in serving `history[address]` signatures newest first, 1000 a page, one minute
// apart going back from now. The first key of `history` is the wallet the funder funded.
// hangAfterPages / hangParsed: calls past that point never answer, like a stuck RPC connection.
const never = () => new Promise<never>(() => {})
function mockConnection(history: Record<string, number>, opts: { funder?: PublicKey; pageDelayMs?: number; hangAfterPages?: number; hangParsed?: boolean } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const calls = { pages: [] as string[], parsed: 0 }
  const conn = {
    async getSignaturesForAddress(address: PublicKey, o?: { before?: string; limit?: number }) {
      calls.pages.push(address.toBase58())
      if (opts.hangAfterPages !== undefined && calls.pages.length > opts.hangAfterPages) return never()
      if (opts.pageDelayMs) await new Promise((r) => setTimeout(r, opts.pageDelayMs))
      const total = history[address.toBase58()] ?? 0
      const start = o?.before ? Number(o.before.split(':')[1]) + 1 : 0
      const end = Math.min(total, start + (o?.limit ?? 1000))
      return Array.from({ length: Math.max(0, end - start) }, (_, k) => ({ signature: `${address.toBase58()}:${start + k}`, blockTime: now - (start + k) * 60 }))
    },
    async getParsedTransaction() {
      calls.parsed++
      if (opts.hangParsed) return never()
      const destination = Object.keys(history)[0]
      const instructions = opts.funder ? [{ program: 'system', parsed: { type: 'transfer', info: { source: opts.funder.toBase58(), destination } } }] : []
      return { transaction: { message: { instructions } } }
    },
  }
  return { conn: conn as unknown as Parameters<typeof readTrustSignals>[0], calls }
}

test('history walk pages back to the first transaction and checks its funder', async () => {
  const wallet = Keypair.generate().publicKey
  const funder = Keypair.generate().publicKey
  const { conn, calls } = mockConnection({ [wallet.toBase58()]: 2500, [funder.toBase58()]: 10 }, { funder })
  const s = await readTrustSignals(conn, wallet)
  assert.equal(s.truncated, false)
  assert.equal(s.partial, false)
  assert.equal(s.txCount, 2500)
  assert.ok(s.activeDays >= 2 && s.activeDays <= 3, `${s.activeDays} active days`) // 2500 minutes
  assert.equal(calls.pages.filter((p) => p === wallet.toBase58()).length, 3)
  assert.ok(Math.abs(s.walletAgeDays - (2499 * 60) / 86400) < 0.01)
  assert.equal(calls.parsed, 1)
  // The funder's first transaction is newer than the wallet's: it was brand new when it funded it.
  assert.equal(s.fundedByFreshWallet, true)
})

test('history longer than the page limit is truncated, and the first funder is not guessed', async () => {
  const wallet = Keypair.generate().publicKey
  const { conn, calls } = mockConnection({ [wallet.toBase58()]: HISTORY_PAGES * 1000 + 5 }, { funder: Keypair.generate().publicKey })
  const s = await readTrustSignals(conn, wallet)
  assert.equal(s.truncated, true)
  assert.equal(s.partial, false, 'the page limit is not a slow RPC: the result is complete as far as it goes')
  assert.equal(s.txCount, HISTORY_PAGES * 1000)
  assert.equal(calls.pages.length, HISTORY_PAGES)
  assert.equal(calls.parsed, 0, 'no first-funder lookup on a truncated walk')
  assert.equal(s.fundedByFreshWallet, false)
  // The age is that of the oldest signature reached: a lower bound.
  assert.ok(Math.abs(s.walletAgeDays - ((HISTORY_PAGES * 1000 - 1) * 60) / 86400) < 0.01)
})

test('a walk that runs out of time is truncated and partial', async () => {
  const wallet = Keypair.generate().publicKey
  const { conn, calls } = mockConnection({ [wallet.toBase58()]: 5000 }, { pageDelayMs: 30 })
  const s = await readTrustSignals(conn, wallet, { budgetMs: 40 })
  assert.equal(s.truncated, true)
  assert.equal(s.partial, true)
  assert.ok(calls.pages.length < 5, `walked ${calls.pages.length} pages`)
  assert.ok(scoreSignals(s).reasons.some((r) => /ran out of time/.test(r)))
})

test('a hung RPC call is bounded by the budget', async () => {
  const wallet = Keypair.generate().publicKey
  const started = Date.now()
  const s = await readTrustSignals(mockConnection({ [wallet.toBase58()]: 5000 }, { hangAfterPages: 1 }).conn, wallet, { budgetMs: 100 })
  assert.ok(Date.now() - started < 1000, 'returned at the deadline, not when the call answers')
  assert.deepEqual([s.txCount, s.truncated, s.partial], [1000, true, true])

  // Nothing read at all is a failed lookup, not a new wallet.
  await assert.rejects(readTrustSignals(mockConnection({ [wallet.toBase58()]: 5000 }, { hangAfterPages: 0 }).conn, wallet, { budgetMs: 50 }), /timed out/)

  // A hung funder lookup leaves the funder unchecked and the result partial.
  const funded = await readTrustSignals(mockConnection({ [wallet.toBase58()]: 10 }, { funder: Keypair.generate().publicKey, hangParsed: true }).conn, wallet, {
    budgetMs: 50,
  })
  assert.deepEqual([funded.truncated, funded.partial, funded.fundedByFreshWallet], [false, true, false])
})

test('an RPC failure is an error, never a brand-new wallet', async () => {
  const conn = {
    getSignaturesForAddress: async () => {
      throw new Error('429 Too Many Requests')
    },
  } as unknown as Parameters<typeof readTrustSignals>[0]
  await assert.rejects(readTrustSignals(conn, Keypair.generate().publicKey), /429/)
})
