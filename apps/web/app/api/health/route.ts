import { checkShippingKey, getNetwork, priorityFeeMax, trustedProxyHops } from "@preorder/core";

// Liveness for the platform healthcheck: no RPC call, so a slow RPC never blocks a deploy.
// Fails when the server's NETWORK differs from the one baked into the browser bundle at build time, or
// when PRIORITY_FEE_MAX_MICROLAMPORTS or TRUSTED_PROXY_HOPS is invalid (every wallet transaction, or every
// rate-limited request, would fail at request time), or SHIPPING_ENCRYPTION_KEY is invalid or, on
// mainnet, missing (no redemption could be stored).
export function GET() {
  try {
    const network = getNetwork().name;
    priorityFeeMax();
    trustedProxyHops();
    checkShippingKey();
    const built = process.env.NEXT_PUBLIC_NETWORK;
    if (built !== network) {
      return Response.json({ ok: false, network, error: `built for ${built}, running on ${network}: rebuild` }, { status: 503 });
    }
    return Response.json({ ok: true, network });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 503 });
  }
}
