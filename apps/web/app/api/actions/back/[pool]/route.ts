// Solana Action (Blink) for backing a campaign straight from a shared link.
// Spec: https://solana.com/docs/advanced/actions
import {
  buildBuyTx,
  buildBuyUnitsTx,
  getCampaign,
  getNetwork,
  launchFeeWindow,
  planUnits,
  readCampaignLive,
  readCurve,
  summarizeUnits,
  unitsReferral,
  unitsToRaw,
  UnitsError,
  type UnitsQuote,
} from "@preorder/core";
import { PublicKey } from "@solana/web3.js";
import { unitsDown } from "@/lib/format";
import { connection, finalizeForWallet, publicOrigin } from "@/lib/server";

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

  let description = record.campaign.description ?? "";
  let disabled = false;
  // Live prices for "Back 1" and "Back 2", fee included, from one read of the curve.
  const quotes: Partial<Record<1 | 2, UnitsQuote>> = {};
  let maxUnits: number | undefined;
  try {
    const conn = connection();
    const [live, curve] = await Promise.all([readCampaignLive(conn, record), readCurve(conn, record.pool)]);
    const pct = Math.round(live.progress * 100);
    disabled = live.status !== "funding";
    let fee = "";
    if (!disabled) {
      for (const n of [1, 2] as const) {
        try {
          quotes[n] = summarizeUnits(planUnits(curve, unitsToRaw(n)));
        } catch {
          // Fewer than n units left: that button is left out.
        }
      }
      maxUnits = quotes[1]?.maxUnits;
      // The launch fee is part of every price above; say so while it is still high.
      const feePct = quotes[1]?.feePct ?? 0;
      if (feePct > 5) {
        const { secondsLeft } = launchFeeWindow(curve, record.campaign.dropBot.windowSec);
        const when = secondsLeft > 0 ? ` within ${Math.max(1, Math.ceil(secondsLeft / 60))} min` : " soon";
        fee = ` Launch fee is ${feePct.toFixed(1)}% right now and falls to ${record.campaign.normalFeeBps / 100}%${when}.`;
      }
    }
    description = `${pct}% funded · $${live.priceUsdc.toFixed(2)} per unit now, rising as tiers fill. Each unit is one voucher for one item.${fee} ${description}`.trim();
  } catch {
    // Show the Blink without live numbers if the RPC is slow.
  }

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
    disabled,
    ...(disabled && { error: { message: "This campaign is funded. Vouchers now trade on its resale market." } }),
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

export async function POST(req: Request, ctx: RouteContext<"/api/actions/back/[pool]">) {
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return json({ message: "Campaign not found" }, 404);
    const url = new URL(req.url);
    const { account } = (await req.json()) as { account: string };
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(account);
    } catch {
      return json({ message: "Invalid account" }, 400);
    }
    const ref = url.searchParams.get("ref");

    // Whole units (ExactOut). Links shared before units existed carry a USDC `amount` instead.
    if (url.searchParams.has("units")) {
      const conn = connection();
      const referral = await unitsReferral(conn, new PublicKey(record.usdcMint), ref, wallet);
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

    const amount = Number(url.searchParams.get("amount"));
    if (!(amount > 0)) return json({ message: "Pick a whole number of units" }, 400);
    let referral: PublicKey | null = null;
    if (ref && ref !== account) {
      const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
      referral = getAssociatedTokenAddressSync(new PublicKey(record.usdcMint), new PublicKey(ref), true);
    }
    const tx = await finalizeForWallet(await buildBuyTx(connection(), wallet, new PublicKey(pool), amount, referral), wallet);
    return json({
      type: "transaction",
      transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      message: `Backed ${record.campaign.name} with $${amount}. Your vouchers are in your wallet.`,
    });
  } catch (e) {
    if (e instanceof UnitsError) return json({ message: e.message }, e.status);
    return json({ message: e instanceof Error ? e.message : "Something went wrong" }, 500);
  }
}
