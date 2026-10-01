#!/usr/bin/env bash
# Browser e2e on localnet: seeds fresh wallets and a mock USDC on the running validator
# (scripts/localnet/start.sh), builds and starts the app against them, and runs the Playwright suite.
#   bash scripts/localnet/start.sh && bash apps/web/e2e/run-localnet.sh [playwright args]
set -euo pipefail

REPO=$(cd "$(dirname "$0")/../../.." && pwd)
PORT=${E2E_PORT:-3301}
export PREORDER_ROOT=${PREORDER_ROOT:-$(mktemp -d)}

pnpm -C "$REPO" core:seed:localnet
set -a
# shellcheck disable=SC1091
. "$PREORDER_ROOT/.env.localnet"
set +a

# Tier A for the seeded maker (localnet only) and a vesting schedule in seconds, so the unlock fits.
MAKER=$(node -e "const k=require('$PREORDER_ROOT/keys/localnet/maker.json');const {Keypair}=require(require.resolve('@solana/web3.js',{paths:['$REPO/packages/core']}));console.log(Keypair.fromSecretKey(Uint8Array.from(k)).publicKey.toBase58())")
export TRUST_FIXTURES="{\"$MAKER\": {\"walletAgeDays\": 800, \"txCount\": 900, \"fundedByFreshWallet\": false}}"
export VESTING_SCHEDULE_OVERRIDE='{"cliffSec": 30, "periods": 2, "periodSec": 20, "bpsPerPeriod": 2500}'
export RATE_LIMITS=off

# A server already on the port would answer the health check with another build.
if curl -sf "http://localhost:$PORT/api/health" > /dev/null; then
  echo "Something already serves http://localhost:$PORT: stop it or set E2E_PORT." >&2
  exit 1
fi

pnpm -C "$REPO" build
# Its own process group, so the exit trap stops next-server too, not only pnpm.
setsid env PORT="$PORT" pnpm -C "$REPO" start > "$PREORDER_ROOT/server.log" 2>&1 &
SERVER=$!
trap 'kill -- -$SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$PORT/api/health" > /dev/null && break
  sleep 1
done
curl -sf "http://localhost:$PORT/api/health" > /dev/null || { echo "app did not start:"; tail -n 50 "$PREORDER_ROOT/server.log"; exit 1; }

E2E_BASE_URL="http://localhost:$PORT" pnpm -C "$REPO/apps/web" exec playwright test "$@"
