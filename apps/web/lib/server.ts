import "server-only";
import { randomBytes } from "crypto";
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import {
  clientIp,
  getCampaign,
  getConnection,
  getMetadata,
  getNetwork,
  HttpError,
  MAX_BODY_BYTES,
  ordersMessage,
  parseWith,
  RATE_LIMITS,
  readCampaignLive,
  readJsonBody,
  readTrustSignals,
  publicOrigins as resolvePublicOriginsAll,
  resolvePublicOrigin,
  scoreSignals,
  siteHosts,
  SwapError,
  takeRateToken,
  trustFixture,
  trustRpcUrl,
  ttlCache,
  verifyWalletMessage,
  withPriorityFee,
  type BodyOf,
  type BodySchema,
  type CampaignLive,
  type CampaignRecord,
  type CampaignStatus,
  type RateLimitName,
  type TrustResult,
} from "@preorder/core";

export const connection = (): Connection => getConnection();

// Origin for URLs that leave the app (token metadata, Blink icons). Throws a ConfigError when
// PUBLIC_BASE_URL is missing or not public https off localnet, so nothing immutable gets a bad URL.
export const publicOrigin = (req?: Request) => resolvePublicOrigin(process.env, getNetwork().name, req?.url);
export const publicOrigins = (req?: Request) => resolvePublicOriginsAll(process.env, getNetwork().name, req?.url);

// The maker's sign-in to the orders page: ordersMessage for one of this site's hosts (siteHosts) and the
// campaign, signed by the campaign's maker in the last few minutes. Returns the campaign; 404 or 403 otherwise.
export function requireMakerSignIn(req: Request, body: { pool: PublicKey; message: string; signature: string }): CampaignRecord {
  const record = getCampaign(body.pool.toBase58());
  if (!record) throw new HttpError("Campaign not found", 404);
  // The page signs for the host it is open on, which the message starts with.
  const hosts = siteHosts(process.env, getNetwork().name, req.url);
  const domain = hosts.find((h) => body.message.startsWith(`${h} `));
  if (!domain) throw new HttpError(`That sign-in is for another site. Open the orders page on ${hosts[0]} and sign in again.`, 403);
  try {
    verifyWalletMessage(body.message, body.signature, new PublicKey(record.maker), (issuedAt) => ordersMessage(record.pool, issuedAt, domain));
  } catch (e) {
    throw new HttpError(e instanceof Error ? e.message : "Not authorized", 403);
  }
  return record;
}

export function metadataResponse(id: string) {
  const meta = getMetadata(id);
  if (!meta) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(meta, { headers: { "Cache-Control": "public, max-age=300" } });
}

// Trust lookups walk mainnet history: cached for 10 minutes per wallet (at most 5000 wallets), with
// concurrent lookups of one wallet sharing a walk. A partial result (the RPC was too slow to finish the
// walk) is kept only briefly, so the maker's tier does not depend on one slow minute. A failed lookup
// throws and is not cached; callers must say the check is unavailable, never fall back to a tier.
// Each miss costs the caller's IP a token from the tight "trust" bucket: any address can be looked up.
const TRUST_TTL_MS = 10 * 60_000;
const PARTIAL_TRUST_TTL_MS = 30_000;
const trustCache = ttlCache<TrustResult>((t) => (t.signals.partial ? PARTIAL_TRUST_TTL_MS : TRUST_TTL_MS), 5000);
export function trustFor(wallet: string, req: Request): Promise<TrustResult> {
  if (!trustCache.fresh(wallet)) rateLimit(req, "trust", "Too many trust checks from your network. Try again in a minute.");
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
export function rateLimit(req: Request, name: RateLimitName, message = "Too many requests. Wait a moment and try again.") {
  if (rateLimitsOff()) return;
  const { capacity, perSec } = RATE_LIMITS[name];
  if (!takeRateToken(`${name}:${clientIp(req.headers)}`, capacity, perSec)) throw new HttpError(message, 429);
}

// Live campaign state for a status gate. An RPC failure is a 503 the user can retry, not a 500.
// `fresh` skips the few-second cache (see readCampaignLive).
export async function liveOrUnavailable(record: CampaignRecord, log: RequestLog, opts: { fresh?: boolean } = {}): Promise<CampaignLive> {
  try {
    return await readCampaignLive(connection(), record, opts);
  } catch (e) {
    logLine("error", { reqId: log.reqId, route: log.route, pool: record.pool, err: e instanceof Error ? e.message : String(e) });
    throw new HttpError("Live campaign data is unavailable right now. Try again in a moment.", 503);
  }
}

// A status gate (409 with `message` otherwise). Status only moves forward (funding, funded, reselling),
// so a cached state can only be behind: when it is short of the status needed, the pool is read again
// before refusing, and a graduation that just landed is not turned away for the cache's few seconds.
const STATUS_ORDER: CampaignStatus[] = ["funding", "funded", "reselling"];
export async function requireStatus(record: CampaignRecord, log: RequestLog, status: CampaignStatus, message: string): Promise<CampaignLive> {
  let live = await liveOrUnavailable(record, log);
  if (STATUS_ORDER.indexOf(live.status) < STATUS_ORDER.indexOf(status)) live = await liveOrUnavailable(record, log, { fresh: true });
  if (live.status !== status) throw new HttpError(message, 409);
  return live;
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
