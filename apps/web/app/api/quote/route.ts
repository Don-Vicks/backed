import { quoteBuy, quoteSell, slippageBps } from "@preorder/core";
import { BadRequest, connection, errorResponse } from "@/lib/server";

type Body = { pool: string; side?: "buy" | "sell"; usdc?: number; vouchers?: number; slippageBps?: number };

// Curve quotes in the same swap mode the transactions use: buy = PartialFill (capped at the goal), sell = ExactIn.
export async function POST(req: Request) {
  try {
    const { pool, side = "buy", usdc, vouchers, slippageBps: bps } = (await req.json()) as Body;
    if (side === "sell") {
      if (!(Number(vouchers) > 0)) throw new BadRequest("Enter an amount");
      return Response.json(await quoteSell(connection(), String(pool), Number(vouchers), slippageBps(bps)));
    }
    if (side !== "buy") throw new BadRequest("side must be buy or sell");
    if (!(Number(usdc) > 0)) throw new BadRequest("Enter an amount");
    return Response.json(await quoteBuy(connection(), String(pool), Number(usdc), slippageBps(bps)));
  } catch (e) {
    return errorResponse(e);
  }
}
