import { getCampaign, HttpError, saveRedemption, schemas, verifyBurn } from "@preorder/core";
import { BadRequest, connection, errorResponse, logLine, readJson, requestLog } from "@/lib/server";

// A backer submits shipping details for a burn they already made on-chain.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions");
  try {
    const body = await readJson(req, schemas.redemption);
    const wallet = body.wallet;
    log.wallet = wallet.toBase58();
    log.sig = body.signature;
    const record = getCampaign(body.pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    const shipping = body.shipping;
    if (shipping.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shipping.email)) throw new BadRequest("Enter a valid email");
    // verifyBurn and saveRedemption throw 4xx HttpErrors for a burn that doesn't count; RPC errors are 500s.
    const units = await verifyBurn(connection(), record, body.signature, wallet);
    saveRedemption({ pool: record.pool, signature: body.signature, wallet: log.wallet, units, shipping, createdAt: new Date().toISOString() });
    logLine("info", { reqId: log.reqId, route: log.route, wallet: log.wallet, sig: body.signature, pool: record.pool, units, event: "redemption" });
    return Response.json({ ok: true, units });
  } catch (e) {
    return errorResponse(e, log);
  }
}
