import {
  clientIp,
  countFaucetClaims,
  devnetFaucet,
  FAUCET_LIMITS,
  getNetwork,
  HttpError,
  isTestNetwork,
  recordFaucetClaim,
  removeFaucetClaim,
  schemas,
  TxNotExecutedError,
} from "@preorder/core";
import { BadRequest, connection, errorResponse, logLine, rateLimit, rateLimitsOff, readJson, requestLog } from "@/lib/server";

// Wallets with a faucet transfer on its way: a double click must not pay twice.
const inFlight = new Set<string>();

// Throws a 429 when this wallet, this IP or everyone together has had the day's share; otherwise records
// the claim right away. Synchronous (the store is), so concurrent requests can't all pass the counts
// before any of them is recorded. Returns the claim's time, to take it back if the transfer never ran.
function reserveClaim(wallet: string, ip: string | null): number {
  const now = Date.now();
  if (!rateLimitsOff()) checkLimits(wallet, ip, now - FAUCET_LIMITS.windowMs);
  recordFaucetClaim(wallet, ip, now);
  return now;
}

function checkLimits(wallet: string, ip: string | null, since: number) {
  if (countFaucetClaims(since, { wallet }) >= FAUCET_LIMITS.perWallet) {
    throw new HttpError("This wallet already got test USDC in the last 24 hours. Try again tomorrow.", 429);
  }
  if (ip && countFaucetClaims(since, { ip }) >= FAUCET_LIMITS.perIp) {
    throw new HttpError("The faucet limit for your network is reached for today. Try again tomorrow.", 429);
  }
  if (countFaucetClaims(since) >= FAUCET_LIMITS.total) throw new HttpError("The faucet is out for today. Try again tomorrow.", 429);
}

// Devnet/localnet only: 50 test USDC and a little SOL, paid by the platform key, so it is capped.
export async function POST(req: Request) {
  const log = requestLog("POST /api/faucet");
  try {
    if (!isTestNetwork(getNetwork().name)) throw new BadRequest("The faucet only runs on devnet and localnet");
    rateLimit(req, "faucet");
    const { wallet } = await readJson(req, schemas.faucet);
    const key = wallet.toBase58();
    log.wallet = key;
    const ip = clientIp(req.headers);
    if (inFlight.has(key)) throw new HttpError("Test USDC for this wallet is already on its way", 409);
    const claimedAt = reserveClaim(key, ip === "unknown" ? null : ip);
    inFlight.add(key);
    let signature: string;
    try {
      signature = await devnetFaucet(connection(), wallet);
    } catch (e) {
      // Only a transfer that provably did not run gives the claim back; a timeout may still land.
      if (e instanceof TxNotExecutedError) removeFaucetClaim(key, claimedAt);
      throw e;
    } finally {
      inFlight.delete(key);
    }
    logLine("info", { reqId: log.reqId, route: log.route, wallet: key, sig: signature, event: "faucet" });
    return Response.json({ signature });
  } catch (e) {
    return errorResponse(e, log);
  }
}
