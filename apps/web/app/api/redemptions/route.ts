import { getCampaign, saveRedemption, verifyBurn, type Shipping } from "@preorder/core";
import { BadRequest, connection, errorResponse, publicKey } from "@/lib/server";

// A backer submits shipping details for a burn they already made on-chain.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { pool: string; signature: string; wallet: string; shipping: Shipping };
    const record = getCampaign(body.pool);
    if (!record) throw new BadRequest("Unknown campaign");
    const wallet = publicKey(body.wallet);
    const s = body.shipping ?? ({} as Shipping);
    const clean = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
    const shipping: Shipping = { name: clean(s.name, 100), email: clean(s.email, 200), address: clean(s.address, 500), country: clean(s.country, 60) };
    if (!shipping.name || !shipping.address || !shipping.country) throw new BadRequest("Name, address and country are required");
    if (shipping.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shipping.email)) throw new BadRequest("Enter a valid email");
    let units: number;
    try {
      units = await verifyBurn(connection(), record, body.signature, wallet);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    try {
      saveRedemption({ pool: record.pool, signature: body.signature, wallet: wallet.toBase58(), units, shipping, createdAt: new Date().toISOString() });
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    return Response.json({ ok: true, units });
  } catch (e) {
    return errorResponse(e);
  }
}
