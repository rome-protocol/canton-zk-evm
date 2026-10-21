#!/usr/bin/env bash
# Stops unless a participant's Ledger API lists a package id (GET /v2/packages). Run it with the main package id that
# dar-id.sh read from the DAR and the operator participant's JSON Ledger API: it shows that the package Canton holds is
# the one in the DAR, so the id that smoke.sh records is the id of the package that ran.
# On a participant with a login, CZE_PACKAGE_TOKEN_FILE (default CZE_TOKEN_FILE_ADMIN) names the file with a token that may list packages; any user's will do,
# so a restart passes the builder's and never needs the admin's; it goes to curl as a header file, so no token is in
# a process list, and it is never printed.
# Usage: check-package.sh <package id: 64 hex digits> [ledger url, default $CZE_LEDGER_URL or http://127.0.0.1:7575]
set -euo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }
id=${1:-}
url=${2:-${CZE_LEDGER_URL:-http://127.0.0.1:7575}}
[[ $id =~ ^[0-9a-f]{64}$ ]] || fail "not a package id (64 hex digits): '$id'"
auth=()
tokenfile=${CZE_PACKAGE_TOKEN_FILE-${CZE_TOKEN_FILE_ADMIN:-}}
if [ -n "$tokenfile" ]; then
  [ -s "$tokenfile" ] || fail "the token file for listing packages ($tokenfile) is not a file with a token in it"
  # A header file of mode 0600 (made before the token goes in), removed at exit; curl reads it more than once, so a pipe will not do.
  header=$(mktemp); trap 'rm -f "$header"' EXIT
  printf 'Authorization: Bearer %s\n' "$(tr -d '[:space:]' < "$tokenfile")" > "$header"
  auth=(-H "@$header")
fi
answer=$(curl -sf ${auth[@]+"${auth[@]}"} "$url/v2/packages") || fail "the Ledger API at $url did not answer GET /v2/packages"
listed=$(jq -r '.packageIds[]?' <<<"$answer" 2>/dev/null) || fail "the answer of $url/v2/packages is not a package list"
grep -qxF "$id" <<<"$listed" || fail "package $id is not in the package list of $url ($(grep -c . <<<"$listed") packages listed)"
echo "package $id is in the package list of $url"
