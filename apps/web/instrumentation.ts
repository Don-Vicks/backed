// Runs once when the server starts. Checks SHIPPING_KEY, opens the store and starts the pending-campaign
// reconcile job on the Node.js runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { db, getNetwork, shippingKeyStatus } = await import("@preorder/core");
  const key = shippingKeyStatus();
  if (!key.ok) console.error(JSON.stringify({ event: "config", shippingKey: key }));
  // On mainnet a redemption burns the voucher before the order is stored: refuse to serve without a usable key.
  if (!key.usable && getNetwork().name === "mainnet") throw new Error(`Refusing to start: ${key.error}`);
  // Open the store now, so migrations and any legacy JSON import run at boot rather than on the first
  // request. A failure is logged and retried by that request (/api/status reports it).
  try {
    if (process.env.NEXT_PHASE !== "phase-production-build") db();
  } catch (e) {
    console.error(JSON.stringify({ event: "store", error: e instanceof Error ? e.message : String(e) }));
  }
  const { startReconcileJob } = await import("./lib/reconcile-job");
  startReconcileJob();
}
