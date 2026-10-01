import { campaignListing, getCampaign, poolListingAddress, readLpTerms, readPoolListingCached, readResaleConfig } from "@preorder/core";
import { connection, errorResponse, liveOrUnavailable, publicOrigins, rateLimit, requestLog } from "@/lib/server";

// ?fresh=1 skips the cache (rate-limited): the page asks for it right after a graduation, to show it.
export async function GET(req: Request, ctx: RouteContext<"/api/campaigns/[pool]">) {
  const log = requestLog("GET /api/campaigns/[pool]");
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    if (fresh) rateLimit(req, "fresh");
    const conn = connection();
    // Live state is cached per pool for a few seconds, so every viewer polling this page costs one read.
    // Terms come from the immutable config on chain (cached), so older campaigns show their own split.
    // The on-chain listing (DBC pool metadata), when the maker published one; undefined when unreadable.
    // The pool creator can write any listing through the SDK, so it is `official` only when its
    // website is this campaign's page, as our listing route builds it (under this or a previous domain).
    const [live, terms, resaleFee, listing] = await Promise.all([
      liveOrUnavailable(record, log, { fresh }),
      readLpTerms(conn, record.config).catch(() => null),
      readResaleConfig(conn, record.config).catch(() => null),
      readPoolListingCached(conn, record.pool)
        .then((l) => l && { ...l, address: poolListingAddress(record.pool).toBase58(), official: publicOrigins(req).some((o) => l.website === campaignListing(record, o).website) })
        .catch(() => undefined),
    ]);
    return Response.json({ campaign: { ...record, live, terms, resaleFee, listing } });
  } catch (e) {
    return errorResponse(e, log);
  }
}
