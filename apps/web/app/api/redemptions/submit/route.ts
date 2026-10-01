import { getCampaign, HttpError, schemas, submitRedemption } from "@preorder/core";
import { connection, errorResponse, logLine, rateLimit, readJson, requestLog } from "@/lib/server";

// Step 2: the burn from prepare, signed by the wallet, with the shipping details. The server keeps them
// (sealed) as a pending redemption, sends the burn, waits for it and records the order, all in this
// request. 4xx: nothing was burned. 503: the burn was sent but not confirmed; the page finishes it later
// through /pending and /confirm. Sending the same signed burn again is harmless.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/submit");
  try {
    rateLimit(req, "tx");
    const { pool, id, tx, shipping } = await readJson(req, schemas.redeemSubmit);
    const record = getCampaign(pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    const { redemption, already } = await submitRedemption(connection(), record, Buffer.from(tx, "base64"), id, shipping);
    log.wallet = redemption.wallet;
    log.sig = redemption.signature;
    if (!already) logLine("info", { reqId: log.reqId, route: log.route, wallet: log.wallet, sig: log.sig, pool: record.pool, id, units: redemption.units, event: "redemption" });
    return Response.json({ ok: true, signature: redemption.signature, units: redemption.units, already });
  } catch (e) {
    return errorResponse(e, log);
  }
}
