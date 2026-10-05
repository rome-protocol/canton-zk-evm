#!/usr/bin/env bash
# Checks the demo's results files: demo/results/run1.txt and run2.txt (and run1-proof.hex) say what the two runs showed, and agree
# with each other. Usage: tests/demo_results.sh [folder] [--stand-in]
# --stand-in is for the rehearsal's output, whose proof is a stand-in: the proof's own keys and block hash are not checked then.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
D=${1:-$ROOT/demo/results}
standin=no; [ "${2:-}" = --stand-in ] && standin=yes
fail() { echo "FAIL: $*" >&2; exit 1; }
v() { sed -n "s/^$2=//p" "$1" | head -1; }   # value of a key in a results file
must() { [ "$(v "$1" "$2")" = "$3" ] || fail "$(basename "$1"): $2 is '$(v "$1" "$2")', expected '$3'"; }
has() { grep -qE "^$2=." "$1" || fail "$(basename "$1") has no $2"; }
R1=$D/run1.txt R2=$D/run2.txt P1=$D/run1-proof.hex
for f in "$R1" "$R2" "$P1"; do [ -f "$f" ] || fail "no $f"; done

for f in "$R1" "$R2"; do
  must "$f" format 1
  for k in date source_commit dar_sha256 package_id chain_id guest_elf_sha256 programVK rootC canton daml_sdk zisk reth block token evm_transfer_tx terms allocation; do has "$f" $k; done
  [[ $(v "$f" source_commit) =~ ^[0-9a-f]{40}$ ]] || fail "$(basename "$f"): source_commit is not a full commit hash"
  [[ $(v "$f" dar_sha256) =~ ^[0-9a-f]{64}$ ]] || fail "$(basename "$f"): dar_sha256 is not a SHA-256"
  [[ $(v "$f" guest_elf_sha256) =~ ^[0-9a-f]{64}$ ]] || fail "$(basename "$f"): guest_elf_sha256 is not a SHA-256"
  [[ $(v "$f" programVK) =~ ^0x[0-9a-f]{64}$ ]] || fail "$(basename "$f"): programVK is not 0x and 64 hex digits"
  [[ $(v "$f" token) =~ ^0x[0-9a-f]{40}$ ]] || fail "$(basename "$f"): token is not an address"
  # Generic only: no email address, no IPv4 address.
  ! grep -qE '@|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9.]|$)' "$f" || fail "$(basename "$f") has an email address or an IPv4 address"
done
for k in source_commit dar_sha256 package_id programVK rootC guest_elf_sha256 token; do
  [ "$(v "$R1" $k)" = "$(v "$R2" $k)" ] || fail "run1.txt and run2.txt disagree on $k"
done

# Run 1: one block, the DvP leg settled with it.
H=$(v "$R1" block_hash)
[[ $H =~ ^0x[0-9a-f]{64}$ ]] || fail "run1.txt: block_hash is not a block hash"
must "$R1" transactions 1; must "$R1" legs 1
must "$R1" canton_head_hash "$H"
[ "$(v "$R1" canton_head_after)" = "$(v "$R1" block)" ] || fail "run1.txt: Canton's head is not the block"
[ "$(v "$R1" canton_head_before)" = "$(( $(v "$R1" block) - 1 ))" ] || fail "run1.txt: Canton's head before is not the parent's number"
must "$R1" block_record_holds_the_proof yes
# The BlockRecord and V's new holding were made by one Canton update (run.sh checked it on the users participant).
[[ $(v "$R1" canton_update) =~ ^[0-9a-f]{32,}$ ]] || fail "run1.txt: canton_update is not a Canton update id"
must "$R1" block_record_and_v_holding_in_one_update yes
must "$R1" reth_finalized yes
must "$R1" allocation_active_after no; must "$R1" terms_active_after no
must "$R1" tkb_u_before 90; must "$R1" tkb_v_before 0; must "$R1" tkb_u_after 90; must "$R1" tkb_v_after 10
must "$R1" tka_u_before 0;   must "$R1" tka_v_before 1000; must "$R1" tka_u_after 10; must "$R1" tka_v_after 990
proof=$(tr -d '\n' < "$P1")
{ [ "${#proof}" = 2688 ] && [[ $proof =~ ^[0-9a-f]+$ ]]; } || fail "run1-proof.hex is not 1,344 bytes of lowercase hex"
sum=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(bytes.fromhex(sys.argv[1])).hexdigest())' "$proof")
[ "$sum" = "$(v "$R1" proof_sha256)" ] || fail "run1-proof.hex does not hash to proof_sha256"
if [ "$standin" = no ]; then
  # The proof is the four fields one after the other: the proof (768), programVK (32), rootC (32), public values (512). The proof
  # carries the recorded keys, and its public values carry the block's hash. This only reads those fields; it does not verify
  # the proof (the sidecar verified it when Canton committed run 1).
  [ "0x${proof:1536:64}" = "$(v "$R1" programVK)" ] || fail "run1-proof.hex does not carry the recorded programVK"
  [ "0x${proof:1600:64}" = "$(v "$R1" rootC)" ] || fail "run1-proof.hex does not carry the recorded rootC"
  words=$(python3 - "${proof:1664}" <<'PY'
import sys
v = sys.argv[1]
print("".join(v[i:i + 8] for i in range(0, len(v), 16)))   # each 8-byte slot holds a 4-byte word and four zero bytes
PY
)
  grep -q "${H#0x}" <<<"$words" || fail "run1-proof.hex does not carry the block hash in its public values"
fi

# Run 2: the refused block moved nothing.
must "$R2" builder_exit 2; must "$R2" committed no
must "$R2" refusal "the sidecar refused the block: no the proof does not verify"
must "$R2" leg_attached yes
[ "$(v "$R2" block)" = "$(( $(v "$R1" block) + 1 ))" ] || fail "run2.txt: the refused block is not the one after run 1's"
must "$R2" canton_head_before "$(v "$R1" block)"; must "$R2" canton_head_after "$(v "$R1" block)"; must "$R2" canton_head_hash "$H"
[ "$(v "$R2" block_records_before)" = "$(v "$R2" block_records_after)" ] || fail "run2.txt: the number of block records changed"
for k in u v; do [ "$(v "$R2" tkb_${k}_before)" = "$(v "$R2" tkb_${k}_after)" ] || fail "run2.txt: TKB of $k changed"; done
must "$R2" allocation_active_after yes; must "$R2" terms_active_after yes
must "$R2" tka_u_after 10; must "$R2" tka_v_after 990
must "$R2" reth_latest_is_parent yes; must "$R2" reth_finalized_is_parent yes;
echo "demo results are complete and consistent"
