import { confirmRedemption, schemas } from "@preorder/core";
import { connection, errorResponse, logLine, rateLimit, readJson, requestLog } from "@/lib/server";

// Recovery: a burn submit sent whose order it could not record (a lost confirmation). The order is
// recorded once that burn checks out on-chain (memo, wallet, mint, whole units). Repeating it for the
// same burn is harmless, so the page can retry.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/confirm");
  try {
    rateLimit(req, "tx");
    const { id, signature } = await readJson(req, schemas.redeemConfirm);
    log.sig = signature;
    // 4xx HttpErrors for a burn that doesn't count (409 while it is not visible yet); RPC errors are 500s.
    // Only the burn sent for this redemption is checked: another signature is a 400 that changes nothing.
    const { redemption, already } = await confirmRedemption(connection(), id, signature);
    log.wallet = redemption.wallet;
    if (!already) logLine("info", { reqId: log.reqId, route: log.route, wallet: log.wallet, sig: signature, pool: redemption.pool, id, units: redemption.units, event: "redemption" });
    return Response.json({ ok: true, units: redemption.units, already });
  } catch (e) {
    return errorResponse(e, log);
  }
}
