#!/usr/bin/env python3
"""Part of tests/canton_network.sh, on the real Canton network.
Usage: canton_advance.py <state dir> accepted|refused   One Advance by the builder, with no legs and no gateway proofs.
                                                        Prints the head number after the attempt.
       canton_advance.py <state dir> gateway <address>  Checks that the chain names the gateway party and this address, and that the
                                                        gateway party sees the chain, that the builder's user may read as the gateway and not act
                                                        as it, and that the operator's user may act as it."""
import json, sys, time, urllib.error, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "network" / "canton"))
import propose

state, expect = Path(sys.argv[1]), sys.argv[2]
parties = propose.read_env_file(state / "canton" / "parties.env")
builder = propose.Ledger("http://127.0.0.1:7575", "builder", parties["BUILDER_PARTY"])
[chain] = builder.active("ZkChain")
if expect == "gateway":
    gateway_address = sys.argv[3]
    assert chain["gateway"] == parties["GATEWAY_PARTY"], f"the chain's gateway is {chain['gateway']}"
    assert chain["gatewayAddress"] == gateway_address, f"the chain's gateway address is {chain['gatewayAddress']}"
    as_gateway = propose.Ledger("http://127.0.0.1:7575", "operator", parties["GATEWAY_PARTY"])
    assert len(as_gateway.active("ZkChain")) == 1, "the gateway party does not see the chain"

    def rights(user):
        """What the Ledger API says a user may do: pairs of (right, party)."""
        with urllib.request.urlopen(f"http://127.0.0.1:7575/v2/users/{user}/rights", timeout=60) as r:
            return {(kind, body.get("value", {}).get("party")) for right in json.load(r)["rights"] for kind, body in right["kind"].items()}
    gw = parties["GATEWAY_PARTY"]
    b, o = rights("builder"), rights("operator")
    assert ("CanReadAs", gw) in b and ("CanActAs", gw) not in b, f"the builder must read as the gateway and not act as it: {b}"
    assert ("CanActAs", gw) in o, f"the operator's user cannot act as the gateway: {o}"
    print("ok")
    sys.exit(0)
command = {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "Advance",
                               "choiceArgument": {"headerHex": "01", "txsHex": "", "proofHex": "02",
                                                  "gatewayAccountNodes": [], "gatewayStorageNodes": [], "legs": []}}}
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
