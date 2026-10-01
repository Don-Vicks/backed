import { PublicKey } from "@solana/web3.js";
import { buildPoolMetadataTx, getCampaign, HttpError, readPoolCreator, schemas } from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, publicOrigin, rateLimit, readJson, requestLog, serialize } from "@/lib/server";

// The campaign's on-chain listing (DBC pool metadata: name, campaign page, image), sent after create as
// a second transaction because the create transaction has no room for it. The maker signs and pays as
// the pool creator recorded on chain.
export async function POST(req: Request, ctx: RouteContext<"/api/campaigns/[pool]/listing">) {
  const log = requestLog("POST /api/campaigns/[pool]/listing");
  try {
    rateLimit(req, "tx");
    const origin = publicOrigin(req);
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) throw new HttpError("Campaign not found", 404);
    const { wallet } = await readJson(req, schemas.listing);
    log.wallet = wallet.toBase58();
    const conn = connection();
    const creator = await readPoolCreator(conn, new PublicKey(record.pool));
    if (!creator) throw new HttpError("Campaign pool not found on chain", 404);
    if (!creator.equals(wallet)) throw new BadRequest("Only the maker can publish the listing");
    const tx = await buildPoolMetadataTx(conn, record, wallet, origin);
    if (!tx) throw new HttpError("This campaign is already listed on-chain", 409);
    return Response.json(serialize(await finalizeForWallet(tx, wallet)));
  } catch (e) {
    return errorResponse(e, log);
  }
}
