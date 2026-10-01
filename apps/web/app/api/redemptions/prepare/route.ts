import { getCampaign, HttpError, prepareRedemption, schemas } from "@preorder/core";
import { connection, errorResponse, finalizeForWallet, rateLimit, readJson, requestLog, serialize } from "@/lib/server";

// Step 1 of a redemption: the burn transaction for the wallet to sign, whose memo names a new redemption
// id. Nothing is stored, so it needs no proof of the wallet: the shipping details are checked here (so
// the form shows a mistake before the wallet asks) and kept only when the signed burn comes back (submit).
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/prepare");
  try {
    rateLimit(req, "tx");
    const { pool, wallet } = await readJson(req, schemas.redeemPrepare);
    log.wallet = wallet.toBase58();
    const record = getCampaign(pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    // 409 before graduation or for the pool's creator, 400 without a whole voucher; RPC errors are 500s.
    const { id, tx } = await prepareRedemption(connection(), record, wallet);
    return Response.json({ id, ...serialize(await finalizeForWallet(tx, wallet)) });
  } catch (e) {
    return errorResponse(e, log);
  }
}
