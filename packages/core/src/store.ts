// Minimal campaign store: one JSON file per network until the web app's database exists.
import fs from 'fs'
import path from 'path'
import { getNetwork } from './network'
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

const storePath = () => path.resolve(__dirname, '../../../data', `campaigns.${getNetwork().name}.json`)

export function listCampaigns(): CampaignRecord[] {
  return fs.existsSync(storePath()) ? JSON.parse(fs.readFileSync(storePath(), 'utf8')) : []
}

export function saveCampaign(record: CampaignRecord) {
  const all = listCampaigns().filter((c) => c.pool !== record.pool)
  fs.mkdirSync(path.dirname(storePath()), { recursive: true })
  fs.writeFileSync(storePath(), JSON.stringify([record, ...all], null, 2))
}
