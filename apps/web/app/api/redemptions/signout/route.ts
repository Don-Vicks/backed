import { bearerToken, endMakerSession } from "@preorder/core";
import { errorResponse, requestLog } from "@/lib/server";

// Ends the maker's session now (the token stops working), rather than at its expiry.
export async function POST(req: Request) {
  const log = requestLog("POST /api/redemptions/signout");
  try {
    const token = bearerToken(req.headers.get("authorization"));
    if (token) endMakerSession(token);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e, log);
  }
}
