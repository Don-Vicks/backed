import { PublicKey } from "@solana/web3.js";
import { listCampaigns, platformFeeClaimer, platformTreasury, readPartnerListing, readPlatformEarnings } from "@preorder/core";
import { connection, errorResponse } from "@/lib/server";

// What the platform (DBC partner) has earned across every campaign, read from chain. Read-only: the
// claims run from the ops script, signed by the fee claimer. One read serves every viewer for 30 s:
// requests that arrive while it runs share it, and a failed refresh serves the last good read.
let cached: { at: number; read: Promise<unknown> } | null = null;
let lastGood: unknown = null;

async function readPlatform() {
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
  return { ...earnings, feeClaimer: feeClaimer?.toBase58() ?? null, treasury: platformTreasury()?.toBase58() ?? null, listing };
}

export async function GET() {
  try {
    if (!cached || Date.now() - cached.at >= 30_000) {
      const read = readPlatform();
      const entry = { at: Date.now(), read };
      cached = entry;
      read.then(
        (body) => void (lastGood = body),
        () => void (cached === entry && (cached = null)),
      );
    }
    try {
      return Response.json(await cached.read);
    } catch (e) {
      if (lastGood) return Response.json(lastGood);
      throw e;
    }
  } catch (e) {
    return errorResponse(e);
  }
}
