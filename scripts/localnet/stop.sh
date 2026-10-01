#!/usr/bin/env bash
# Stops the validator that start.sh started for this LOCALNET_RPC_PORT / LOCALNET_LEDGER (its pid file),
# and nothing else: a validator someone else started, such as a shared one on :8899, is never touched.
# The ledger stays; pass --rm to delete it as well.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

pidfile="$LEDGER/start.pid"
[ -f "$pidfile" ] || { log "no validator started by start.sh for $LEDGER"; exit 0; }
pid=$(cat "$pidfile")
if kill -0 "$pid" 2>/dev/null && grep -qa "solana-test-validator" "/proc/$pid/cmdline" && grep -qaF -- "$LEDGER" "/proc/$pid/cmdline"; then
  kill "$pid"
  for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  log "stopped pid $pid ($RPC_URL)"
else
  log "pid $pid is not this ledger's validator any more"
fi
rm -f "$pidfile"
if [ "${1:-}" = --rm ]; then rm -rf "$LEDGER"; log "removed $LEDGER"; fi
