// Maker trust tier. Scores public mainnet history of the maker's wallet and caps how much of the
// raise the maker can take upfront at graduation. Devnet wallets have no history, so the signals
// are always read from mainnet (read-only).
import { Connection, PublicKey } from '@solana/web3.js'
import { parseNetwork } from './network'

export type TrustTierName = 'A' | 'B' | 'C'

export type TrustSignals = {
  walletAgeDays: number // a lower bound when truncated
  txCount: number // signatures seen, capped by the history walk
  fundedByFreshWallet: boolean // first funder was itself created within 7 days of funding
  truncated: boolean // history is longer than the walk: the true first transaction (and funder) is unknown
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

  if (signals.txCount >= 500) {
    score += 25
    reasons.push(`${signals.txCount}+ transactions (+25)`)
  } else if (signals.txCount >= 50) {
    score += 15
    reasons.push(`${signals.txCount} transactions (+15)`)
  } else {
    reasons.push(`Only ${signals.txCount} transactions (+0)`)
  }

  if (signals.fundedByFreshWallet) {
    score -= 20
    reasons.push('First funded by a wallet that was itself brand new (−20)')
  }

  if (signals.truncated) reasons.push('History is too long to walk to the first transaction, so the first funder is not checked')

  // Only on-chain signals count: A needs both a year of history and 500+ transactions.
  score = Math.max(0, Math.min(100, score))
  const tier: TrustTierName = score >= TIER_A_MIN_SCORE ? 'A' : score >= TIER_B_MIN_SCORE ? 'B' : 'C'
  return { tier, score, maxMakerSharePct: MAX_MAKER_SHARE[tier], reasons, signals }
}

// How far back a lookup walks: up to HISTORY_PAGES pages of signatures, within one time budget shared by
// the wallet and its funder. Past either limit the result is marked truncated rather than guessed.
const PAGE_SIZE = 1000
export const HISTORY_PAGES = 10
export const HISTORY_BUDGET_MS = 8_000

type HistoryLimits = { maxPages: number; deadline: number }

async function walkHistory(connection: Pick<Connection, 'getSignaturesForAddress'>, address: PublicKey, limits: HistoryLimits) {
  let before: string | undefined
  let count = 0
  let oldest: { signature: string; blockTime?: number | null } | undefined
  for (let page = 0; ; page++) {
    if (page >= limits.maxPages || Date.now() > limits.deadline) return { count, oldest, truncated: true }
    const sigs = await connection.getSignaturesForAddress(address, { before, limit: PAGE_SIZE })
    if (sigs.length === 0) break
    count += sigs.length
    oldest = sigs[sigs.length - 1]
    before = oldest.signature
    if (sigs.length < PAGE_SIZE) break
  }
  return { count, oldest, truncated: false }
}

// The first transaction of a wallet is usually the SOL transfer that funded it.
async function firstFunder(connection: Pick<Connection, 'getParsedTransaction'>, signature: string, wallet: PublicKey) {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 })
  for (const ix of tx?.transaction.message.instructions ?? []) {
    if ('parsed' in ix && ix.program === 'system' && ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info
      if (info.destination === wallet.toBase58()) return new PublicKey(info.source)
    }
  }
  return null
}

// Throws when the RPC fails: callers must not mistake a failed lookup for a new wallet.
export async function readTrustSignals(
  mainnet: Pick<Connection, 'getSignaturesForAddress' | 'getParsedTransaction'>,
  wallet: PublicKey,
  opts: { maxPages?: number; budgetMs?: number } = {},
): Promise<TrustSignals> {
  const now = Date.now() / 1000
  const limits = { maxPages: opts.maxPages ?? HISTORY_PAGES, deadline: Date.now() + (opts.budgetMs ?? HISTORY_BUDGET_MS) }
  const { count, oldest, truncated } = await walkHistory(mainnet, wallet, limits)
  const walletAgeDays = oldest?.blockTime ? (now - oldest.blockTime) / 86400 : 0

  // Only a complete walk reaches the funding transaction; a truncated one stops somewhere in between.
  let fundedByFreshWallet = false
  if (!truncated && oldest?.blockTime) {
    const funder = await firstFunder(mainnet, oldest.signature, wallet)
    if (funder) {
      const funderHistory = await walkHistory(mainnet, funder, limits)
      const funderBorn = funderHistory.oldest?.blockTime
      fundedByFreshWallet = !funderHistory.truncated && !!funderBorn && oldest.blockTime - funderBorn < 7 * 86400
    }
  }

  return { walletAgeDays, txCount: count, fundedByFreshWallet, truncated }
}

export async function trustTier(mainnet: Connection, wallet: PublicKey) {
  return scoreSignals(await readTrustSignals(mainnet, wallet))
}

// Localnet only: TRUST_FIXTURES='{"<wallet>": {"walletAgeDays": 800, "txCount": 900}}' stands in for
// mainnet history so tests can reach tiers A and B. Ignored on every other network.
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
  return {
    walletAgeDays: f.walletAgeDays ?? 0,
    txCount: f.txCount ?? 0,
    fundedByFreshWallet: f.fundedByFreshWallet ?? false,
    truncated: f.truncated ?? false,
  }
}
