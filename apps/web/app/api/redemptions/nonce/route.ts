import { getCampaign, HttpError, issueSignInNonce, schemas } from "@preorder/core";
import { errorResponse, rateLimit, readJson, requestLog } from "@/lib/server";

// Step 1 of the maker's sign-in: a single-use nonce for one campaign, to put in the message the wallet
// signs. Anyone can ask (the maker's wallet is only known from the signature), so it is rate limited.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/nonce");
  try {
    rateLimit(req, "signin");
    const { pool } = await readJson(req, schemas.ordersNonce);
    if (!getCampaign(pool.toBase58())) throw new HttpError("Campaign not found", 404);
    return Response.json(issueSignInNonce(pool.toBase58()));
  } catch (e) {
    return errorResponse(e, log);
  }
}
