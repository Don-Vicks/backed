import { dbcClient, saveCampaign, takePending } from "@preorder/core";
import { BadRequest, connection, errorResponse } from "@/lib/server";

// Called after the maker's wallet sent the create transaction: verifies the pool exists, then lists it.
export async function POST(req: Request) {
  try {
    const { pool, signature } = (await req.json()) as { pool: string; signature: string };
    const conn = connection();
    const status = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
    if (status.value?.err) throw new BadRequest("The create transaction failed on-chain");
    const onChain = await dbcClient(conn).state.getPool(pool);
    if (!onChain) throw new BadRequest("Pool not found on-chain yet; try again in a few seconds");
    const record = takePending(pool);
    if (!record) throw new BadRequest("Unknown campaign");
    saveCampaign({ ...record, createSignature: signature });
    return Response.json({ ok: true, pool });
  } catch (e) {
    return errorResponse(e);
  }
}
