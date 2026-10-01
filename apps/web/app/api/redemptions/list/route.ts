import { listRedemptions, schemas } from "@preorder/core";
import { errorResponse, readJson, requestLog, requireMakerSignIn } from "@/lib/server";

// Maker-only: the maker's wallet signs a short-lived message for this site to see shipping details.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/list");
  try {
    const body = await readJson(req, schemas.ordersSignIn);
    const record = requireMakerSignIn(req, body);
    log.wallet = record.maker;
    return Response.json({ redemptions: listRedemptions(record.pool) });
  } catch (e) {
    return errorResponse(e, log);
  }
}
