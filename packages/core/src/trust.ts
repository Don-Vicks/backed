// Maker trust tier. Scores public mainnet history of the maker's wallet and caps how much of the
// raise the maker can take upfront at graduation. Devnet wallets have no history, so the signals
// are always read from mainnet (read-only).
import { Connection, PublicKey } from '@solana/web3.js'
import { parseNetwork } from './network'

export type TrustTierName = 'A' | 'B' | 'C'

export type TrustSignals = {
  walletAgeDays: number
  txCount: number // capped at the number of signatures fetched
  fundedByFreshWallet: boolean // first funder was itself created within 7 days of funding
  verifiedSocial: boolean
}

export type TrustResult = {
  tier: TrustTierName
  score: number
  maxMakerSharePct: number
  reasons: string[]
  signals: TrustSignals
}

export const MAX_MAKER_SHARE: Record<TrustTierName, number> = { A: 40, B: 25, C: 10 }

export function scoreSignals(signals: TrustSignals): TrustResult {
  const reasons: string[] = []
  let score = 0

  if (signals.walletAgeDays >= 365) {
    score += 40
    reasons.push(`Wallet is ${Math.floor(signals.walletAgeDays)} days old (+40)`)
  } else if (signals.walletAgeDays >= 90) {
    score += 25
    reasons.push(`Wallet is ${Math.floor(signals.walletAgeDays)} days old (+25)`)
  } else if (signals.walletAgeDays >= 14) {
    score += 10
    reasons.push(`Wallet is ${Math.floor(signals.walletAgeDays)} days old (+10)`)
  } else {
    reasons.push(`Wallet is new: ${Math.floor(signals.walletAgeDays)} days (+0)`)
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

  if (signals.verifiedSocial) {
    score += 25
    reasons.push('Verified social account (+25)')
  }

  score = Math.max(0, Math.min(100, score))
  const tier: TrustTierName = score >= 70 ? 'A' : score >= 40 ? 'B' : 'C'
  return { tier, score, maxMakerSharePct: MAX_MAKER_SHARE[tier], reasons, signals }
}

const MAX_SIGNATURES = 1000

async function oldestSignature(connection: Connection, address: PublicKey) {
  let before: string | undefined
  let count = 0
  let oldest: { signature: string; blockTime?: number | null } | undefined
  // Walk back at most MAX_SIGNATURES; older history only matters for the age score.
  while (count < MAX_SIGNATURES) {
    const page = await connection.getSignaturesForAddress(address, { before, limit: 1000 })
    if (page.length === 0) break
    count += page.length
    oldest = page[page.length - 1]
    before = oldest.signature
    if (page.length < 1000) break
  }
  return { count, oldest }
}

// The first transaction of a wallet is usually the SOL transfer that funded it.
async function firstFunder(connection: Connection, signature: string, wallet: PublicKey) {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 })
  for (const ix of tx?.transaction.message.instructions ?? []) {
    if ('parsed' in ix && ix.program === 'system' && ix.parsed?.type === 'transfer') {
      const info = ix.parsed.info
      if (info.destination === wallet.toBase58()) return new PublicKey(info.source)
    }
  }
  return null
}

export async function readTrustSignals(
  mainnet: Connection,
  wallet: PublicKey,
  opts: { verifiedSocial?: boolean } = {},
): Promise<TrustSignals> {
  const now = Date.now() / 1000
  const { count, oldest } = await oldestSignature(mainnet, wallet)
  const walletAgeDays = oldest?.blockTime ? (now - oldest.blockTime) / 86400 : 0

  let fundedByFreshWallet = false
  if (oldest?.blockTime) {
    const funder = await firstFunder(mainnet, oldest.signature, wallet)
    if (funder) {
      const funderHistory = await oldestSignature(mainnet, funder)
      const funderBorn = funderHistory.oldest?.blockTime
      fundedByFreshWallet = funderHistory.count < MAX_SIGNATURES && !!funderBorn && oldest.blockTime - funderBorn < 7 * 86400
    }
  }

  return { walletAgeDays, txCount: count, fundedByFreshWallet, verifiedSocial: !!opts.verifiedSocial }
}

export async function trustTier(mainnet: Connection, wallet: PublicKey, opts: { verifiedSocial?: boolean } = {}) {
  return scoreSignals(await readTrustSignals(mainnet, wallet, opts))
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
  return { walletAgeDays: 0, txCount: 0, fundedByFreshWallet: false, verifiedSocial: false, ...f }
}
