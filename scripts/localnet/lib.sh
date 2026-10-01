# Shared by start.sh, stop.sh and dump.sh. Sourced, not run.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RPC_PORT=${LOCALNET_RPC_PORT:-8899}
RPC_URL="http://127.0.0.1:$RPC_PORT"
LEDGER=${LOCALNET_LEDGER:-$ROOT/.localnet/ledger-$RPC_PORT}
CLONE_URL=${LOCALNET_CLONE_URL:-https://api.mainnet-beta.solana.com}
[ -n "${SOLANA_BIN:-}" ] && PATH="$SOLANA_BIN:$PATH"

log() { echo "[localnet] $*" >&2; }
die() { log "error: $*"; exit 1; }

rpc() { # rpc <method> [json params]
  curl -sS -m 5 "$RPC_URL" -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}" 2>/dev/null
}
healthy() { rpc getHealth | grep -q '"result":"ok"'; }
balance() { rpc getBalance "[\"$1\",{\"commitment\":\"confirmed\"}]" | sed -n 's/.*"value":\([0-9]*\).*/\1/p'; }
account_info() { rpc getAccountInfo "[\"$1\",{\"encoding\":\"base64\",\"dataSlice\":{\"offset\":0,\"length\":0}}]"; }
executable() { account_info "$1" | grep -q '"executable":true'; }
exists() { account_info "$1" | grep -q '"value":{'; }

# Programs, migration configs and the DBC pool authority, read from the DBC SDK (packages/core/src/localnet.ts).
# Lines: `program <id>`, `account <address>`, `pool-authority <address>`. Errors go to stderr as they are.
mainnet_deps() {
  [ -d "$ROOT/packages/core/node_modules/@meteora-ag" ] || die "run pnpm install first"
  (cd "$ROOT/packages/core" && node -r ts-node/register/transpile-only src/scripts/localnet-accounts.ts)
}
