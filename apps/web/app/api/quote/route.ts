import { quoteBuy } from "@preorder/core";
import { BadRequest, connection, errorResponse } from "@/lib/server";

export async function POST(req: Request) {
  try {
    const { pool, usdc } = (await req.json()) as { pool: string; usdc: number };
    if (!(usdc > 0)) throw new BadRequest("Enter an amount");
    return Response.json(await quoteBuy(connection(), pool, usdc));
  } catch (e) {
    return errorResponse(e);
  }
}
