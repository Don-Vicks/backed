> Deploying to Railway.

[← Back to the README](../README.md)

# Deploy (Railway)

`railway.json` builds from the repo root with Railpack (`pnpm build`), starts with `pnpm start` (Next reads `PORT`) and health-checks `/api/health`, a liveness route that makes no RPC call. Railpack takes the Node version from `engines.node` (`22.22.x`). Set `NETWORK`, the RPC URLs, `PUBLIC_RPC_URL`, `PUBLIC_BASE_URL`, `PLATFORM_SECRET_KEY`, `PLATFORM_FEE_CLAIMER` and (off mainnet) `USDC_MINT` as service variables before the first build, and keep the service root at the repo root so the workspace resolves. Attach a volume at `/app/data`, set `DATA_DIR=/app/data` and turn on daily backups: token metadata sits behind immutable on-chain URIs, so losing the store breaks it for good. Also set `SHIPPING_KEY` and `ADMIN_TOKEN`. One replica only (SQLite on a single volume).

A devnet demo can skip pasting secrets: mount the volume at `/data`, set `PREORDER_ROOT=/data` (store in `/data/data`, keys in `/data/keys/devnet`) and `TEST_KEYS_AUTOGEN=1`. The server then generates its own platform key and `SHIPPING_KEY` on the volume on first use and logs the platform pubkey; fund that address with devnet SOL and hand it the mock USDC mint authority (`spl-token authorize <USDC_MINT> mint <pubkey>`). `TEST_KEYS_AUTOGEN` is ignored on mainnet.
