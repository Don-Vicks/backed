import { PublicKey } from "@solana/web3.js";
import { buildPoolMetadataTx, getCampaign, onChainCreator } from "@preorder/core";
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
    const { wallet: raw } = (await req.json()) as { wallet?: string };
    const wallet = publicKey(raw);
    const conn = connection();
    if (!(await onChainCreator(conn, new PublicKey(record.pool))).equals(wallet)) throw new BadRequest("Only the maker can publish the listing");
    const tx = await buildPoolMetadataTx(conn, record, wallet, origin);
    if (!tx) throw new BadRequest("This campaign is already listed on-chain");
    return Response.json(serialize(await finalizeForWallet(tx, wallet)));
  } catch (e) {
    return errorResponse(e);
  }
}
