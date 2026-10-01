import { getConnection, reconcilePending } from "@preorder/core";

// Every RECONCILE_INTERVAL_SEC (default 600, 0 = off): list pending campaigns whose pool landed even
// though the browser never confirmed, and expire builds that never landed. Well inside the 24h pending TTL.
export function startReconcileJob() {
  const intervalSec = Number(process.env.RECONCILE_INTERVAL_SEC || 600);
  if (!(intervalSec > 0) || process.env.NEXT_PHASE === "phase-production-build") return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await reconcilePending(getConnection());
      if (result.listed.length || result.expired.length || result.failed.length) {
        console.log(JSON.stringify({ event: "reconcile", listed: result.listed, expired: result.expired, failed: result.failed }));
      }
    } catch (e) {
      console.error(JSON.stringify({ event: "reconcile", error: e instanceof Error ? e.message : String(e) }));
    } finally {
      running = false;
    }
  };
  setTimeout(run, 30_000).unref();
  setInterval(run, intervalSec * 1000).unref();
}
