import { confirmRedemption, schemas } from "@preorder/core";
import { connection, errorResponse, logLine, rateLimit, readJson, requestLog } from "@/lib/server";

// Step 2: the burn landed. The order is recorded once the burn checks out on-chain (memo, wallet, mint,
// whole units). Repeating it for the same burn is harmless, so the page can retry and recover.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/confirm");
  try {
    rateLimit(req, "tx");
    const { id, signature } = await readJson(req, schemas.redeemConfirm);
    log.sig = signature;
    // 4xx HttpErrors for a burn that doesn't count (409 while it is not visible yet); RPC errors are 500s.
    const { redemption, already } = await confirmRedemption(connection(), id, signature);
    log.wallet = redemption.wallet;
    if (!already) logLine("info", { reqId: log.reqId, route: log.route, wallet: log.wallet, sig: signature, pool: redemption.pool, id, units: redemption.units, event: "redemption" });
    return Response.json({ ok: true, units: redemption.units, already });
  } catch (e) {
    return errorResponse(e, log);
  }
}
