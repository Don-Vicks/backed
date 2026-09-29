import { PublicKey } from "@solana/web3.js";
import { buildMigrateTx, dbcClient, getCampaign, loadKeypair, send } from "@preorder/core";
import { BadRequest, connection, errorResponse } from "@/lib/server";

// Anyone can trigger graduation once the goal is reached; the platform pays for it.
export async function POST(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]/migrate">) {
  try {
    const { pool } = await ctx.params;
    if (!getCampaign(pool)) throw new BadRequest("Unknown campaign");
    const conn = connection();
    const client = dbcClient(conn);
    const state = await client.state.getPool(pool);
    if (!state) throw new BadRequest("Pool not found");
    if (Number(state.poolState.isMigrated) === 1) return Response.json({ ok: true, already: true });
    if ((await client.state.getPoolQuoteTokenCurveProgress(pool)) < 1) throw new BadRequest("Goal not reached yet");
    const platform = loadKeypair("platform");
    const { tx, extraSigners } = await buildMigrateTx(conn, platform.publicKey, new PublicKey(pool));
    const signature = await send(conn, tx, [platform, ...extraSigners], `migrate ${pool}`);
    return Response.json({ ok: true, signature });
  } catch (e) {
    return errorResponse(e);
  }
}
