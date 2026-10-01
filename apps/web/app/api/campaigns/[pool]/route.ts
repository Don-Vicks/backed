import { getCampaign } from "@preorder/core";
import { errorResponse, liveOrUnavailable, rateLimit, requestLog } from "@/lib/server";

// ?fresh=1 skips the cache (rate-limited): the page asks for it right after a graduation, to show it.
export async function GET(req: Request, ctx: RouteContext<"/api/campaigns/[pool]">) {
  const log = requestLog("GET /api/campaigns/[pool]");
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    if (fresh) rateLimit(req, "fresh");
    // Cached per pool for a few seconds, so every viewer polling this page costs one read.
    const live = await liveOrUnavailable(record, log, { fresh });
    return Response.json({ campaign: { ...record, live } });
  } catch (e) {
    return errorResponse(e, log);
  }
}
