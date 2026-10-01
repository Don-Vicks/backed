import { HttpError, markRedemptionShipped, schemas } from "@preorder/core";
import { errorResponse, logLine, readJson, requestLog, requireMakerSignIn } from "@/lib/server";

// Maker-only: mark an order shipped. Its shipping details are deleted; the order itself stays.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/shipped");
  try {
    const body = await readJson(req, schemas.ordersShipped);
    const record = requireMakerSignIn(req, body);
    log.wallet = record.maker;
    log.sig = body.order;
    if (!markRedemptionShipped(record.pool, body.order)) throw new HttpError("Order not found", 404);
    logLine("info", { reqId: log.reqId, route: log.route, wallet: log.wallet, sig: body.order, pool: record.pool, event: "redemption shipped" });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e, log);
  }
}
