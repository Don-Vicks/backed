import { getCampaign, readResaleCached } from "@preorder/core";
import { connection, errorResponse, requestLog } from "@/lib/server";

// Resale pool state with the backer floor (after graduation) and the maker's earnings (curve fees exist
// before graduation too). Cached per pool for a few seconds, so every viewer polling the panels costs one read.
export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]/resale">) {
  const log = requestLog("GET /api/campaigns/[pool]/resale");
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    return Response.json(await readResaleCached(connection(), record));
  } catch (e) {
    return errorResponse(e, log);
  }
}
