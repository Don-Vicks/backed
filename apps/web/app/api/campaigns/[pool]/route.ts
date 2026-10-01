import { getCampaign, readCampaignLive, readLpTerms } from "@preorder/core";
import { connection, errorResponse } from "@/lib/server";

export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]">) {
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const conn = connection();
    // Terms come from the immutable config on chain (cached), so older campaigns show their own split.
    const [live, terms] = await Promise.all([readCampaignLive(conn, record), readLpTerms(conn, record.config).catch(() => null)]);
    return Response.json({ campaign: { ...record, live, terms } });
  } catch (e) {
    return errorResponse(e);
  }
}
