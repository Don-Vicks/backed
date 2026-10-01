import { PublicKey } from "@solana/web3.js";
import { getCampaign, HttpError, quoteBuyUnits, quoteTopUp, schemas } from "@preorder/core";
import { BadRequest, connection, errorResponse, liveOrUnavailable, rateLimit, readJson, requestLog } from "@/lib/server";

// Quote for backing whole units: { pool, units } or, to top a fractional balance up, { pool, wallet, topUp: true }.
// Only for listed campaigns that are still funding: 404 for any other address, 409 once the goal is reached.
export async function POST(req: Request) {
  const log = requestLog("POST /api/quote/units");
  try {
    rateLimit(req, "quote");
    const body = await readJson(req, schemas.quoteUnits);
    const record = getCampaign(body.pool.toBase58());
    if (!record) throw new HttpError("Campaign not found", 404);
    if ((await liveOrUnavailable(record, log)).status !== "funding") throw new HttpError("This campaign has reached its goal", 409);
    const opts = { slippageBps: body.slippageBps };
    if (body.topUp) {
      if (!body.wallet) throw new BadRequest("wallet is missing");
      log.wallet = body.wallet.toBase58();
      return Response.json(await quoteTopUp(connection(), record.pool, body.wallet, new PublicKey(record.baseMint), opts));
    }
    return Response.json(await quoteBuyUnits(connection(), record.pool, body.units as number, opts));
  } catch (e) {
    return errorResponse(e, log);
  }
}
