import { getCampaign } from "@preorder/core";
import { errorResponse, liveOrUnavailable, requestLog } from "@/lib/server";

export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]">) {
  const log = requestLog("GET /api/campaigns/[pool]");
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    // Cached per pool for a few seconds, so every viewer polling this page costs one read.
    const live = await liveOrUnavailable(record, log);
    return Response.json({ campaign: { ...record, live } });
  } catch (e) {
    return errorResponse(e, log);
  }
}
