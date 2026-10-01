import { timingSafeEqual } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { buildMigrateTx, dbcClient, getCampaign, loadKeypair, send } from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, publicKey, serialize } from "@/lib/server";

// True only for `Authorization: Bearer <ADMIN_TOKEN>` when ADMIN_TOKEN is set.
function isAdmin(req: Request) {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) return false;
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

// Anyone can trigger graduation once the goal is reached, and the caller's wallet pays: this returns a
// migrate transaction with that wallet as fee payer and the two position-NFT keys already signed.
// The platform-paid path (signed and sent here) is only for an operator holding ADMIN_TOKEN.
// When Meteora's keeper graduated the pool first, the answer is { already: true }.
export async function POST(req: Request, ctx: RouteContext<"/api/campaigns/[pool]/migrate">) {
  try {
    const { pool } = await ctx.params;
    if (!getCampaign(pool)) throw new BadRequest("Unknown campaign");
    const admin = isAdmin(req);
    const body = (await req.json().catch(() => ({}))) as { wallet?: string };
    const payer = admin ? null : publicKey(body.wallet);
    const conn = connection();
    const client = dbcClient(conn);
    const state = await client.state.getPool(pool);
    if (!state) throw new BadRequest("Pool not found");
    if (Number(state.poolState.isMigrated) === 1) return Response.json({ ok: true, already: true });
    if ((await client.state.getPoolQuoteTokenCurveProgress(pool)) < 1) throw new BadRequest("Goal not reached yet");
    if (!payer) {
      const platform = loadKeypair("platform");
      const { tx, extraSigners } = await buildMigrateTx(conn, platform.publicKey, new PublicKey(pool));
      const signature = await send(conn, tx, [platform, ...extraSigners], `migrate ${pool}`);
      return Response.json({ ok: true, signature });
    }
    const { tx, extraSigners } = await buildMigrateTx(conn, payer, new PublicKey(pool));
    await finalizeForWallet(tx, payer);
    tx.partialSign(...extraSigners);
    return Response.json(serialize(tx));
  } catch (e) {
    return errorResponse(e);
  }
}
