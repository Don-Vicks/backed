import { dbcClient, saveCampaign, schemas, takePending } from "@preorder/core";
import { BadRequest, connection, errorResponse, logLine, rateLimit, readJson, requestLog } from "@/lib/server";

// Called after the maker's wallet sent the create transaction: verifies the pool exists, then lists it.
export async function POST(req: Request) {
  const log = requestLog("POST /api/campaigns/confirm");
  try {
    rateLimit(req, "tx");
    const { pool: poolKey, signature } = await readJson(req, schemas.confirmCampaign);
    const pool = poolKey.toBase58();
    log.sig = signature;
    const conn = connection();
    const status = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (status.value?.err) throw new BadRequest("The create transaction failed on-chain");
    const onChain = await dbcClient(conn).state.getPool(pool);
    if (!onChain) throw new BadRequest("Pool not found on-chain yet; try again in a few seconds");
    const record = takePending(pool);
    if (!record) throw new BadRequest("Unknown campaign");
    saveCampaign({ ...record, createSignature: signature });
    logLine("info", { reqId: log.reqId, route: log.route, wallet: record.maker, sig: signature, pool, event: "campaign listed" });
    return Response.json({ ok: true, pool });
  } catch (e) {
    return errorResponse(e, log);
  }
}
