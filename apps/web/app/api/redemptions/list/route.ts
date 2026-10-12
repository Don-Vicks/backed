import { listRedemptions, schemas } from "@preorder/core";
import { errorResponse, readJson, requestLog, requireMakerSession } from "@/lib/server";

// Maker-only: the maker signs in (nonce, then signature) for a short session to see shipping details.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/list");
  try {
    const body = await readJson(req, schemas.ordersList);
    const record = requireMakerSession(req, body.pool);
    log.wallet = record.maker;
    return Response.json({ redemptions: listRedemptions(record.pool) });
  } catch (e) {
    return errorResponse(e, log);
  }
}
