import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { backupAgeSec, getNetwork, legacyPlaintextFiles, loadKeypair, shippingKeyStatus, storeDurability, storeHealth } from "@preorder/core";
import { connection } from "@/lib/server";

// Deep check for operators and uptime monitors: store writable, RPC reachable and fast, platform key
// funded, config complete. Not the deploy healthcheck (/api/health), so a slow RPC never blocks a deploy.
// Unauthenticated, so the result is cached for CACHE_MS: hammering it costs no writes or RPC calls.
export const dynamic = "force-dynamic";

const CACHE_MS = 15_000;
const minSol = Number(process.env.STATUS_MIN_PLATFORM_SOL || 0.1);
const MIN_PLATFORM_SOL = Number.isFinite(minSol) && minSol >= 0 ? minSol : 0.1;

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);

let cached: { at: number; body: Record<string, unknown> & { ok: boolean } } | null = null;

async function check() {
  const network = getNetwork().name;
  // Opens the store first: the first open imports (and shreds) a legacy redemptions file.
  const health = storeHealth();
  const plaintextFiles = legacyPlaintextFiles();
  const store = {
    ...health,
    // Off a volume the store sits on the container disk, which a redeploy wipes.
    ...storeDurability(),
    // Seconds since the newest backup in DATA_DIR/backups (null: none yet).
    backupAgeSec: backupAgeSec(),
    // Legacy redemptions JSON (plaintext shipping details) still on disk: delete it once checked.
    ...(plaintextFiles.length ? { plaintextFiles } : {}),
  };
  const shippingKey = shippingKeyStatus();

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

  const ok = store.ok && store.durable && !plaintextFiles.length && shippingKey.ok && rpc.ok && platform.ok;
  return { ok, network, checkedAt: new Date().toISOString(), store, shippingKey, rpc, platform };
}

export async function GET() {
  if (!cached || Date.now() - cached.at > CACHE_MS) cached = { at: Date.now(), body: await check() };
  return Response.json(cached.body, { status: cached.body.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
