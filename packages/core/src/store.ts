// Minimal campaign store: one JSON file per network until the web app's database exists.
import fs from 'fs'
import path from 'path'
import { getNetwork } from './network'
import { repoRoot } from './paths'
import type { Campaign, ConfigField } from './engine'
import type { TrustResult } from './trust'

export type CampaignRecord = {
  pool: string
  config: string
  baseMint: string
  usdcMint: string
  maker: string
  createdAt: string
  createSignature: string
  campaign: Campaign
  trust: Pick<TrustResult, 'tier' | 'score' | 'reasons' | 'maxMakerSharePct'>
  goalUsdc: number
  totalUnits: number
  fields: ConfigField[]
}

const storePath = () => path.join(repoRoot(), 'data', `campaigns.${getNetwork().name}.json`)

export function listCampaigns(): CampaignRecord[] {
  return fs.existsSync(storePath()) ? JSON.parse(fs.readFileSync(storePath(), 'utf8')) : []
}

export function saveCampaign(record: CampaignRecord) {
  const all = listCampaigns().filter((c) => c.pool !== record.pool)
  fs.mkdirSync(path.dirname(storePath()), { recursive: true })
  fs.writeFileSync(storePath(), JSON.stringify([record, ...all], null, 2))
}

// Campaigns built for a maker's wallet but not yet confirmed on-chain.
const pendingPath = () => path.join(repoRoot(), 'data', `pending.${getNetwork().name}.json`)

export function savePending(record: CampaignRecord) {
  const all = fs.existsSync(pendingPath()) ? (JSON.parse(fs.readFileSync(pendingPath(), 'utf8')) as CampaignRecord[]) : []
  fs.mkdirSync(path.dirname(pendingPath()), { recursive: true })
  fs.writeFileSync(pendingPath(), JSON.stringify([record, ...all.filter((c) => c.pool !== record.pool)].slice(0, 50), null, 2))
}

export function getPending(pool: string): CampaignRecord | undefined {
  if (!fs.existsSync(pendingPath())) return undefined
  return (JSON.parse(fs.readFileSync(pendingPath(), 'utf8')) as CampaignRecord[]).find((c) => c.pool === pool)
}

export function takePending(pool: string): CampaignRecord | undefined {
  if (!fs.existsSync(pendingPath())) return undefined
  const all = JSON.parse(fs.readFileSync(pendingPath(), 'utf8')) as CampaignRecord[]
  const found = all.find((c) => c.pool === pool)
  fs.writeFileSync(pendingPath(), JSON.stringify(all.filter((c) => c.pool !== pool), null, 2))
  return found
}

export function getCampaign(pool: string): CampaignRecord | undefined {
  return listCampaigns().find((c) => c.pool === pool)
}

// Token metadata JSON served by the web app at /m/<id> (Metaplex uri; older campaigns use /api/metadata/<id>).
export type TokenMetadata = { name: string; symbol: string; description: string; image: string }
const metadataPath = () => path.join(repoRoot(), 'data', `metadata.${getNetwork().name}.json`)

export function saveMetadata(id: string, meta: TokenMetadata) {
  const all = fs.existsSync(metadataPath()) ? JSON.parse(fs.readFileSync(metadataPath(), 'utf8')) : {}
  all[id] = meta
  fs.mkdirSync(path.dirname(metadataPath()), { recursive: true })
  fs.writeFileSync(metadataPath(), JSON.stringify(all, null, 2))
}

export function getMetadata(id: string): TokenMetadata | undefined {
  if (!fs.existsSync(metadataPath())) return undefined
  const all = JSON.parse(fs.readFileSync(metadataPath(), 'utf8'))
  // ids come from the URL; ignore inherited keys like __proto__
  return Object.hasOwn(all, id) ? all[id] : undefined
}

// Writes a temp file and renames it into place, so a crash or a full volume mid-write leaves the old
// file whole instead of a truncated one.
export function writeFileAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

// Rate limits: one token bucket per key (an IP on a route), refilled at refillPerSec up to capacity.
// Returns false when the bucket is empty. A bucket is dropped once it would be full again, so the file
// only holds clients seen in the last few minutes. The buckets are a guard, not a record: an unreadable
// or unwritable file fails open (every bucket full) rather than turning each limited request into a 500.
type RateBucket = { tokens: number; updatedAt: number; fullAt: number }
const ratePath = () => path.join(repoRoot(), 'data', `rate.${getNetwork().name}.json`)

function readRateBuckets(): Map<string, RateBucket> {
  try {
    // A Map, so a key like "__proto__" is just a key.
    return new Map(Object.entries(JSON.parse(fs.readFileSync(ratePath(), 'utf8')) as Record<string, RateBucket>))
  } catch {
    return new Map() // missing, or cut short by a crash before writes were atomic
  }
}

export function takeRateToken(key: string, capacity: number, refillPerSec: number, now = Date.now()): boolean {
  const all = readRateBuckets()
  const row = all.get(key)
  const available = row ? Math.min(capacity, row.tokens + (Math.max(0, now - row.updatedAt) / 1000) * refillPerSec) : capacity
  const ok = available >= 1
  const tokens = ok ? available - 1 : available
  all.set(key, { tokens, updatedAt: now, fullAt: now + ((capacity - tokens) / refillPerSec) * 1000 })
  for (const [k, b] of all) if (!(now < b.fullAt)) all.delete(k)
  try {
    writeFileAtomic(ratePath(), JSON.stringify(Object.fromEntries(all)))
  } catch (e) {
    console.error(`rate limits not saved: ${e instanceof Error ? e.message : String(e)}`)
  }
  return ok
}

// Faucet claims (devnet/localnet), kept for 30 days: longer than any faucet window.
type FaucetClaim = { wallet: string; ip: string | null; claimedAt: number }
const faucetPath = () => path.join(repoRoot(), 'data', `faucet-claims.${getNetwork().name}.json`)
export const FAUCET_RETENTION_MS = 30 * 24 * 60 * 60_000
const readFaucetClaims = (): FaucetClaim[] => (fs.existsSync(faucetPath()) ? JSON.parse(fs.readFileSync(faucetPath(), 'utf8')) : [])

export function recordFaucetClaim(wallet: string, ip: string | null, now = Date.now()) {
  const kept = readFaucetClaims().filter((c) => now - c.claimedAt <= FAUCET_RETENTION_MS)
  writeFileAtomic(faucetPath(), JSON.stringify([{ wallet, ip, claimedAt: now }, ...kept]))
}

// Takes back a claim recorded before a transfer that then provably did not happen.
export function removeFaucetClaim(wallet: string, claimedAt: number) {
  const all = readFaucetClaims()
  const i = all.findIndex((c) => c.wallet === wallet && c.claimedAt === claimedAt)
  if (i < 0) return
  all.splice(i, 1)
  writeFileAtomic(faucetPath(), JSON.stringify(all))
}

// Claims since a time, optionally for one wallet or one IP (both unset: all claims).
export function countFaucetClaims(sinceMs: number, by: { wallet?: string; ip?: string } = {}): number {
  return readFaucetClaims().filter((c) => c.claimedAt >= sinceMs && (!by.wallet || c.wallet === by.wallet) && (!by.ip || c.ip === by.ip)).length
}
