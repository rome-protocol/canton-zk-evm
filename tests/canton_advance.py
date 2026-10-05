#!/usr/bin/env python3
"""Part of tests/canton_network.sh: one Advance by the builder on the real Canton network.
Usage: canton_advance.py <state dir> accepted|refused   Prints the head number after the attempt."""
import json, sys, time, urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "network" / "canton"))
import propose

state, expect = Path(sys.argv[1]), sys.argv[2]
parties = propose.read_env_file(state / "canton" / "parties.env")
builder = propose.Ledger("http://127.0.0.1:7575", "builder", parties["BUILDER_PARTY"])
[chain] = builder.active("ZkChain")
command = {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "Advance",
                               "choiceArgument": {"headerHex": "01", "txsHex": "", "proofHex": "02", "legs": []}}}
try:
    builder.submit(command)
    outcome = "accepted"
except urllib.error.HTTPError as e:
    outcome = "refused"
    print("refusal:", e.read().decode()[:300], file=sys.stderr)
assert outcome == expect, f"Canton {outcome} the block, expected it to be {expect}"
time.sleep(1)
print(builder.active("ZkChain")[0]["headNumber"])
if outcome == "accepted":
    reader = propose.Ledger("http://127.0.0.1:7577", "reader", parties["READER_PARTY"])
    records = reader.wait_for("BlockRecord")
    assert len(records) == 1 and records[0]["number"] == "1", records
