// Solana Action (Blink) for backing a campaign straight from a shared link.
// Spec: https://solana.com/docs/advanced/actions
import { buildBuyTx, getCampaign, getNetwork, readCampaignLive } from "@preorder/core";
import { PublicKey } from "@solana/web3.js";
import { connection, finalizeForWallet } from "@/lib/server";

const CHAIN_ID = { devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" };

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
  const origin = new URL(req.url).origin;
  if (!record) return json({ message: "Campaign not found" }, 404);
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
    icon: record.campaign.image || `${origin}/blink-icon.svg`,
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
    const ref = url.searchParams.get("ref");
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
    return json({ message: e instanceof Error ? e.message : "Something went wrong" }, 500);
  }
}
