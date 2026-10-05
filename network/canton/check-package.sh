#!/usr/bin/env bash
# Stops unless a participant's Ledger API lists a package id (GET /v2/packages). Run it with the main package id that
# dar-id.sh read from the DAR and the operator participant's JSON Ledger API: it shows that the package Canton holds is
# the one in the DAR, so the id that smoke.sh records is the id of the package that ran.
# Usage: check-package.sh <package id: 64 hex digits> [ledger url, default $CZE_LEDGER_URL or http://127.0.0.1:7575]
set -euo pipefail
fail() { echo "FAIL: $*" >&2; exit 1; }
id=${1:-}
url=${2:-${CZE_LEDGER_URL:-http://127.0.0.1:7575}}
[[ $id =~ ^[0-9a-f]{64}$ ]] || fail "not a package id (64 hex digits): '$id'"
answer=$(curl -sf "$url/v2/packages") || fail "the Ledger API at $url did not answer GET /v2/packages"
listed=$(jq -r '.packageIds[]?' <<<"$answer" 2>/dev/null) || fail "the answer of $url/v2/packages is not a package list"
grep -qxF "$id" <<<"$listed" || fail "package $id is not in the package list of $url ($(grep -c . <<<"$listed") packages listed)"
echo "package $id is in the package list of $url"
