import { backupStore, sendAlert } from "@preorder/core";

// Every BACKUP_INTERVAL_SEC (default 3600, 0 = off): a consistent copy of the store into DATA_DIR/backups,
// keeping the newest BACKUP_KEEP (default 24). A failed backup is logged and alerted (ALERT_WEBHOOK_URL).
export function startBackupJob() {
  const intervalSec = Number(process.env.BACKUP_INTERVAL_SEC ?? 3600);
  if (!(intervalSec > 0) || process.env.NEXT_PHASE === "phase-production-build") return;
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    try {
      const { backup, removed } = backupStore();
      console.log(JSON.stringify({ event: "backup", file: backup.file, bytes: backup.bytes, removed: removed.length }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ event: "backup", error }));
      void sendAlert("backup-failed", `Store backup failed: ${error}`);
    } finally {
      running = false;
    }
  };
  setTimeout(run, 60_000).unref();
  setInterval(run, intervalSec * 1000).unref();
}
