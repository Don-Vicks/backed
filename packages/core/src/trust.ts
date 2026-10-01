// Maker trust tier. Scores public mainnet history of the maker's wallet and caps how much of the
// raise the maker can take upfront at graduation. Devnet wallets have no history, so the signals
// are always read from mainnet (read-only).
import { Connection, PublicKey } from '@solana/web3.js'
import { parseNetwork } from './network'

export type TrustTierName = 'A' | 'B' | 'C'

export type TrustSignals = {
  walletAgeDays: number // a lower bound when truncated
  txCount: number // signatures seen, capped by the history walk
  activeDays: number // distinct UTC days among those signatures: a burst of self-transfers is one day
  fundedByFreshWallet: boolean // first funder was itself created within 7 days of funding
  truncated: boolean // history is longer than the walk: the true first transaction (and funder) is unknown
  partial: boolean // the time budget ran out (a slow RPC), not the page limit: a later lookup may get further
}

export type TrustResult = {
  tier: TrustTierName
  score: number
  maxMakerSharePct: number
  reasons: string[]
  signals: TrustSignals
}

export const MAX_MAKER_SHARE: Record<TrustTierName, number> = { A: 40, B: 25, C: 10 }
export const TIER_A_MIN_SCORE = 65
export const TIER_B_MIN_SCORE = 40
// Transactions count only when spread over time, so a wallet can't buy a tier with one sitting of
// self-transfers: 500+ need 30 active days, 50+ need 7.
export const ACTIVE_DAYS_FOR_500_TX = 30
export const ACTIVE_DAYS_FOR_50_TX = 7

export function scoreSignals(signals: TrustSignals): TrustResult {
  const reasons: string[] = []
  let score = 0

  // A truncated walk only proves the wallet is at least this old, and it is scored as exactly that.
  const age = `${signals.truncated ? '≥ ' : ''}${Math.floor(signals.walletAgeDays)} days`
  if (signals.walletAgeDays >= 365) {
    score += 40
    reasons.push(`Wallet is ${age} old (+40)`)
  } else if (signals.walletAgeDays >= 90) {
    score += 25
    reasons.push(`Wallet is ${age} old (+25)`)
  } else if (signals.walletAgeDays >= 14) {
    score += 10
    reasons.push(`Wallet is ${age} old (+10)`)
  } else {
    reasons.push(`Wallet is new: ${age} (+0)`)
  }

  const days = `${signals.activeDays} active day${signals.activeDays === 1 ? '' : 's'}`
  if (signals.txCount >= 500 && signals.activeDays >= ACTIVE_DAYS_FOR_500_TX) {
    score += 25
    reasons.push(`${signals.txCount}+ transactions over ${days} (+25)`)
  } else if (signals.txCount >= 50 && signals.activeDays >= ACTIVE_DAYS_FOR_50_TX) {
    score += 15
    reasons.push(`${signals.txCount} transactions over ${days} (+15)`)
  } else if (signals.txCount >= 50) {
    reasons.push(`${signals.txCount} transactions, but only over ${days} (+0)`)
  } else {
    reasons.push(`Only ${signals.txCount} transactions (+0)`)
  }

  if (signals.fundedByFreshWallet) {
    score -= 20
    reasons.push('First funded by a wallet that was itself brand new (−20)')
  }

  if (signals.partial) reasons.push('The history check ran out of time, so this score is partial. Check again for a complete one.')
  else if (signals.truncated) reasons.push('History is too long to walk to the first transaction, so the first funder is not checked')

  // Only on-chain signals count: A needs both a year of history and 500+ transactions over 30+ days.
  score = Math.max(0, Math.min(100, score))
  const tier: TrustTierName = score >= TIER_A_MIN_SCORE ? 'A' : score >= TIER_B_MIN_SCORE ? 'B' : 'C'
  return { tier, score, maxMakerSharePct: MAX_MAKER_SHARE[tier], reasons, signals }
}

// How far back a lookup walks: up to HISTORY_PAGES pages of signatures, within one time budget shared by
// the wallet and its funder. Past either limit the result is marked truncated rather than guessed; past
// the time budget it is also partial. Each RPC call is raced against the budget, so a hung call can't
// hold the request open.
const PAGE_SIZE = 1000
export const HISTORY_PAGES = 10
export const HISTORY_BUDGET_MS = 8_000

type HistoryLimits = { maxPages: number; deadline: number }

const TIMED_OUT = Symbol('timed out')

// The call's result, or TIMED_OUT once the deadline passes (the call itself is left to settle unheard).
function beforeDeadline<T>(call: Promise<T>, deadline: number): Promise<T | typeof TIMED_OUT> {
  call.catch(() => {}) // a failure after the deadline has no one listening
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, deadline - Date.now()))
  })
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer))
}

async function walkHistory(connection: Pick<Connection, 'getSignaturesForAddress'>, address: PublicKey, limits: HistoryLimits) {
  let before: string | undefined
  let count = 0
  let oldest: { signature: string; blockTime?: number | null } | undefined
  const days = new Set<number>()
  const stop = (timedOut: boolean) => ({ count, oldest, activeDays: days.size, truncated: true, timedOut })
  for (let page = 0; ; page++) {
    if (page >= limits.maxPages) return stop(false)
    if (Date.now() >= limits.deadline) return stop(true)
    const sigs = await beforeDeadline(connection.getSignaturesForAddress(address, { before, limit: PAGE_SIZE }), limits.deadline)
    if (sigs === TIMED_OUT) return stop(true)
    if (sigs.length === 0) break
    count += sigs.length
    for (const s of sigs) if (s.blockTime) days.add(Math.floor(s.blockTime / 86400))
    oldest = sigs[sigs.length - 1]
    before = oldest.signature
    if (sigs.length < PAGE_SIZE) break
  }
  return { count, oldest, activeDays: days.size, truncated: false, timedOut: false }
}

// The first transaction of a wallet is usually the SOL transfer that funded it.
async function firstFunder(connection: Pick<Connection, 'getParsedTransaction'>, signature: string, wallet: PublicKey, deadline: number) {
  const tx = await beforeDeadline(connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 }), deadline)
  if (tx === TIMED_OUT) return TIMED_OUT
  for (const ix of tx?.transaction.message.instructions ?? []) {
    if ('parsed' in ix && ix.program === 'system' && ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info
      if (info.destination === wallet.toBase58()) return new PublicKey(info.source)
    }
  }
  return null
}

// Throws when the RPC fails, or times out before reading anything: callers must not mistake a failed
// lookup for a new wallet.
export async function readTrustSignals(
  mainnet: Pick<Connection, 'getSignaturesForAddress' | 'getParsedTransaction'>,
  wallet: PublicKey,
  opts: { maxPages?: number; budgetMs?: number } = {},
): Promise<TrustSignals> {
  const now = Date.now() / 1000
  const limits = { maxPages: opts.maxPages ?? HISTORY_PAGES, deadline: Date.now() + (opts.budgetMs ?? HISTORY_BUDGET_MS) }
  const { count, oldest, activeDays, truncated, timedOut } = await walkHistory(mainnet, wallet, limits)
  if (timedOut && count === 0) throw new Error('trust lookup timed out before reading any history')
  const walletAgeDays = oldest?.blockTime ? (now - oldest.blockTime) / 86400 : 0

  // Only a complete walk reaches the funding transaction; a truncated one stops somewhere in between.
  let fundedByFreshWallet = false
  let partial = timedOut
  if (!truncated && oldest?.blockTime) {
    const funder = await firstFunder(mainnet, oldest.signature, wallet, limits.deadline)
    if (funder === TIMED_OUT) partial = true
    else if (funder) {
      const funderHistory = await walkHistory(mainnet, funder, limits)
      const funderBorn = funderHistory.oldest?.blockTime
      partial = funderHistory.timedOut
      fundedByFreshWallet = !funderHistory.truncated && !!funderBorn && oldest.blockTime - funderBorn < 7 * 86400
    }
  }

  return { walletAgeDays, txCount: count, activeDays, fundedByFreshWallet, truncated, partial }
}

export async function trustTier(mainnet: Connection, wallet: PublicKey) {
  return scoreSignals(await readTrustSignals(mainnet, wallet))
}

// Localnet only: TRUST_FIXTURES='{"<wallet>": {"walletAgeDays": 800, "txCount": 900}}' stands in for
// mainnet history so tests can reach tiers A and B. Ignored on every other network. Without activeDays,
// the transactions are taken as spread over the wallet's life (one a day at most).
export function trustFixture(wallet: string, env: NodeJS.ProcessEnv = process.env): TrustSignals | null {
  if (!env.TRUST_FIXTURES?.trim() || parseNetwork(env.NETWORK) !== 'localnet') return null
  let fixtures: Record<string, Partial<TrustSignals>>
  try {
    fixtures = JSON.parse(env.TRUST_FIXTURES)
  } catch {
    throw new Error('TRUST_FIXTURES is not valid JSON')
  }
  const f = fixtures[wallet]
  if (!f) return null
  const walletAgeDays = f.walletAgeDays ?? 0
  const txCount = f.txCount ?? 0
  return {
    walletAgeDays,
    txCount,
    activeDays: f.activeDays ?? Math.min(txCount, Math.ceil(walletAgeDays)),
    fundedByFreshWallet: f.fundedByFreshWallet ?? false,
    truncated: f.truncated ?? false,
    partial: f.partial ?? false,
  }
}
