import { campaignToConfig, MAX_MAKER_SHARE, type Campaign, type TrustResult } from "@preorder/core";
import { errorResponse, publicKey, trustFor } from "@/lib/server";
import type { PreviewResponse } from "@/lib/types";

// Live preview for the create form: the maker's trust tier and what each input becomes on-chain.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { campaign: Campaign; maker?: string; verifiedSocial?: boolean };
    let trust: TrustResult | null = null;
    if (body.maker) trust = await trustFor(publicKey(body.maker, "maker").toBase58(), !!body.verifiedSocial);
    const tier = trust?.tier ?? "C";
    let out: PreviewResponse;
    try {
      const { pricing, onChain, vesting, fields } = campaignToConfig(body.campaign, tier);
      out = { trust, pricing, onChain, vesting, fields, error: null };
    } catch (e) {
      out = { trust, pricing: null, onChain: null, vesting: null, fields: [], error: e instanceof Error ? e.message : String(e) };
    }
    return Response.json({ ...out, caps: MAX_MAKER_SHARE });
  } catch (e) {
    return errorResponse(e);
  }
}
