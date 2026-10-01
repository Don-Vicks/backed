import { campaignFromInput, campaignToConfig, HttpError, MAX_MAKER_SHARE, schemas, type TrustResult } from "@preorder/core";
import { errorResponse, logLine, rateLimit, readJson, requestLog, trustFor } from "@/lib/server";
import type { PreviewResponse } from "@/lib/types";

// Live preview for the create form: the maker's trust tier and what each input becomes on-chain.
// When the trust lookup fails the preview says so (trustUnavailable) and nothing is cached: the form
// must not show tier C as if it were the maker's tier.
export async function POST(req: Request) {
  const log = requestLog("POST /api/preview");
  try {
    rateLimit(req, "preview");
    const body = await readJson(req, schemas.preview);
    let trust: TrustResult | null = null;
    let trustUnavailable = false;
    if (body.maker) {
      log.wallet = body.maker.toBase58();
      try {
        trust = await trustFor(log.wallet, req);
      } catch (e) {
        if (e instanceof HttpError && e.status === 429) throw e; // too many lookups: not the lookup failing
        trustUnavailable = true;
        logLine("error", { reqId: log.reqId, route: log.route, wallet: log.wallet, err: `trust lookup: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    const tier = trust?.tier ?? "C";
    let out: PreviewResponse;
    try {
      // The same allowlist as the create route, so the form shows the error a launch would get.
      const { pricing, onChain, fields } = campaignToConfig(campaignFromInput(body.campaign, ""), tier);
      out = { trust, trustUnavailable, pricing, onChain, fields, error: null };
    } catch (e) {
      out = { trust, trustUnavailable, pricing: null, onChain: null, fields: [], error: e instanceof Error ? e.message : String(e) };
    }
    return Response.json({ ...out, caps: MAX_MAKER_SHARE });
  } catch (e) {
    return errorResponse(e, log);
  }
}
