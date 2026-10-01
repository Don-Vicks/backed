import { getCampaign, readBackerFloor, readMakerEarnings, readResale } from "@preorder/core";
import { connection, errorResponse } from "@/lib/server";

// Resale pool state (after graduation), the backer floor and the maker's earnings (curve fees exist before graduation too).
export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]/resale">) {
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const conn = connection();
    const resale = await readResale(conn, record);
    const maker = resale?.maker ?? (await readMakerEarnings(conn, record));
    // Exit value of one voucher now, and at the permanent floor once all vesting is withdrawn.
    const floor = resale ? await readBackerFloor(conn, record, 1).catch(() => null) : null;
    return Response.json({ resale, maker, floor });
  } catch (e) {
    return errorResponse(e);
  }
}
