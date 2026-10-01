import { timingSafeEqual } from "crypto";
import { PublicKey } from "@solana/web3.js";
import { buildMigrateTx, dbcClient, getCampaign, loadKeypair, send, withPriorityFee } from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, publicKey, serialize } from "@/lib/server";

// Shorter tokens disable the admin path: the route has no rate limit, so the token must not be guessable.
const ADMIN_TOKEN_MIN_LENGTH = 32;
let warnedShortToken = false;

// "admin" only for `Authorization: Bearer <ADMIN_TOKEN>` with a long enough ADMIN_TOKEN set; "denied"
// when an Authorization header is sent but does not match; "none" without one.
function adminAuth(req: Request): "admin" | "denied" | "none" {
  const header = req.headers.get("authorization");
  if (!header) return "none";
  const token = process.env.ADMIN_TOKEN?.trim() ?? "";
  if (token && token.length < ADMIN_TOKEN_MIN_LENGTH && !warnedShortToken) {
    warnedShortToken = true;
    console.error(`ADMIN_TOKEN is shorter than ${ADMIN_TOKEN_MIN_LENGTH} characters: the platform-paid graduation is disabled`);
  }
  if (token.length < ADMIN_TOKEN_MIN_LENGTH) return "denied";
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want) ? "admin" : "denied";
}

// Anyone can trigger graduation once the goal is reached, and the caller's wallet pays: this returns a
// migrate transaction with that wallet as fee payer and the two position-NFT keys already signed.
// The platform-paid path (signed and sent here) is only for an operator holding ADMIN_TOKEN.
// When the pool has already graduated (Meteora's keeper or another wallet), the answer is { already: true }.
export async function POST(req: Request, ctx: RouteContext<"/api/campaigns/[pool]/migrate">) {
  try {
    const { pool } = await ctx.params;
    if (!getCampaign(pool)) throw new BadRequest("Unknown campaign");
    const conn = connection();
    const client = dbcClient(conn);
    const state = await client.state.getPool(pool);
    if (!state) throw new BadRequest("Pool not found");
    if (Number(state.poolState.isMigrated) === 1) return Response.json({ ok: true, already: true });

    const auth = adminAuth(req);
    if (auth === "denied") return Response.json({ error: "Unauthorized" }, { status: 401 });
    const raw: unknown = await req.json().catch(() => null);
    const wallet = raw && typeof raw === "object" ? (raw as { wallet?: unknown }).wallet : undefined;
    const payer = auth === "admin" ? null : publicKey(wallet);
    if ((await client.state.getPoolQuoteTokenCurveProgress(pool)) < 1) throw new BadRequest("Goal not reached yet");
    if (!payer) {
      const platform = loadKeypair("platform");
      const { tx, extraSigners } = await buildMigrateTx(conn, platform.publicKey, new PublicKey(pool));
      tx.feePayer = platform.publicKey;
      await withPriorityFee(tx, conn); // send() sets the blockhash and signs after this
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
