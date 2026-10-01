// Solana Action (Blink) for backing a campaign straight from a shared link.
// Spec: https://solana.com/docs/advanced/actions
import { DEFAULT_SLIPPAGE_BPS, SwapError, buildBuyTx, getCampaign, getNetwork, readCampaignLive, resolveReferral, summarizeBuyQuote } from "@preorder/core";
import { PublicKey } from "@solana/web3.js";
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
  const base = `/api/actions/back/${pool}?amount=`;

  let description = record.campaign.description ?? "";
  let disabled = false;
  try {
    const live = await readCampaignLive(connection(), record);
    const pct = Math.round(live.progress * 100);
    description = `${pct}% funded · $${live.priceUsdc.toFixed(2)} per unit now, rising as tiers fill. ${description}`.trim();
    disabled = live.status !== "funding";
  } catch {
    // Show the Blink without live numbers if the RPC is slow.
  }

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

export async function POST(req: Request, ctx: RouteContext<"/api/actions/back/[pool]">) {
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return json({ message: "Campaign not found" }, 404);
    const url = new URL(req.url);
    const amount = Number(url.searchParams.get("amount"));
    if (!(amount > 0)) return json({ message: "Enter an amount in USDC" }, 400);
    const { account } = (await req.json()) as { account: string };
    let wallet: PublicKey;
    try {
      wallet = new PublicKey(account);
    } catch {
      return json({ message: "Invalid account" }, 400);
    }
    const conn = connection();
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
    if (e instanceof SwapError) return json({ message: e.message }, e.status);
    return json({ message: e instanceof Error ? e.message : "Something went wrong" }, 500);
  }
}
