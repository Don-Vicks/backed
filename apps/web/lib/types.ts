// Shapes shared by the API routes and the client (no server imports here).
import type { Campaign, CampaignLive, CampaignRecord, ConfigField, LpTerms, PricingSummary, ResaleConfig, TrustResult, VestingSchedule } from "@preorder/core";

// terms, resaleFee: the resale-liquidity split and the resale pool fee, read from the on-chain config (campaign page only).
export type CampaignWithLive = CampaignRecord & { live: CampaignLive | null; terms?: LpTerms | null; resaleFee?: ResaleConfig | null };
export type PreviewResponse = {
  trust: TrustResult | null;
  pricing: PricingSummary | null;
  onChain: { goalUsdc: number; preorderUnits: number; resaleUnits: number; totalUnits: number } | null;
  vesting: VestingSchedule | null;
  fields: ConfigField[];
  error: string | null;
};
export type { Campaign, CampaignLive, CampaignRecord, ConfigField, LpTerms, PricingSummary, ResaleConfig, TrustResult, VestingSchedule };
