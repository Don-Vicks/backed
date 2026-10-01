#!/usr/bin/env bash
# Dumps the mainnet programs and accounts start.sh needs into a directory, so a validator can be
# started from files (LOCALNET_DUMPS=<dir>) without cloning over a public RPC every time. CI caches it.
#
#   bash scripts/localnet/dump.sh <dir>       # <dir>/programs/<id>.so, <dir>/accounts/<address>.json
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

out=${1:?usage: dump.sh <dir>}
command -v solana >/dev/null || die "solana CLI not found (set SOLANA_BIN or PATH)"
deps=$(mainnet_deps) || die "could not read the program list from the DBC SDK (error above)"
mkdir -p "$out/programs" "$out/accounts"

retry() { for i in 1 2 3 4 5; do "$@" >/dev/null && return 0; log "retry $i: $*"; sleep $((i * 3)); done; return 1; }

while read -r kind id; do
  case $kind in
    program)
      [ -s "$out/programs/$id.so" ] || retry solana program dump --url "$CLONE_URL" "$id" "$out/programs/$id.so" || die "dump $id"
      ;;
    account)
      [ -s "$out/accounts/$id.json" ] || retry solana account --url "$CLONE_URL" "$id" --output json --output-file "$out/accounts/$id.json" || die "dump $id"
      ;;
  esac
done <<<"$deps"
log "dumped to $out: $(ls "$out/programs" | wc -l) programs, $(ls "$out/accounts" | wc -l) accounts"
