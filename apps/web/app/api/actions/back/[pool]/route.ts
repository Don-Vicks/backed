// Solana Action (Blink) for backing a campaign straight from a shared link.
// Spec: https://solana.com/docs/advanced/actions
import {
  DEFAULT_SLIPPAGE_BPS,
  HttpError,
  buildBuyTx,
  buildBuyUnitsTx,
  getCampaign,
  getNetwork,
  launchFeeWindow,
  parseWith,
  planUnits,
  readCampaignLive,
  readCurveCached,
  resolveReferral,
  schemas,
  summarizeBuyQuote,
  summarizeUnits,
  unitsToRaw,
  type CampaignLive,
  type CurveState,
  type UnitsQuote,
} from "@preorder/core";
import { PublicKey } from "@solana/web3.js";
import { unitsDown } from "@/lib/format";
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
  const base = `/api/actions/back/${pool}?units=`;

  // Live state decides the copy and whether the Blink can be used; if it can't be read, the Blink is
  // shown disabled rather than offering a buy that may not be possible. Both reads are cached per pool
  // for LIVE_TTL_MS, so public unfurls cost no RPC calls per viewer.
  const about = record.campaign.description ?? "";
  const conn = connection();
  const [live, curve] = await Promise.all([
    readCampaignLive(conn, record).catch((e) => {
      logLine("error", { reqId: log.reqId, route: log.route, pool, err: e instanceof Error ? e.message : String(e) });
      return null;
    }),
    readCurveCached(conn, record.pool).catch(() => null), // without it the buttons carry no prices
  ]);
  // Live prices for "Back 1" and "Back 2", fee included, from one read of the curve.
  const quotes: Partial<Record<1 | 2, UnitsQuote>> = {};
  let maxUnits: number | undefined;
  let feeNote = "";
  if (live?.status === "funding" && curve) {
    for (const n of [1, 2] as const) {
      try {
        quotes[n] = summarizeUnits(planUnits(curve, unitsToRaw(n)));
      } catch {
        // Fewer than n units left: that button is left out.
      }
    }
    maxUnits = quotes[1]?.maxUnits;
    feeNote = launchFeeNote(curve, quotes[1], record.campaign.dropBot.windowSec, record.campaign.normalFeeBps);
  }
  const { description, error } = blinkCopy(live, about, feeNote);

  const label = (n: 1 | 2) => {
    const q = quotes[n];
    if (!q) return `Back ${n}`;
    return q.completesGoal ? `Back the last ${unitsDown(q.vouchers)} · $${q.usdc.toFixed(2)}` : `Back ${n} · $${q.usdc.toFixed(2)}`;
  };
  const quick = ([1, 2] as const).filter((n) => quotes[n] || maxUnits === undefined);

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
        ...quick.map((n) => ({ type: "transaction", label: label(n), href: `${base}${n}${refQs}` })),
        {
          type: "transaction",
          label: "Back",
          href: `${base}{units}${refQs}`,
          parameters: [
            {
              type: "number",
              name: "units",
              label: "Units",
              required: true,
              min: 1,
              ...(maxUnits && { max: maxUnits }),
              pattern: "^[0-9]+$",
              patternDescription: "A whole number of units",
            },
          ],
        },
      ],
    },
  });
}

// The launch fee is part of every price on the buttons; say so while it is still high.
function launchFeeNote(curve: CurveState, quote: UnitsQuote | undefined, windowSec: number, normalFeeBps: number): string {
  const feePct = quote?.feePct ?? 0;
  if (feePct <= 5) return "";
  const { secondsLeft } = launchFeeWindow(curve, windowSec);
  const when = secondsLeft > 0 ? ` within ${Math.max(1, Math.ceil(secondsLeft / 60))} min` : " soon";
  return ` Launch fee is ${feePct.toFixed(1)}% right now and falls to ${normalFeeBps / 100}%${when}.`;
}

// What the Blink says in each state; `error` set means it is disabled.
function blinkCopy(live: CampaignLive | null, about: string, feeNote = ""): { description: string; error?: string } {
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
  return { description: `${pct}% funded · $${live.priceUsdc.toFixed(2)} per unit now, rising as tiers fill. Each unit is one voucher for one item.${feeNote} ${about}`.trim() };
}

export async function POST(req: Request, ctx: RouteContext<"/api/actions/back/[pool]">) {
  const log = requestLog("POST /api/actions/back/[pool]");
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return json({ message: "Campaign not found" }, 404);
    rateLimit(req, "blink");
    const url = new URL(req.url);
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

    // Whole units (ExactOut). Links shared before units existed carry a USDC `amount` instead.
    if (url.searchParams.has("units")) {
      const built = await buildBuyUnitsTx(conn, wallet, new PublicKey(record.pool), Number(url.searchParams.get("units")), { referral });
      const tx = await finalizeForWallet(built.tx, wallet);
      const q = built.quote;
      const message = q.completesGoal
        ? `Backed the last ${unitsDown(q.vouchers)} units of ${record.campaign.name} for about $${q.usdc.toFixed(2)}. The goal is reached.`
        : `Backed ${q.vouchers} unit${q.vouchers === 1 ? "" : "s"} of ${record.campaign.name} for about $${q.usdc.toFixed(2)}. Your vouchers are in your wallet.`;
      return json({
        type: "transaction",
        transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
        message,
      });
    }

    const amount = parseWith(schemas.blinkAmount, url.searchParams.get("amount") ?? "");
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
