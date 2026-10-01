#!/usr/bin/env bash
# Starts a solana-test-validator with the mainnet DBC, DAMM v2, Metaplex and Locker programs and every
# DAMM v2 migration config, or reuses the validator already answering on the RPC port. Either way it
# checks the validator has every one of them. It never resets a ledger: a running validator is left
# alone (other suites share it), and a stopped one resumes its ledger. Then it airdrops 5 SOL to the
# DBC pool authority, which pays rent on migration.
#
#   bash scripts/localnet/start.sh            # :8899, ledger in .localnet/ (gitignored)
#   LOCALNET_RPC_PORT=18899 LOCALNET_LEDGER=$(mktemp -d)/ledger bash scripts/localnet/start.sh
#
# Env:
#   LOCALNET_RPC_PORT   RPC port (websocket = port + 1). Off 8899 the faucet, gossip and dynamic ports
#                       move next to it, so a second validator can run beside the shared one.
#   LOCALNET_LEDGER     ledger directory (default .localnet/ledger-<port>)
#   LOCALNET_DUMPS      directory written by dump.sh: load programs and accounts from it instead of
#                       cloning over RPC (CI caches it)
#   LOCALNET_CLONE_URL  cluster to clone from (default mainnet-beta)
#   SOLANA_BIN          directory holding solana-test-validator, if it is not on PATH
#
# Prints LOCALNET_RPC_URL=<url> on success. Stop a validator it started with stop.sh.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DEPS=$(mainnet_deps) || die "could not read the program list from the DBC SDK (error above)"
POOL_AUTHORITY=$(awk '$1 == "pool-authority" { print $2 }' <<<"$DEPS")

if healthy; then
  log "reusing the validator at $RPC_URL (not reset)"
else
  command -v solana-test-validator >/dev/null || die "solana-test-validator not found (set SOLANA_BIN or PATH)"
  if (exec 3<>"/dev/tcp/127.0.0.1/$RPC_PORT") 2>/dev/null; then
    die "port $RPC_PORT is taken but does not answer getHealth; pick another LOCALNET_RPC_PORT"
  fi
  args=(--ledger "$LEDGER" --rpc-port "$RPC_PORT" --quiet)
  if [ "$RPC_PORT" != 8899 ]; then
    args+=(--faucet-port $((RPC_PORT + 2)) --gossip-port $((RPC_PORT + 3)) --dynamic-port-range "$((RPC_PORT + 10))-$((RPC_PORT + 60))")
  fi
  # Ignored by the validator when the ledger already exists (it resumes with what it cloned then).
  if [ -n "${LOCALNET_DUMPS:-}" ]; then
    while read -r kind id; do
      case $kind in
        program) args+=(--upgradeable-program "$id" "$LOCALNET_DUMPS/programs/$id.so" none) ;;
        account) args+=(--account "$id" "$LOCALNET_DUMPS/accounts/$id.json") ;;
      esac
    done <<<"$DEPS"
  else
    args+=(--url "$CLONE_URL")
    while read -r kind id; do
      case $kind in
        program) args+=(--clone-upgradeable-program "$id") ;;
        account) args+=(--clone "$id") ;;
      esac
    done <<<"$DEPS"
  fi
  if [ -f "$LEDGER/genesis.bin" ]; then log "resuming the ledger at $LEDGER"; else log "new ledger at $LEDGER"; fi
  mkdir -p "$LEDGER"
  setsid nohup solana-test-validator "${args[@]}" >"$LEDGER/start.log" 2>&1 </dev/null &
  echo $! >"$LEDGER/start.pid"
  for _ in $(seq 1 120); do
    healthy && break
    kill -0 "$(cat "$LEDGER/start.pid")" 2>/dev/null || { tail -20 "$LEDGER/start.log" "$LEDGER/validator.log" >&2 2>/dev/null; die "validator exited"; }
    sleep 1
  done
  healthy || { tail -20 "$LEDGER/start.log" "$LEDGER/validator.log" >&2 2>/dev/null; die "validator did not become healthy in 120s"; }
  log "started at $RPC_URL (pid $(cat "$LEDGER/start.pid"), log $LEDGER/start.log)"
fi

# A reused validator may have been started without some of them: say so now, not as a program error
# halfway through a suite.
missing=()
while read -r kind id; do
  case $kind in
    program) executable "$id" || missing+=("program $id") ;;
    account) exists "$id" || missing+=("account $id") ;;
  esac
done <<<"$DEPS"
if [ ${#missing[@]} -gt 0 ]; then
  printf '[localnet]   missing %s\n' "${missing[@]}" >&2
  die "the validator at $RPC_URL lacks ${#missing[@]} of the mainnet programs and configs; start one with this script on another LOCALNET_RPC_PORT"
fi

before=$(balance "$POOL_AUTHORITY"); before=${before:-0}; now=$before
# An airdrop repeated within one blockhash has the same signature and is dropped, so retry.
for _ in 1 2 3; do
  rpc requestAirdrop "[\"$POOL_AUTHORITY\",5000000000]" | grep -q '"result"' || die "airdrop to $POOL_AUTHORITY failed"
  for _ in $(seq 1 10); do
    now=$(balance "$POOL_AUTHORITY")
    [ "${now:-0}" -gt "$before" ] && break 2
    sleep 1
  done
done
[ "${now:-0}" -gt "$before" ] || die "airdrop to the DBC pool authority did not land"
log "DBC pool authority $POOL_AUTHORITY holds $((now / 1000000000)) SOL"

echo "LOCALNET_RPC_URL=$RPC_URL"
