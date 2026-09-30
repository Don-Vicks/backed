import { getCampaign, readMakerEarnings, readResale } from "@preorder/core";
import { connection, errorResponse } from "@/lib/server";

// Resale pool state (after graduation) and the maker's earnings (curve fees exist before graduation too).
export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]/resale">) {
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const conn = connection();
    const resale = await readResale(conn, record);
    const maker = resale?.maker ?? (await readMakerEarnings(conn, record));
    return Response.json({ resale, maker });
  } catch (e) {
    return errorResponse(e);
  }
}
