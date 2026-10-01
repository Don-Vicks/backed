import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getNetwork, hasShippingKey, isTestNetwork, loadKeypair, storeHealth } from "@preorder/core";
import { connection } from "@/lib/server";

// Deep check for operators and uptime monitors: store writable, RPC reachable and fast, platform key
// funded, config complete. Not the deploy healthcheck (/api/health), so a slow RPC never blocks a deploy.
export const dynamic = "force-dynamic";

const MIN_PLATFORM_SOL = Number(process.env.STATUS_MIN_PLATFORM_SOL || 0.5);

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);

export async function GET() {
  const network = getNetwork().name;
  const testNet = isTestNetwork(network);
  const store = {
    ...storeHealth(),
    // Without DATA_DIR the store sits on the container disk, which a redeploy wipes.
    durable: !!process.env.DATA_DIR?.trim() || network === "localnet",
  };
  const shippingKey = { ok: hasShippingKey() || testNet, configured: hasShippingKey() };

  const conn = connection();
  const rpc: { ok: boolean; slot?: number; latencyMs?: number; error?: string } = { ok: false };
  const started = Date.now();
  try {
    rpc.slot = await withTimeout(conn.getSlot("confirmed"), 5000);
    rpc.latencyMs = Date.now() - started;
    rpc.ok = rpc.latencyMs < 2000;
  } catch (e) {
    rpc.error = e instanceof Error ? e.message : String(e);
  }

  const platform: { ok: boolean; address?: string; sol?: number; minSol: number; error?: string } = { ok: false, minSol: MIN_PLATFORM_SOL };
  let platformKey: PublicKey | null = null;
  try {
    platformKey = loadKeypair("platform").publicKey;
    platform.address = platformKey.toBase58();
  } catch {
    platform.error = "platform key not configured";
  }
  if (platformKey && rpc.slot !== undefined) {
    try {
      platform.sol = (await withTimeout(conn.getBalance(platformKey, "confirmed"), 5000)) / LAMPORTS_PER_SOL;
      platform.ok = platform.sol >= MIN_PLATFORM_SOL;
    } catch (e) {
      platform.error = e instanceof Error ? e.message : String(e);
    }
  }

  const ok = store.ok && store.durable && shippingKey.ok && rpc.ok && platform.ok;
  return Response.json(
    { ok, network, checkedAt: new Date().toISOString(), store, shippingKey, rpc, platform },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
