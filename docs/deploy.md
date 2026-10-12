> Deploying to Railway.

[← Back to the README](../README.md)

# Deploy (Railway)

`railway.json` builds from the repo root with Railpack (`pnpm build`), starts with `pnpm start` (Next reads `PORT`) and health-checks `/api/health`, a liveness route that makes no RPC call. Railpack takes the Node version from `engines.node` (`22.22.x`). Set `NETWORK`, the RPC URLs, `PUBLIC_RPC_URL`, `PUBLIC_BASE_URL`, `PLATFORM_SECRET_KEY`, `PLATFORM_FEE_CLAIMER` and (off mainnet) `USDC_MINT` as service variables before the first build, and keep the service root at the repo root so the workspace resolves. Attach a volume at `/app/data`, set `DATA_DIR=/app/data` and turn on daily backups: token metadata sits behind immutable on-chain URIs, so losing the store breaks it for good. Also set `SHIPPING_KEY` and `ADMIN_TOKEN`. One replica only (SQLite on a single volume).

A devnet demo can skip pasting secrets: mount the volume at `/data`, set `PREORDER_ROOT=/data` (store in `/data/data`, keys in `/data/keys/devnet`) and `TEST_KEYS_AUTOGEN=1`. The server then generates its own platform key and `SHIPPING_KEY` on the volume on first use and logs the platform pubkey; fund that address with devnet SOL and hand it the mock USDC mint authority (`spl-token authorize <USDC_MINT> mint <pubkey>`). `TEST_KEYS_AUTOGEN` is ignored on mainnet.

## Backups and alerts

The server writes a consistent copy of the store (`VACUUM INTO`, no downtime) into `DATA_DIR/backups` every `BACKUP_INTERVAL_SEC` (default 3600) and keeps the newest `BACKUP_KEEP` (default 24). `/api/status` reports `store.backupAgeSec`. `pnpm core:backup` writes one by hand and `pnpm core:backup restore <file>` restores one (stop the server first; the old file is kept as `.before-restore`).

These copies sit on the same volume as the database. They cover a bad write or a deleted row, **not the loss of the volume**, so also copy `DATA_DIR/backups` off the machine (Railway volume backups, or a scheduled `rclone`/`aws s3 sync` of that folder). Shipping details inside a backup are still sealed, so a copy is no more readable than the database; keep `SHIPPING_KEY` somewhere else.

Set `ALERT_WEBHOOK_URL` to a Slack or Discord incoming webhook (https) and the server posts a message when a backup fails or an API route answers with a 5xx, at most one per route every 5 minutes. Pair it with an uptime monitor on `/api/status`, which also reports a low platform balance and an unreachable RPC.

