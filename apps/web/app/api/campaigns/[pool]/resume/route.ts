import { PublicKey } from "@solana/web3.js";
import { buildCreatePoolTx, confirmListing, dbcClient, deletePending, getPending, savePending, schemas, transaction } from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, rateLimit, readJson, requestLog, serialize } from "@/lib/server";

const nothingToResume = (error: string) => Response.json({ error }, { status: 404 });

// Finishes a split create whose first step (createConfig) landed but whose second (createPool) did not.
// Returns one createPool transaction on that config with a fresh mint key, for the maker to sign, and
// moves the pending record to the new pool address. When the original pool exists after all, it is
// listed and no transaction comes back.
export async function POST(req: Request, ctx: RouteContext<"/api/campaigns/[pool]/resume">) {
  const log = requestLog("POST /api/campaigns/[pool]/resume");
  try {
    rateLimit(req, "tx");
    const { pool } = await ctx.params;
    const { maker } = await readJson(req, schemas.resumeCampaign);
    log.wallet = maker.toBase58();
    const record = getPending(pool);
    if (!record) return nothingToResume("Nothing to resume for this campaign: launch it again");
    if (record.maker !== maker.toBase58()) throw new BadRequest("Only the maker can finish this launch");

    const conn = connection();
    const client = dbcClient(conn);
    const config = await client.state.getPoolConfig(record.config).catch(() => null);
    if (!config) return nothingToResume("This campaign’s config is not on-chain: launch it again");
    if (!config.quoteMint.equals(new PublicKey(record.usdcMint))) throw new BadRequest("Config does not match this campaign");
    if (await client.state.getPool(pool).catch(() => null)) {
      await confirmListing(conn, pool, undefined, { waitMs: 0, maxPages: 10 });
      return Response.json({ txs: [], pool });
    }

    const usdcMint = new PublicKey(record.usdcMint);
    const built = await buildCreatePoolTx({ connection: conn, config: new PublicKey(record.config), campaign: record.campaign, maker, usdcMint });
    await finalizeForWallet(built.tx, maker);
    built.tx.partialSign(...built.extraSigners);
    // Moved, not expired: the new pool uses the same token metadata.
    transaction(() => {
      savePending({ ...record, pool: built.pool.toBase58(), baseMint: built.baseMint.toBase58() });
      deletePending(pool);
    });
    return Response.json({ txs: [serialize(built.tx)], pool: built.pool.toBase58() });
  } catch (e) {
    return errorResponse(e, log);
  }
}
