import { getCampaign, HttpError, listRedemptions, schemas, verifyWalletMessage } from "@preorder/core";
import { BadRequest, errorResponse, publicKey, readJson, requestLog } from "@/lib/server";

// Maker-only: the maker's wallet signs a time-stamped message to see shipping details.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/list");
  try {
    const { pool: poolKey, message, signature } = await readJson(req, schemas.ordersSignIn);
    const pool = poolKey.toBase58();
    const record = getCampaign(pool);
    if (!record) throw new HttpError("Campaign not found", 404);
    if (!message.includes(pool)) throw new BadRequest("Message is for a different campaign");
    try {
      verifyWalletMessage(message, signature, publicKey(record.maker));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "Not authorized" }, { status: 403 });
    }
    return Response.json({ redemptions: listRedemptions(pool) });
  } catch (e) {
    return errorResponse(e, log);
  }
}
