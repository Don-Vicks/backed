import { getCampaign, HttpError, schemas, startMakerSession } from "@preorder/core";
import { errorResponse, logLine, rateLimit, readJson, requestLog, signInDomain } from "@/lib/server";

// Step 2: the maker's signed message (with the nonce from /nonce) for a session token. The nonce is spent
// by a valid signature, so the same signed message cannot be traded for a second session.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/signin");
  try {
    rateLimit(req, "signin");
    const body = await readJson(req, schemas.ordersSignIn);
    const record = getCampaign(body.pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    log.wallet = record.maker;
    const session = startMakerSession({ pool: record.pool, maker: record.maker, domain: signInDomain(req, body.message), message: body.message, signature: body.signature });
    logLine("info", { reqId: log.reqId, route: log.route, wallet: log.wallet, pool: record.pool, event: "maker signed in" });
    return Response.json(session);
  } catch (e) {
    return errorResponse(e, log);
  }
}
