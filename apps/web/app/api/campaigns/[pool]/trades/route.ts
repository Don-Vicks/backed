import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getCampaign, type CampaignRecord } from "@preorder/core";
import { connection, errorResponse, requestLog } from "@/lib/server";
import type { Trade } from "@/lib/types";

// Every buy and sell of a campaign's vouchers, read from chain: on the bonding curve while funding, on
// the DAMM v2 pool after. Both swaps name the voucher mint, so one signature history covers both. A
// trade is a transaction whose signer gained vouchers and paid USDC (a buy) or the reverse (a sell);
// its price is the USDC moved per voucher, fees included, which is what the trader actually paid.

const LIMIT = 250;
const TTL_MS = 15_000;
const cache = new Map<string, { at: number; trades: Trade[] }>();

function tradeOf(tx: ParsedTransactionWithMeta | null, sig: string, record: CampaignRecord): Trade | null {
  if (!tx?.meta || tx.meta.err || !tx.blockTime) return null;
  const keys = tx.transaction.message.accountKeys;
  const wallet = keys[0].pubkey.toBase58();
  const delta = (mint: string) => {
    const amount = (list: typeof tx.meta.preTokenBalances) =>
      (list ?? []).filter((b) => b.owner === wallet && b.mint === mint).reduce((a, b) => a + (b.uiTokenAmount.uiAmount ?? 0), 0);
    return amount(tx.meta!.postTokenBalances) - amount(tx.meta!.preTokenBalances);
  };
  const dv = delta(record.baseMint);
  const du = delta(record.usdcMint);
  if (Math.abs(dv) < 1e-6 || Math.abs(du) < 1e-6 || Math.sign(dv) === Math.sign(du)) return null; // not a swap (a burn, a transfer, a migration)
  const venue = keys.some((k) => k.pubkey.toBase58() === record.pool) ? "curve" : "resale";
  return { sig, time: tx.blockTime, side: dv > 0 ? "buy" : "sell", venue, vouchers: Math.abs(dv), usdc: Math.abs(du), price: Math.abs(du) / Math.abs(dv), wallet };
}

async function fetchTrades(record: CampaignRecord): Promise<Trade[]> {
  const conn = connection();
  const sigs = (await conn.getSignaturesForAddress(new PublicKey(record.baseMint), { limit: LIMIT })).filter((s) => !s.err);
  const chunks = Array.from({ length: Math.ceil(sigs.length / 25) }, (_, i) => sigs.slice(i * 25, i * 25 + 25));
  const trades: Trade[] = [];
  // A few chunks at a time: quicker than one by one, gentler on a public RPC than all at once.
  for (let i = 0; i < chunks.length; i += 3) {
    const batch = chunks.slice(i, i + 3);
    const results = await Promise.all(batch.map((chunk) => conn.getParsedTransactions(chunk.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: "confirmed" })));
    results.forEach((txs, k) =>
      txs.forEach((tx, j) => {
        const t = tradeOf(tx, batch[k][j].signature, record);
        if (t) trades.push(t);
      }),
    );
  }
  return trades.sort((a, b) => a.time - b.time);
}

// Stale-while-revalidate: a stale history is served at once while one refresh runs behind it.
const refreshing = new Map<string, Promise<Trade[]>>();
async function readTrades(record: CampaignRecord): Promise<Trade[]> {
  const hit = cache.get(record.pool);
  const fresh = hit && Date.now() - hit.at < TTL_MS;
  if (fresh) return hit.trades;
  let job = refreshing.get(record.pool);
  if (!job) {
    job = fetchTrades(record)
      .then((trades) => {
        cache.set(record.pool, { at: Date.now(), trades });
        return trades;
      })
      .finally(() => refreshing.delete(record.pool));
    refreshing.set(record.pool, job);
  }
  return hit ? hit.trades : job;
}

export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]/trades">) {
  const log = requestLog("GET /api/campaigns/[pool]/trades");
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    return Response.json({ trades: await readTrades(record) });
  } catch (e) {
    return errorResponse(e, log);
  }
}
