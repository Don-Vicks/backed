import { devnetFaucet, getNetwork } from "@preorder/core";
import { BadRequest, connection, errorResponse, publicKey } from "@/lib/server";

export async function POST(req: Request) {
  try {
    if (getNetwork().name !== "devnet") throw new BadRequest("The faucet only runs on devnet");
    const { wallet } = (await req.json()) as { wallet: string };
    const signature = await devnetFaucet(connection(), publicKey(wallet));
    return Response.json({ signature });
  } catch (e) {
    return errorResponse(e);
  }
}
