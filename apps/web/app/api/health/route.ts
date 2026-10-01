import { getNetwork, shippingKeyStatus } from "@preorder/core";

// Liveness for the platform healthcheck: no RPC call, so a slow RPC never blocks a deploy.
// Fails when the server's NETWORK differs from the one baked into the browser bundle at build time,
// and when SHIPPING_KEY is malformed or missing on mainnet: redemptions would burn vouchers and then
// fail to store the order.
export function GET() {
  try {
    const network = getNetwork().name;
    const built = process.env.NEXT_PUBLIC_NETWORK;
    if (built !== network) {
      return Response.json({ ok: false, network, error: `built for ${built}, running on ${network}: rebuild` }, { status: 503 });
    }
    const key = shippingKeyStatus();
    if (!key.usable) return Response.json({ ok: false, network, error: key.error }, { status: 503 });
    return Response.json({ ok: true, network });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
