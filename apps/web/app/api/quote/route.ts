import { getCampaign, HttpError, quoteBuy, quoteSell, schemas } from "@preorder/core";
import { connection, errorResponse, liveOrUnavailable, rateLimit, readJson, requestLog } from "@/lib/server";

// Curve quotes in the same swap mode the transactions use: buy = PartialFill (capped at the goal), sell = ExactIn.
// Only for listed campaigns that are still funding: 404 for any other address, 409 once the goal is reached.
export async function POST(req: Request) {
  const log = requestLog("POST /api/quote");
  try {
    rateLimit(req, "quote");
    const { pool, side, usdc, vouchers, slippageBps } = await readJson(req, schemas.quote);
    const record = getCampaign(pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    if ((await liveOrUnavailable(record, log)).status !== "funding") throw new HttpError("This campaign has reached its goal", 409);
    if (side === "sell") {
      if (!vouchers) throw new HttpError("Enter an amount", 400);
      return Response.json(await quoteSell(connection(), record.pool, vouchers, slippageBps));
    }
    if (!usdc) throw new HttpError("Enter an amount", 400);
    return Response.json(await quoteBuy(connection(), record.pool, usdc, slippageBps));
  } catch (e) {
    return errorResponse(e, log);
  }
}
