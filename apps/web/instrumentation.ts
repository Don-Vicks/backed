// Runs once when the server starts. Starts the pending-campaign reconcile job on the Node.js runtime.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startReconcileJob } = await import("./lib/reconcile-job");
  startReconcileJob();
}
