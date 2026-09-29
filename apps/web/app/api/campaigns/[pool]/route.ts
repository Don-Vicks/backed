import { getCampaign, readCampaignLive } from "@preorder/core";
import { connection, errorResponse } from "@/lib/server";

export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]">) {
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const live = await readCampaignLive(connection(), record);
    return Response.json({ campaign: { ...record, live } });
  } catch (e) {
    return errorResponse(e);
  }
}
