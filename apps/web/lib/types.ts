// Shapes shared by the API routes and the client (no server imports here).
import type { Campaign, CampaignLive, CampaignRecord, ConfigField, Listing, LpTerms, PlatformEarnings, PricingSummary, ResaleConfig, TrustResult, VestingSchedule } from "@preorder/core";

// terms, resaleFee: the resale-liquidity split and the resale pool fee, read from the on-chain config (campaign page only).
// listing: the DBC pool metadata the maker published (null: none yet, undefined: not read); official
// when it points at this campaign's page.
export type CampaignWithLive = CampaignRecord & { live: CampaignLive | null; terms?: LpTerms | null; resaleFee?: ResaleConfig | null; listing?: (Listing & { address: string; official: boolean }) | null };
// /api/platform: the partner's earnings across campaigns, the claimer new campaigns get, and its listing.
export type PlatformResponse = PlatformEarnings & { feeClaimer: string | null; treasury: string | null; listing: Listing | null };
export type PreviewResponse = {
  trust: TrustResult | null;
  pricing: PricingSummary | null;
  onChain: { goalUsdc: number; preorderUnits: number; resaleUnits: number; totalUnits: number } | null;
  vesting: VestingSchedule | null;
  fields: ConfigField[];
  error: string | null;
};
export type { Campaign, CampaignLive, CampaignRecord, ConfigField, Listing, LpTerms, PlatformEarnings, PricingSummary, ResaleConfig, TrustResult, VestingSchedule };
