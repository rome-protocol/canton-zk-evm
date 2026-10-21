#!/usr/bin/env bash
# Stops unless the settings for running on an existing participant (CZE_CANTON=external) are complete and safe. Used by network/up.sh and network/restart.sh.
#   CZE_LEDGER_URL        the participant's JSON Ledger API: https, or http on this machine. A token is never sent in the clear to another machine.
#   CZE_TOKEN_FILE_<ROLE> ADMIN, OPERATOR, CONFIRMER and BUILDER: a file of its own, mode 0600, with one token (the Ledger API user's, HS256, signed by
#                         whoever runs the participant). CZE_LEDGER_NO_AUTH=1 instead, for a Ledger API with no login.
#   CZE_SIDECAR_LISTEN    optional, address:port: network/up.sh starts the sidecar here.
# Prints nothing a token holds: only which setting is wrong.
set -euo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }
url=${CZE_LEDGER_URL:-}
[ -n "$url" ] || fail "CZE_CANTON=external needs CZE_LEDGER_URL, the participant's JSON Ledger API"
[[ $url =~ ^(https://[^/]+|http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?)(/.*)?$ ]] \
  || fail "CZE_LEDGER_URL must be https, or http on this machine (127.0.0.1): a token must not cross a network in the clear"
[ -z "${CZE_SIDECAR_LISTEN:-}" ] || [[ $CZE_SIDECAR_LISTEN =~ ^[0-9A-Za-z.:-]+:[0-9]{2,5}$ ]] || fail "CZE_SIDECAR_LISTEN is address:port"
if [ "${CZE_LEDGER_NO_AUTH:-0}" = 1 ]; then
  echo "WARN: no Ledger API tokens: only for a participant whose Ledger API has no login" >&2
  exit 0
fi
for role in ADMIN OPERATOR CONFIRMER BUILDER; do
  var=CZE_TOKEN_FILE_$role
  file=${!var:-}
  [ -n "$file" ] || fail "$var is not set: a file with the $role user's token (or CZE_LEDGER_NO_AUTH=1)"
  if [ ! -f "$file" ] || [ ! -s "$file" ]; then fail "$var: $file is not a file with a token in it"; fi
  # shellcheck disable=SC2012
  [ "$(ls -ld "$file" | cut -c5-10)" = "------" ] || fail "$var: $file can be read by others: chmod 600 it"
done
echo "external participant: $url; one token file per role"
