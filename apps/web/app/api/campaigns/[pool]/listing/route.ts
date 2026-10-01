import { PublicKey } from "@solana/web3.js";
import { buildPoolMetadataTx, getCampaign, readPoolCreator } from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, publicKey, publicOrigin, serialize } from "@/lib/server";

// The campaign's on-chain listing (DBC pool metadata: name, campaign page, image), sent after create as
// a second transaction because the create transaction has no room for it. The maker signs and pays as
// the pool creator recorded on chain.
export async function POST(req: Request, ctx: RouteContext<"/api/campaigns/[pool]/listing">) {
  try {
    const origin = publicOrigin(req);
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const body: unknown = await req.json().catch(() => {
      throw new BadRequest("Invalid JSON body");
    });
    const wallet = publicKey(body && typeof body === "object" ? (body as { wallet?: unknown }).wallet : undefined);
    const conn = connection();
    const creator = await readPoolCreator(conn, new PublicKey(record.pool));
    if (!creator) return Response.json({ error: "Campaign pool not found on chain" }, { status: 404 });
    if (!creator.equals(wallet)) throw new BadRequest("Only the maker can publish the listing");
    const tx = await buildPoolMetadataTx(conn, record, wallet, origin);
    if (!tx) throw new BadRequest("This campaign is already listed on-chain");
    return Response.json(serialize(await finalizeForWallet(tx, wallet)));
  } catch (e) {
    return errorResponse(e);
  }
}
