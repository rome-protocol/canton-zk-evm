#!/usr/bin/env bash
# Opt-in: runs the wallet signature harness in the pinned browser image. It downloads third-party browser extensions and opens a live site, so it is in no CI job: run it by hand, on a machine you can throw away.
# Usage: tests/wallets/run.sh [--update] [--no-live] [--debug] [wallet ...]
#   wallet ...  only these wallets (their rows change, the others keep theirs); the live check runs only when no wallet is named
#   --update   accept a newer package than the SHA-256 pinned in wallets.json (and record it)
#   --no-live  skip the check against the live DevNet Bridge (it uses the faucet once); it is also skipped when wallets are named
#   --debug    print what each wallet's screens show (never a typed value)
# The run folder (tests/wallets/run) holds the throwaway seed and the wallets' profiles; it is deleted by `rm -rf tests/wallets/run` when you are done, and is never committed.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
IMAGE=$(grep '^EXPLORER_BROWSER_IMAGE=' "$ROOT/PINS" | cut -d= -f2-)
[ -n "$IMAGE" ] || { echo "PINS has no EXPLORER_BROWSER_IMAGE" >&2; exit 1; }

UPDATE="" LIVE=1 DEBUG_FLAG=0 WALLETS=()
for a in "$@"; do
  case "$a" in
    --update) UPDATE="--update" ;;
    --no-live) LIVE=0 ;;
    --debug) DEBUG_FLAG=1 ;;
    -*) echo "unknown option $a" >&2; exit 2 ;;
    *) WALLETS+=("$a") ;;
  esac
done

docker run --rm --ipc=host -e WALLET_DEBUG="$DEBUG_FLAG" -e LIVE="$LIVE" -e UPDATE="$UPDATE" -e WALLETS="${WALLETS[*]:-}" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$ROOT":/repo -w /repo/tests/wallets "$IMAGE" bash -euc '
    # whatever fails, the files this run made as root go back to the person who ran it (or `rm -rf tests/wallets/run` could not delete them)
    own() { chown -R "$HOST_UID:$HOST_GID" /repo/tests/wallets /repo/explorer/node_modules 2>/dev/null || true; }
    trap own EXIT
    NODE="node --experimental-transform-types --disable-warning=ExperimentalWarning"
    (cd /repo/explorer && npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
    npm ci --ignore-scripts --no-audit --no-fund >/dev/null
    $NODE src/fetch.ts $UPDATE $WALLETS
    $NODE src/reference.ts >/dev/null
    xvfb-run -a $NODE src/run.ts $WALLETS
    # the live check uses MetaMask and Rabby, which are fetched only when no wallet is named, so it runs only then
    if [ "$LIVE" = 1 ] && [ -z "$WALLETS" ]; then xvfb-run -a $NODE src/live.ts metamask rabby; fi
    $NODE src/report.ts
  '
