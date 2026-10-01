import { randomBytes } from "crypto";
import {
  buildCreateCampaignTx,
  campaignFromInput,
  campaignToConfig,
  createCampaignSteps,
  getUsdcMint,
  HttpError,
  listCampaigns,
  readCampaignsLive,
  saveMetadata,
  savePending,
  schemas,
  type Campaign,
  type TrustResult,
} from "@preorder/core";
import {
  BadRequest,
  connection,
  errorResponse,
  finalizeForWallet,
  logLine,
  publicOrigin,
  rateLimit,
  readJson,
  requestLog,
  serialize,
  trustFor,
} from "@/lib/server";

// Every campaign with its live state, read in batches and cached per pool for a few seconds; a pool
// that can't be read right now comes back with live: null.
export async function GET() {
  const log = requestLog("GET /api/campaigns");
  try {
    const records = listCampaigns();
    const live = await readCampaignsLive(connection(), records).catch((e) => {
      logLine("error", { reqId: log.reqId, route: log.route, err: e instanceof Error ? e.message : String(e) });
      return records.map(() => null);
    });
    return Response.json({ campaigns: records.map((c, i) => ({ ...c, live: live[i] })) });
  } catch (e) {
    return errorResponse(e, log);
  }
}

// Builds the create-campaign transaction(s) for the maker's wallet. The maker pays and signs as
// payer and pool creator; only the fresh config + mint keys sign here, never the platform key. Large
// campaigns come back as two transactions (createConfig, then createPool) for one signAllTransactions.
export async function POST(req: Request) {
  const log = requestLog("POST /api/campaigns");
  try {
    // First, so a misconfigured deploy fails before any RPC call or write.
    const origin = publicOrigin(req);
    rateLimit(req, "create");
    const body = await readJson(req, schemas.createCampaign);
    const maker = body.maker;
    log.wallet = maker.toBase58();
    // Token metadata lives at our own URL, kept short because every uri byte is in the create tx.
    const metaId = randomBytes(8).toString("base64url").slice(0, 10);
    let campaign: Campaign;
    try {
      campaign = campaignFromInput(body.campaign, `${origin}/m/${metaId}`);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    // The tier caps the maker's share, so a failed lookup stops the launch instead of guessing a tier.
    let trust: TrustResult;
    try {
      trust = await trustFor(maker.toBase58(), req);
    } catch (e) {
      if (e instanceof HttpError && e.status === 429) throw e;
      logLine("error", { reqId: log.reqId, route: log.route, wallet: log.wallet, err: `trust lookup: ${e instanceof Error ? e.message : String(e)}` });
      throw new HttpError("Your wallet's trust check is unavailable right now. Try again in a minute.", 503);
    }
    // The same validation the build runs, first: a share above the tier cap or a bad plan is the maker's
    // to fix (400); anything the build itself throws after this is ours (500).
    try {
      campaignToConfig(campaign, trust.tier);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const usdcMint = getUsdcMint();
    const conn = connection();
    const built = await buildCreateCampaignTx({ connection: conn, campaign, tier: trust.tier, maker, usdcMint });
    const steps = createCampaignSteps(built, maker);
    for (const step of steps) {
      await finalizeForWallet(step.tx, maker);
      step.tx.partialSign(...step.signers);
    }
    // Only a request that built a valid transaction leaves metadata behind.
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
      migrationFeeOption: built.onChain.migrationFeeOption,
    });
    // In order: the wallet signs them all at once and the client sends each after the previous confirms.
    return Response.json({ txs: steps.map((step) => serialize(step.tx)), pool: built.pool.toBase58() });
  } catch (e) {
    return errorResponse(e, log);
  }
}
