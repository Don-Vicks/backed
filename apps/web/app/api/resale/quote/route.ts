import { getCampaign, HttpError, quoteResale, schemas } from "@preorder/core";
import { connection, errorResponse, rateLimit, readJson, requestLog, requireStatus } from "@/lib/server";

// Same slippage setting as /api/tx resaleBuy/resaleSell, so minOut matches the signed transaction.
// 404 for an unknown campaign, 409 until it has graduated and its resale pool exists.
export async function POST(req: Request) {
  const log = requestLog("POST /api/resale/quote");
  try {
    rateLimit(req, "quote");
    const { pool, side, amount, slippageBps } = await readJson(req, schemas.resaleQuote);
    const record = getCampaign(pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    await requireStatus(record, log, "reselling", "The resale market opens after graduation");
    return Response.json(await quoteResale(connection(), record, side, amount, slippageBps));
  } catch (e) {
    return errorResponse(e, log);
  }
}
