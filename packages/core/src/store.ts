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
