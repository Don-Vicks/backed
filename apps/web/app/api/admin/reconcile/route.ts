import { reconcilePending } from "@preorder/core";
import { isAdmin, unauthorized } from "@/lib/admin";
import { connection, errorResponse } from "@/lib/server";

// Lists pending campaigns whose pool landed on-chain and expires the ones that never will.
// Same job as `pnpm core:reconcile` and the server's background run.
export async function POST(req: Request) {
  if (!isAdmin(req)) return unauthorized();
  try {
    return Response.json(await reconcilePending(connection()));
  } catch (e) {
    return errorResponse(e);
  }
}
