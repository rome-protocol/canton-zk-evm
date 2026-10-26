#!/usr/bin/env bash
# Like fake-make-input.sh, and it also says how the stand-in emulator treats this block: FAKE_STEPS_DIR/<block hash> gets the line the
# emulator reads, built from FAKE_TX_PLAN (a JSON file: transaction hash -> {"steps": n, "abort": "heap"|"fail", "sleep": seconds}; a transaction
# not in it takes 100 steps): the steps are summed over the block's transactions, and the first abort or sleep of any of them applies.
set -euo pipefail
"$(dirname "$0")/fake-make-input.sh" "$@"
python3 - "$1" "$4" <<'PY'
import json, os, sys
block = json.load(open(sys.argv[1]))
plan = json.load(open(os.environ["FAKE_TX_PLAN"])) if os.environ.get("FAKE_TX_PLAN") else {}
words, steps = [], 0
for t in block["transactions"]:
    p = plan.get(t["hash"], {})
    steps += p.get("steps", 100)
    for k in ("abort", "sleep"):
        if k in p and not any(w.startswith(k + "=") for w in words):
            words.append(f"{k}={p[k]}")
open(os.path.join(os.environ["FAKE_STEPS_DIR"], open(sys.argv[2]).read().strip()), "w").write(f"steps={steps} " + " ".join(words) + "\n")
PY
