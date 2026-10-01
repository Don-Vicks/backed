// Solana Action (Blink) for backing a campaign straight from a shared link.
// Spec: https://solana.com/docs/advanced/actions
import {
  DEFAULT_SLIPPAGE_BPS,
  HttpError,
  buildBuyTx,
  getCampaign,
  getNetwork,
  parseWith,
  readCampaignLive,
  resolveReferral,
  schemas,
  summarizeBuyQuote,
  type CampaignLive,
} from "@preorder/core";
import { PublicKey } from "@solana/web3.js";
import { connection, errorResponse, finalizeForWallet, logLine, publicOrigin, rateLimit, readJson, requestLog } from "@/lib/server";

// CAIP-2 ids; a local validator has no fixed genesis hash, so it uses the Wallet Standard name.
const CHAIN_ID = {
  localnet: "solana:localnet",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
};

function headers() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Content-Encoding, Accept-Encoding, X-Accept-Action-Version, X-Accept-Blockchain-Ids",
    "Access-Control-Expose-Headers": "X-Action-Version, X-Blockchain-Ids",
    "X-Action-Version": "2.4",
    "X-Blockchain-Ids": CHAIN_ID[getNetwork().name],
    "Content-Type": "application/json",
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: headers() });

export const OPTIONS = () => new Response(null, { headers: headers() });

export async function GET(req: Request, ctx: RouteContext<"/api/actions/back/[pool]">) {
  const log = requestLog("GET /api/actions/back/[pool]");
  const { pool } = await ctx.params;
  const record = getCampaign(pool);
  if (!record) return json({ message: "Campaign not found" }, 404);
  // The fallback icon needs the public origin; a campaign with its own image does not.
  let icon = record.campaign.image;
  if (!icon) {
    try {
      icon = `${publicOrigin(req)}/blink-icon.svg`;
    } catch (e) {
      console.error(e);
      return json({ message: "Something went wrong" }, 500);
    }
  }
  const ref = new URL(req.url).searchParams.get("ref");
  const refQs = ref ? `&ref=${encodeURIComponent(ref)}` : "";
  const base = `/api/actions/back/${pool}?amount=`;

  // Live state decides the copy and whether the Blink can be used; if it can't be read, the Blink is
  // shown disabled rather than offering a buy that may not be possible.
  const about = record.campaign.description ?? "";
  let live: CampaignLive | null = null;
  try {
    live = await readCampaignLive(connection(), record);
  } catch (e) {
    logLine("error", { reqId: log.reqId, route: log.route, pool, err: e instanceof Error ? e.message : String(e) });
  }
  const { description, error } = blinkCopy(live, about);

  return json({
    type: "action",
    icon,
    title: `Back ${record.campaign.name}`,
    description,
    label: "Back this",
    disabled: !!error,
    ...(error && { error: { message: error } }),
    links: {
      actions: [
        { type: "transaction", label: "Back $10", href: `${base}10${refQs}` },
        { type: "transaction", label: "Back $25", href: `${base}25${refQs}` },
        {
          type: "transaction",
          label: "Back",
          href: `${base}{amount}${refQs}`,
          parameters: [{ type: "number", name: "amount", label: "USDC amount", required: true, min: 1 }],
        },
      ],
    },
  });
}

// What the Blink says in each state; `error` set means it is disabled.
function blinkCopy(live: CampaignLive | null, about: string): { description: string; error?: string } {
  if (!live) return { description: about, error: "Live campaign data is unavailable right now. Try again in a moment." };
  if (live.status === "funded") {
    return {
      description: `Goal reached · 100% funded. ${about}`.trim(),
      error: "This campaign reached its goal. Its resale market opens once it graduates on the campaign page.",
    };
  }
  if (live.status === "reselling") {
    return { description: `Funded · vouchers now trade on its resale market. ${about}`.trim(), error: "This campaign is funded. Vouchers now trade on its resale market." };
  }
  const pct = Math.round(live.progress * 100);
  return { description: `${pct}% funded · $${live.priceUsdc.toFixed(2)} per unit now, rising as tiers fill. ${about}`.trim() };
}

export async function POST(req: Request, ctx: RouteContext<"/api/actions/back/[pool]">) {
  const log = requestLog("POST /api/actions/back/[pool]");
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return json({ message: "Campaign not found" }, 404);
    rateLimit(req, "blink");
    const url = new URL(req.url);
    const amount = parseWith(schemas.blinkAmount, url.searchParams.get("amount") ?? "");
    const { account: wallet } = await readJson(req, schemas.blinkPost);
    log.wallet = wallet.toBase58();
    const conn = connection();
    let status: CampaignLive["status"];
    try {
      status = (await readCampaignLive(conn, record)).status;
    } catch {
      throw new HttpError("Live campaign data is unavailable right now. Try again in a moment.", 503);
    }
    if (status !== "funding") {
      throw new HttpError(status === "funded" ? "This campaign reached its goal: backing is closed." : "This campaign is funded. Vouchers now trade on its resale market.", 422);
    }
    // A bad, self or unusable referral is dropped silently: it must never block the buy.
    const referral = await resolveReferral(conn, new PublicKey(record.usdcMint), url.searchParams.get("ref"), wallet);
    const built = await buildBuyTx(conn, wallet, new PublicKey(record.pool), amount, { referral });
    const tx = await finalizeForWallet(built.tx, wallet);
    const quote = summarizeBuyQuote(built.quote, DEFAULT_SLIPPAGE_BPS);
    const message = quote.capped
      ? `Backed ${record.campaign.name} with $${quote.spentUsdc.toFixed(2)}, the last of the goal; the rest stays in your wallet.`
      : `Backed ${record.campaign.name} with $${amount}. Your vouchers are in your wallet.`;
    return json({
      type: "transaction",
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      message,
    });
  } catch (e) {
    return errorResponse(e, log, { field: "message", headers: headers() });
  }
}
