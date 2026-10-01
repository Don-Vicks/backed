import { getCampaign, HttpError, prepareRedemption, schemas } from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, logLine, rateLimit, readJson, requestLog, serialize } from "@/lib/server";

// Step 1 of a redemption: the backer's shipping details are stored (sealed) as a pending redemption, and
// the answer is the burn transaction whose memo names it. Only that burn can claim these details.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/prepare");
  try {
    rateLimit(req, "tx");
    const { pool, wallet, shipping } = await readJson(req, schemas.redeemPrepare);
    log.wallet = wallet.toBase58();
    const record = getCampaign(pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    if (shipping.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shipping.email)) throw new BadRequest("Enter a valid email");
    // 409 before graduation or for the pool's creator, 400 without a whole voucher; RPC errors are 500s.
    const { pending, tx } = await prepareRedemption(connection(), record, wallet, shipping);
    logLine("info", { reqId: log.reqId, route: log.route, wallet: log.wallet, pool: record.pool, id: pending.id, event: "redemption prepared" });
    return Response.json({ id: pending.id, ...serialize(await finalizeForWallet(tx, wallet)) });
  } catch (e) {
    return errorResponse(e, log);
  }
}
