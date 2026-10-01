import { campaignListing, getCampaign, poolListingAddress, readCampaignLive, readLpTerms, readPoolListingCached, readResaleConfig } from "@preorder/core";
import { connection, errorResponse, publicOrigin } from "@/lib/server";

export async function GET(req: Request, ctx: RouteContext<"/api/campaigns/[pool]">) {
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const conn = connection();
    // Terms come from the immutable config on chain (cached), so older campaigns show their own split.
    // The on-chain listing (DBC pool metadata), when the maker published one; undefined when unreadable.
    // The pool creator can write any listing through the SDK, so it is `official` only when its
    // website is this campaign's page, as our listing route builds it.
    const [live, terms, resaleFee, listing] = await Promise.all([
      readCampaignLive(conn, record),
      readLpTerms(conn, record.config).catch(() => null),
      readResaleConfig(conn, record.config).catch(() => null),
      readPoolListingCached(conn, record.pool)
        .then((l) => l && { ...l, address: poolListingAddress(record.pool).toBase58(), official: l.website === campaignListing(record, publicOrigin(req)).website })
        .catch(() => undefined),
    ]);
    return Response.json({ campaign: { ...record, live, terms, resaleFee, listing } });
  } catch (e) {
    return errorResponse(e);
  }
}
