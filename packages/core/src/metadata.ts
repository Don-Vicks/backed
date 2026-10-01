// On-chain listings: DBC's pool metadata (per campaign, signed by the maker as pool creator) and
// partner metadata (once per fee claimer). Each is a PDA holding a name, a website and a logo URL.
// They don't fit in the create transaction, so each is a second transaction of its own.
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { derivePartnerMetadata, deriveDbcPoolMetadata } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { BRAND } from './brand'
import { dbcClient } from './chain'
import type { CampaignRecord } from './store'

export type Listing = { name: string; website: string; logo: string }

// Every byte of the three strings is in the transaction and the account, so keep them short.
const MAX_NAME = 32
const MAX_URL = 200

// Pure: the listing a campaign gets. Its website is the campaign page; the logo is the maker's image
// when it is a short https URL, else the generated brand icon.
export function campaignListing(record: Pick<CampaignRecord, 'pool' | 'campaign'>, origin: string): Listing {
  const image = record.campaign.image?.trim() ?? ''
  const logo = image.startsWith('https://') && image.length <= MAX_URL ? image : `${origin}/blink-icon.svg`
  return { name: record.campaign.name.slice(0, MAX_NAME), website: `${origin}/c/${record.pool}`, logo }
}

export function partnerListing(origin: string): Listing {
  return { name: BRAND, website: origin, logo: `${origin}/blink-icon.svg` }
}

function checkListing(l: Listing) {
  if (l.name.length > MAX_NAME) throw new Error(`listing name is over ${MAX_NAME} characters`)
  for (const url of [l.website, l.logo]) if (url.length > MAX_URL) throw new Error(`listing URL is over ${MAX_URL} characters`)
}

const toListing = (a: { name: string; website: string; logo: string } | null): Listing | null =>
  a ? { name: a.name, website: a.website, logo: a.logo } : null

// One account read at the metadata PDA (getPoolMetadata would scan every metadata account).
export async function readPoolListing(connection: Connection, pool: PublicKey | string): Promise<Listing | null> {
  const program = dbcClient(connection).state.program
  return toListing(await program.account.virtualPoolMetadata.fetchNullable(poolListingAddress(pool)))
}

// The campaign's listing account, for an explorer link.
export const poolListingAddress = (pool: PublicKey | string) => deriveDbcPoolMetadata(new PublicKey(pool))

// For pages that poll: a listing never changes once created, and a missing one is re-checked after a minute.
const listingCache = new Map<string, { at: number; listing: Listing | null }>()

export async function readPoolListingCached(connection: Connection, pool: PublicKey | string): Promise<Listing | null> {
  const key = pool.toString()
  const hit = listingCache.get(key)
  if (hit && (hit.listing || Date.now() - hit.at < 60_000)) return hit.listing
  const listing = await readPoolListing(connection, key)
  listingCache.set(key, { at: Date.now(), listing })
  return listing
}

export async function readPartnerListing(connection: Connection, feeClaimer: PublicKey): Promise<Listing | null> {
  const program = dbcClient(connection).state.program
  return toListing(await program.account.partnerMetadata.fetchNullable(derivePartnerMetadata(feeClaimer)))
}

// The maker creates and pays for the campaign's listing; the program requires the pool creator's
// signature. Null when the campaign already has one (the account can't be created twice).
export async function buildPoolMetadataTx(connection: Connection, record: CampaignRecord, creator: PublicKey, origin: string): Promise<Transaction | null> {
  if (await readPoolListing(connection, record.pool)) return null
  const listing = campaignListing(record, origin)
  checkListing(listing)
  return dbcClient(connection).creator.createPoolMetadata({ virtualPool: new PublicKey(record.pool), ...listing, creator, payer: creator })
}

// Once per fee claimer, which signs and pays. Null when it already exists.
export async function buildPartnerMetadataTx(connection: Connection, feeClaimer: PublicKey, origin: string): Promise<Transaction | null> {
  if (await readPartnerListing(connection, feeClaimer)) return null
  const listing = partnerListing(origin)
  checkListing(listing)
  return dbcClient(connection).partner.createPartnerMetadata({ ...listing, feeClaimer, payer: feeClaimer })
}
