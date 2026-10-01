import { randomBytes } from "crypto";
import { Keypair } from "@solana/web3.js";
import {
  buildCreateCampaignTx,
  getUsdcMint,
  listCampaigns,
  loadKeypair,
  readCampaignLive,
  saveMetadata,
  savePending,
  type Campaign,
} from "@preorder/core";
import { BadRequest, connection, errorResponse, finalizeForWallet, publicKey, publicOrigin, serialize, trustFor } from "@/lib/server";

export async function GET() {
  try {
    const conn = connection();
    const campaigns = await Promise.all(
      listCampaigns().map(async (c) => ({ ...c, live: await readCampaignLive(conn, c).catch(() => null) })),
    );
    return Response.json({ campaigns });
  } catch (e) {
    return errorResponse(e);
  }
}

// Builds the create-campaign transaction for the maker's wallet. The platform (partner) key and the
// fresh config + mint keys sign here; the maker signs as pool creator in the browser.
export async function POST(req: Request) {
  try {
    // First, so a misconfigured deploy fails before any RPC call or write.
    const origin = publicOrigin(req);
    const body = (await req.json()) as { campaign: Campaign; maker: string; verifiedSocial?: boolean };
    const maker = publicKey(body.maker, "maker");
    if (!body.campaign?.name?.trim()) throw new BadRequest("Name the product");
    const trust = await trustFor(maker.toBase58(), !!body.verifiedSocial);
    // Token metadata lives at our own URL, kept short because every uri byte is in the create tx.
    const metaId = randomBytes(8).toString("base64url").slice(0, 10);
    const campaign: Campaign = { ...body.campaign, name: body.campaign.name.trim().slice(0, 32), symbol: body.campaign.symbol.trim().toUpperCase().slice(0, 10), uri: `${origin}/m/${metaId}` };
    saveMetadata(metaId, { name: campaign.name, symbol: campaign.symbol, description: campaign.description ?? "", image: campaign.image ?? "" });
    const platform = loadKeypair("platform");
    const usdcMint = getUsdcMint();
    const conn = connection();
    let built;
    try {
      built = await buildCreateCampaignTx({ connection: conn, campaign, tier: trust.tier, platform: platform.publicKey, maker, usdcMint });
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const tx = await finalizeForWallet(built.tx, platform.publicKey);
    tx.partialSign(platform, ...(built.extraSigners as Keypair[]));
    savePending({
      pool: built.pool.toBase58(),
      config: built.config.toBase58(),
      baseMint: built.baseMint.toBase58(),
      usdcMint: usdcMint.toBase58(),
      maker: maker.toBase58(),
      createdAt: new Date().toISOString(),
      createSignature: "",
      campaign,
      trust: { tier: trust.tier, score: trust.score, reasons: trust.reasons, maxMakerSharePct: trust.maxMakerSharePct },
      goalUsdc: built.onChain.goalUsdc,
      totalUnits: built.onChain.totalUnits,
      fields: built.fields,
    });
    return Response.json({ ...serialize(tx), pool: built.pool.toBase58() });
  } catch (e) {
    return errorResponse(e);
  }
}
