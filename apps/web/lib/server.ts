import "server-only";
import { randomBytes } from "crypto";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  clientIp,
  getConnection,
  getMetadata,
  getNetwork,
  HttpError,
  MAX_BODY_BYTES,
  parseWith,
  RATE_LIMITS,
  readCampaignLive,
  readJsonBody,
  readTrustSignals,
  resolvePublicOrigin,
  scoreSignals,
  SwapError,
  takeRateToken,
  trustFixture,
  trustRpcUrl,
  ttlCache,
  withPriorityFee,
  type BodyOf,
  type BodySchema,
  type CampaignLive,
  type CampaignRecord,
  type RateLimitName,
  type TrustResult,
} from "@preorder/core";

export const connection = (): Connection => getConnection();

// Origin for URLs that leave the app (token metadata, Blink icons). Throws a ConfigError when
// PUBLIC_BASE_URL is missing or not public https off localnet, so nothing immutable gets a bad URL.
export const publicOrigin = (req?: Request) => resolvePublicOrigin(process.env, getNetwork().name, req?.url);

export function metadataResponse(id: string) {
  const meta = getMetadata(id);
  if (!meta) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(meta, { headers: { "Cache-Control": "public, max-age=300" } });
}

// Trust lookups walk mainnet history: cached for 10 minutes per wallet (at most 5000 wallets), with
// concurrent lookups of one wallet sharing a walk. A failed lookup throws and is not cached; callers
// must say the check is unavailable, never fall back to a tier.
const trustCache = ttlCache<TrustResult>(10 * 60_000, 5000);
export function trustFor(wallet: string): Promise<TrustResult> {
  return trustCache.get(wallet, async () => {
    const signals = trustFixture(wallet) ?? (await readTrustSignals(new Connection(trustRpcUrl(), "confirmed"), new PublicKey(wallet)));
    return scoreSignals(signals);
  });
}

// Blockhash, fee payer and a compute-unit price (off localnet). Any server-side partialSign comes
// after this: the priority fee changes the message.
export async function finalizeForWallet(tx: Transaction, feePayer: PublicKey) {
  const conn = connection();
  tx.feePayer = feePayer;
  const [{ blockhash, lastValidBlockHeight }] = await Promise.all([conn.getLatestBlockhash("confirmed"), withPriorityFee(tx, conn)]);
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return tx;
}

// Transaction.from() on the client does not restore lastValidBlockHeight, so it travels alongside.
export const serialize = (tx: Transaction) => ({
  tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
  lastValidBlockHeight: tx.lastValidBlockHeight!,
});

export function publicKey(value: unknown, name = "wallet"): PublicKey {
  try {
    return new PublicKey(String(value));
  } catch {
    throw new BadRequest(`${name} is not a valid Solana address`);
  }
}

export class BadRequest extends HttpError {}

// What one request is about, for its log lines. Routes fill in wallet and sig as they learn them.
export type RequestLog = { reqId: string; route: string; wallet?: string; sig?: string };
export const requestLog = (route: string): RequestLog => ({ reqId: randomBytes(6).toString("hex"), route });

// One JSON object per line, so the host's log search can filter on any field.
export function logLine(level: "info" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

// The JSON body, size-limited and checked against a schema; a 400 (or 413) says what is wrong.
export async function readJson<S extends BodySchema>(req: Request, schema: S, opts: { optional?: boolean } = {}): Promise<BodyOf<S>> {
  return parseWith(schema, await readJsonBody(req, MAX_BODY_BYTES, opts));
}

// Per-IP token bucket for routes that cost RPC calls or platform SOL. RATE_LIMITS=off turns the limits
// (and the faucet caps) off, on localnet only, for test runs that share one IP.
export const rateLimitsOff = () => getNetwork().name === "localnet" && process.env.RATE_LIMITS === "off";
export function rateLimit(req: Request, name: RateLimitName) {
  if (rateLimitsOff()) return;
  const { capacity, perSec } = RATE_LIMITS[name];
  if (!takeRateToken(`${name}:${clientIp(req.headers)}`, capacity, perSec)) {
    throw new HttpError("Too many requests. Wait a moment and try again.", 429);
  }
}

// Live campaign state for a status gate. An RPC failure is a 503 the user can retry, not a 500.
export async function liveOrUnavailable(record: CampaignRecord, log: RequestLog): Promise<CampaignLive> {
  try {
    return await readCampaignLive(connection(), record);
  } catch (e) {
    logLine("error", { reqId: log.reqId, route: log.route, pool: record.pool, err: e instanceof Error ? e.message : String(e) });
    throw new HttpError("Live campaign data is unavailable right now. Try again in a moment.", 503);
  }
}

// 4xx: the message is for the user. 5xx: a generic message with a request id, and one JSON log line
// with the details. Errors we did not raise ourselves (RPC, SDK, bugs) are always a 500. Solana Actions
// put the text in `message` and need their CORS headers on every response.
export function errorResponse(e: unknown, log?: RequestLog, opts: { field?: "error" | "message"; headers?: HeadersInit } = {}) {
  const known = e instanceof HttpError || e instanceof SwapError;
  const status = known ? e.status : 500;
  const field = opts.field ?? "error";
  if (status < 500) return Response.json({ [field]: (e as Error).message }, { status, headers: opts.headers });
  const reqId = log?.reqId ?? requestLog("unknown").reqId;
  logLine("error", {
    reqId,
    route: log?.route,
    wallet: log?.wallet,
    sig: log?.sig,
    status,
    err: e instanceof Error ? e.message : String(e),
    ...(!known && e instanceof Error && { stack: e.stack }),
  });
  const message = known ? (e as Error).message : "Something went wrong on our side.";
  return Response.json({ [field]: `${message} (ref ${reqId})`, requestId: reqId }, { status, headers: opts.headers });
}
