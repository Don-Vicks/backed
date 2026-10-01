import { clientIp, countFaucetClaims, devnetFaucet, FAUCET_LIMITS, getNetwork, HttpError, isTestNetwork, recordFaucetClaim, schemas } from "@preorder/core";
import { BadRequest, connection, errorResponse, logLine, rateLimit, rateLimitsOff, readJson, requestLog } from "@/lib/server";

// Wallets with a faucet transfer on its way: a double click must not pay twice.
const inFlight = new Set<string>();

// Throws a 429 when this wallet, this IP or everyone together has had the day's share.
function checkLimits(wallet: string, ip: string | null) {
  if (rateLimitsOff()) return;
  const since = Date.now() - FAUCET_LIMITS.windowMs;
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
    checkLimits(key, ip === "unknown" ? null : ip);
    if (inFlight.has(key)) throw new HttpError("Test USDC for this wallet is already on its way", 409);
    inFlight.add(key);
    let signature: string;
    try {
      signature = await devnetFaucet(connection(), wallet);
    } finally {
      inFlight.delete(key);
    }
    recordFaucetClaim(key, ip === "unknown" ? null : ip);
    logLine("info", { reqId: log.reqId, route: log.route, wallet: key, sig: signature, event: "faucet" });
    return Response.json({ signature });
  } catch (e) {
    return errorResponse(e, log);
  }
}
