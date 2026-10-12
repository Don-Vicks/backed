import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { getCampaign, getTradeHistory, saveTradeHistory, type CampaignRecord, type TradeHistory } from "@preorder/core";
import { connection, errorResponse, logLine, requestLog } from "@/lib/server";
import type { Trade } from "@/lib/types";

// Every buy and sell of a campaign's vouchers, read from chain: on the bonding curve while funding, on
// the DAMM v2 pool after. Both swaps name the voucher mint, so one signature history covers both. A
// trade is a transaction whose signer gained vouchers and paid USDC (a buy) or the reverse (a sell);
// its price is the USDC moved per voucher, fees included, which is what the trader actually paid.
//
// Public RPCs allow only a handful of transaction reads per window (devnet: 10), so the history is
// kept in the store, a refresh reads only the signatures since the newest one seen, reads go one pool
// at a time and a few transactions at a time, and a request never waits on them: a pool not read yet
// answers `warming` at once and the page asks again.

const LIMIT = 250;
const TTL_MS = 15_000;
const CHUNK = 4;
const PAUSE_MS = 4500;

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rateLimited = (e: unknown) => /429|Too many requests/i.test(e instanceof Error ? e.message : String(e));

// A rate-limited read waits and tries again, longer each time, before giving up.
async function withBackoff<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      if (!rateLimited(e) || attempt >= 5) throw e;
      await sleep(2000 * 2 ** attempt);
    }
  }
}

async function readNew(record: CampaignRecord, prev?: TradeHistory<Trade>): Promise<TradeHistory<Trade>> {
  const conn = connection();
  const sigs = (await withBackoff(() => conn.getSignaturesForAddress(new PublicKey(record.baseMint), { limit: LIMIT, until: prev?.newest }))).filter((s) => !s.err);
  const seen = new Set(prev?.trades.map((t) => t.sig));
  const trades = [...(prev?.trades ?? [])];
  for (let i = 0; i < sigs.length; i += CHUNK) {
    if (i) await sleep(PAUSE_MS);
    const chunk = sigs.slice(i, i + CHUNK);
    const txs = await withBackoff(() => conn.getParsedTransactions(chunk.map((s) => s.signature), { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
    txs.forEach((tx, j) => {
      const t = tradeOf(tx, chunk[j].signature, record);
      if (t && !seen.has(t.sig)) trades.push(t);
    });
  }
  return { updatedAt: Date.now(), trades: trades.sort((a, b) => a.time - b.time), newest: sigs[0]?.signature ?? prev?.newest };
}

// One pool at a time across the server (kept on globalThis so dev reloads share it), each refresh at most
// once in flight.
const g = globalThis as { __tradeQueue?: Promise<unknown>; __tradeJobs?: Map<string, Promise<void>> };
g.__tradeQueue ??= Promise.resolve();
const jobs = (g.__tradeJobs ??= new Map());

function refresh(record: CampaignRecord) {
  if (jobs.has(record.pool)) return;
  const job = g.__tradeQueue!
    .then(async () => saveTradeHistory(record.pool, await readNew(record, getTradeHistory<Trade>(record.pool))))
    .catch((e) => logLine("error", { route: "trades refresh", pool: record.pool, err: e instanceof Error ? e.message : String(e) }))
    .finally(() => jobs.delete(record.pool));
  g.__tradeQueue = job;
  jobs.set(record.pool, job);
}

export async function GET(_req: Request, ctx: RouteContext<"/api/campaigns/[pool]/trades">) {
  const log = requestLog("GET /api/campaigns/[pool]/trades");
  try {
    const { pool } = await ctx.params;
    const record = getCampaign(pool);
    if (!record) return Response.json({ error: "Campaign not found" }, { status: 404 });
    const history = getTradeHistory<Trade>(pool);
    if (!history || Date.now() - history.updatedAt > TTL_MS) refresh(record);
    return Response.json({ trades: history?.trades ?? [], warming: !history });
  } catch (e) {
    return errorResponse(e, log);
  }
}
