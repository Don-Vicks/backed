import { getCampaign, listRedemptions, verifyWalletMessage } from "@preorder/core";
import { BadRequest, errorResponse, publicKey } from "@/lib/server";

// Maker-only: the maker's wallet signs a time-stamped message to see shipping details.
export async function POST(req: Request) {
  try {
    const { pool, message, signature } = (await req.json()) as { pool: string; message: string; signature: string };
    const record = getCampaign(pool);
    if (!record) throw new BadRequest("Unknown campaign");
    if (!message.includes(pool)) throw new BadRequest("Message is for a different campaign");
    try {
      verifyWalletMessage(message, signature, publicKey(record.maker));
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : "Not authorized" }, { status: 403 });
    }
    return Response.json({ redemptions: listRedemptions(pool) });
  } catch (e) {
    return errorResponse(e);
  }
}
