#!/usr/bin/env bash
# The stand-in emulator for a whole builder: the input is a block hash (what fake-make-input.sh writes); what the emulator does for it is the
# line in FAKE_STEPS_DIR/<hash> (fake-make-input-sized.sh). The arguments are the real emulator's: -e <elf> -i <input> ...
set -euo pipefail
args=("$@")
for i in "${!args[@]}"; do
  if [ "${args[$i]}" = "-i" ]; then
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
    cp "$FAKE_STEPS_DIR/$(tr -d '\n' < "${args[i + 1]}")" "$tmp"
    args[i + 1]=$tmp
  fi
done
"$(dirname "$0")/fake-ziskemu.sh" "${args[@]}"
