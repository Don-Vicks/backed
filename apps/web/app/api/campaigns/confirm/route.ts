import { ListingError, confirmListing, schemas } from "@preorder/core";
import { connection, errorResponse, logLine, rateLimit, readJson, requestLog } from "@/lib/server";

// Called after the maker's wallet sent the create transaction(s). Idempotent: a listed campaign returns ok.
// Waits up to ~15s for the pool on the server's RPC, checks the transaction that created it (the client's
// signature, else the pool's first transaction), then lists it. 409 + retry means "try again shortly".
// A split create's pool is made by its second transaction (createPool), which is the one to send.
export async function POST(req: Request) {
  const log = requestLog("POST /api/campaigns/confirm");
  try {
    rateLimit(req, "tx");
    const { pool: poolKey, signature } = await readJson(req, schemas.confirmCampaign);
    const pool = poolKey.toBase58();
    log.sig = signature;
    const { record, alreadyListed } = await confirmListing(connection(), pool, signature);
    if (!alreadyListed) {
      logLine("info", { reqId: log.reqId, route: log.route, wallet: record.maker, sig: record.createSignature, pool, event: "campaign listed" });
    }
    return Response.json({ ok: true, pool, alreadyListed });
  } catch (e) {
    if (e instanceof ListingError) return Response.json({ error: e.message, retry: e.retry }, { status: e.status });
    return errorResponse(e, log);
  }
}
