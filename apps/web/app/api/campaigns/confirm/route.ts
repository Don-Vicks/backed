import { ListingError, confirmListing } from "@preorder/core";
import { connection, errorResponse, publicKey } from "@/lib/server";

// Called after the maker's wallet sent the create transaction. Idempotent: a listed campaign returns ok.
// Waits up to ~15s for the pool on the server's RPC, checks the create transaction (the client's
// signature, else the pool's first transaction), then lists it. 409 + retry means "try again shortly".
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { pool: string; signature?: string };
    const pool = publicKey(body.pool, "pool").toBase58();
    const signature = typeof body.signature === "string" && body.signature ? body.signature : undefined;
    const { alreadyListed } = await confirmListing(connection(), pool, signature);
    return Response.json({ ok: true, pool, alreadyListed });
  } catch (e) {
    if (e instanceof ListingError) return Response.json({ error: e.message, retry: e.retry }, { status: e.status });
    return errorResponse(e);
  }
}
