import { getCampaign, quoteResale, slippageBps, type ResaleSide } from "@preorder/core";
import { BadRequest, connection, errorResponse } from "@/lib/server";

// Same slippage setting as /api/tx resaleBuy/resaleSell, so minOut matches the signed transaction.
export async function POST(req: Request) {
  try {
    const { pool, side, amount, slippageBps: bps } = (await req.json()) as { pool: string; side: ResaleSide; amount: number; slippageBps?: number };
    const record = getCampaign(pool);
    if (!record) throw new BadRequest("Unknown campaign");
    if (side !== "buy" && side !== "sell") throw new BadRequest("side must be buy or sell");
    if (!(amount > 0)) throw new BadRequest("Enter an amount");
    return Response.json(await quoteResale(connection(), record, side, amount, slippageBps(bps)));
  } catch (e) {
    return errorResponse(e);
  }
}
