import { PublicKey } from "@solana/web3.js";
import { getCampaign, quoteBuyUnits, quoteTopUp, UnitsError } from "@preorder/core";
import { BadRequest, connection, errorResponse, publicKey } from "@/lib/server";

// Quote for backing whole units: { pool, units } or, to top a fractional balance up, { pool, wallet, topUp: true }.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { pool?: string; units?: number; wallet?: string; topUp?: boolean; slippageBps?: number };
    const record = getCampaign(String(body.pool));
    if (!record) throw new BadRequest("Unknown campaign");
    const opts = { slippageBps: body.slippageBps };
    const quote = body.topUp
      ? await quoteTopUp(connection(), record.pool, publicKey(body.wallet), new PublicKey(record.baseMint), opts)
      : await quoteBuyUnits(connection(), record.pool, body.units as number, opts);
    return Response.json(quote);
  } catch (e) {
    if (e instanceof UnitsError) return Response.json({ error: e.message }, { status: e.status });
    return errorResponse(e);
  }
}
