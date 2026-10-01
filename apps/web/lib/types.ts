// Shapes shared by the API routes and the client (no server imports here).
import type { BuyQuote, Campaign, CampaignLive, CampaignRecord, ConfigField, PricingSummary, SellQuote, TrustResult } from "@preorder/core";

export type CampaignWithLive = CampaignRecord & { live: CampaignLive | null };
export type PreviewResponse = {
  trust: TrustResult | null;
  pricing: PricingSummary | null;
  onChain: { goalUsdc: number; preorderUnits: number; resaleUnits: number; totalUnits: number } | null;
  fields: ConfigField[];
  error: string | null;
};
export type { BuyQuote, Campaign, CampaignLive, CampaignRecord, ConfigField, PricingSummary, SellQuote, TrustResult };
