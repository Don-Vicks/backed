// Runs once when the server starts. Checks SHIPPING_KEY and starts the pending-campaign reconcile job
// on the Node.js runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getNetwork, shippingKeyStatus } = await import("@preorder/core");
  const key = shippingKeyStatus();
  if (!key.ok) console.error(JSON.stringify({ event: "config", shippingKey: key }));
  // On mainnet a redemption burns the voucher before the order is stored: refuse to serve without a usable key.
  if (!key.usable && getNetwork().name === "mainnet") throw new Error(`Refusing to start: ${key.error}`);
  const { startReconcileJob } = await import("./lib/reconcile-job");
  startReconcileJob();
}
