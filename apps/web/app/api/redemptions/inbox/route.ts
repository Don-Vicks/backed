import { registerInboxKey, schemas } from "@preorder/core";
import { errorResponse, logLine, readJson, requestLog, requireMakerSession } from "@/lib/server";

// Maker-only: registers the public half of the maker's inbox key, once, so backers can seal shipping
// details to it. The private half is derived in the maker's wallet and never reaches the server.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/inbox");
  try {
    const body = await readJson(req, schemas.ordersInbox);
    const record = requireMakerSession(req, body.pool);
    log.wallet = record.maker;
    registerInboxKey(record.pool, body.publicKey);
    logLine("info", { reqId: log.reqId, route: log.route, wallet: log.wallet, pool: record.pool, event: "inbox key registered" });
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e, log);
  }
}
