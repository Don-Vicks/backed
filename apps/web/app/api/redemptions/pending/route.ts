import { findUnfinishedRedemptions, getCampaign, HttpError, parseWith, schemas } from "@preorder/core";
import { connection, errorResponse, rateLimit, requestLog } from "@/lib/server";

// ?pool&wallet: this wallet's redemptions whose burn landed but whose confirm never arrived, for the page
// to finish. No shipping details: ids and burn signatures only, which are public on-chain anyway.
export async function GET(req: Request) {
  const log = requestLog("GET /api/redemptions/pending");
  try {
    rateLimit(req, "tx");
    const { pool, wallet } = parseWith(schemas.redeemPending, Object.fromEntries(new URL(req.url).searchParams));
    log.wallet = wallet.toBase58();
    const record = getCampaign(pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    return Response.json({ pending: await findUnfinishedRedemptions(connection(), record, wallet) });
  } catch (e) {
    return errorResponse(e, log);
  }
}
