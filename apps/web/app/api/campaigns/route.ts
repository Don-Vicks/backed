import { randomBytes } from "crypto";
import {
  buildCreateCampaignTx,
  campaignFromInput,
  createCampaignSteps,
  getUsdcMint,
  listCampaigns,
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

// Builds the create-campaign transaction(s) for the maker's wallet. The maker pays and signs as
// payer and pool creator; only the fresh config + mint keys sign here, never the platform key. Large
// campaigns come back as two transactions (createConfig, then createPool) for one signAllTransactions.
export async function POST(req: Request) {
  try {
    // First, so a misconfigured deploy fails before any RPC call or write.
    const origin = publicOrigin(req);
    const body = (await req.json()) as { campaign: unknown; maker: string; verifiedSocial?: boolean };
    const maker = publicKey(body.maker, "maker");
    // Token metadata lives at our own URL, kept short because every uri byte is in the create tx.
    const metaId = randomBytes(8).toString("base64url").slice(0, 10);
    let campaign: Campaign;
    try {
      campaign = campaignFromInput(body.campaign, `${origin}/m/${metaId}`);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const trust = await trustFor(maker.toBase58(), !!body.verifiedSocial);
    const usdcMint = getUsdcMint();
    const conn = connection();
    let built;
    try {
      built = await buildCreateCampaignTx({ connection: conn, campaign, tier: trust.tier, maker, usdcMint });
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const steps = createCampaignSteps(built, maker);
    for (const step of steps) {
      await finalizeForWallet(step.tx, maker);
      step.tx.partialSign(...step.signers);
    }
    saveMetadata(metaId, { name: campaign.name, symbol: campaign.symbol, description: campaign.description ?? "", image: campaign.image ?? "" });
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
    // In order: the wallet signs them all at once and the client sends each after the previous confirms.
    return Response.json({ txs: steps.map((step) => serialize(step.tx)), pool: built.pool.toBase58() });
  } catch (e) {
    return errorResponse(e);
  }
}
