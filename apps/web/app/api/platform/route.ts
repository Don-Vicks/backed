import { PublicKey } from "@solana/web3.js";
import { listCampaigns, platformFeeClaimer, platformTreasury, readPartnerListing, readPlatformEarnings } from "@preorder/core";
import { connection, errorResponse } from "@/lib/server";

// What the platform (DBC partner) has earned across every campaign, read from chain. Read-only: the
// claims run from the ops script, signed by the fee claimer. One read serves every viewer for 30 s.
let cached: { at: number; body: unknown } | null = null;

export async function GET() {
  try {
    if (cached && Date.now() - cached.at < 30_000) return Response.json(cached.body);
    const conn = connection();
    // The claimer new campaigns get. Older campaigns keep the one in their own config (per campaign below).
    let feeClaimer: PublicKey | null = null;
    try {
      feeClaimer = platformFeeClaimer();
    } catch {
      // no claimer configured on this server: the earnings still read, per campaign config
    }
    const [earnings, listing] = await Promise.all([
      readPlatformEarnings(conn, listCampaigns()),
      feeClaimer ? readPartnerListing(conn, feeClaimer).catch(() => null) : null,
    ]);
    const body = { ...earnings, feeClaimer: feeClaimer?.toBase58() ?? null, treasury: platformTreasury()?.toBase58() ?? null, listing };
    cached = { at: Date.now(), body };
    return Response.json(body);
  } catch (e) {
    return errorResponse(e);
  }
}
