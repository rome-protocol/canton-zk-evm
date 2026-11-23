#!/usr/bin/env python3
"""Part of tests/canton_network.sh, on the real Canton network: the legs of Daml 0.6.0 for transfers to the gateway.
Usage: canton_receipt_payout.py <state dir> <evm token> prepare   Proposes and accepts the intake, then the gateway records a receipt (Intake_Record) for the token.
       canton_receipt_payout.py <state dir> <evm token> receipt   One Advance with a receipt leg: the receipt is gone, the head moves on.
       canton_receipt_payout.py <state dir> <evm token> payout    One Advance with a payout leg: a payout is there, with the leg's fields; the gateway marks it paid.
The stand-in sidecars' answers are set by the caller for each block."""
import os, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "network" / "canton"))
import propose

state, token_address, mode = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
parties = propose.read_env_file(state / "canton" / "parties.env")
URL = os.environ.get("CZE_LEDGER_URL", "http://127.0.0.1:7575")
CONFIRMER_URL = os.environ.get("CZE_CONFIRMER_LEDGER_URL", "http://127.0.0.1:7576")
operator = propose.operator_ledger(URL, parties)
as_gateway = propose.Ledger(URL, propose.user_id("operator"), parties["GATEWAY_PARTY"], (), propose.role_token("operator"))
builder = propose.Ledger(URL, propose.user_id("builder"), parties["BUILDER_PARTY"], (), propose.role_token("builder"))
who = parties["REGISTRY_PARTY"]   # any party: the sender of the receipt and the payee of the payout are plain fields
[chain] = builder.active("ZkChain")
[registered] = [t for t in builder.active("GatewayToken") if t["evmToken"] == token_address]


def advance(legs: list) -> None:
    before = int(chain["headNumber"])
    builder.submit({"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "Advance",
                                        "choiceArgument": {"headerHex": "01", "txsHex": "", "proofHex": "02", "gatewayAccountNodes": [], "gatewayStorageNodes": [], "legs": legs}}})
    time.sleep(1)
    assert int(builder.active("ZkChain")[0]["headNumber"]) == before + 1, "the block did not move the head"


if mode == "prepare":
    fields = {k: chain[k] for k in ("operator", "confirmer", "gateway", "builder", "chainId")}
    operator.submit({"CreateCommand": {"templateId": propose.PKG + "IntakeProposal", "createArguments": fields}})
    confirmer = propose.confirmer_ledger(CONFIRMER_URL, parties)
    [proposal] = confirmer.wait_for("IntakeProposal")
    confirmer.submit({"ExerciseCommand": {"templateId": propose.PKG + "IntakeProposal", "contractId": proposal["contractId"], "choice": "AcceptIntake", "choiceArgument": {}}})
    [intake] = as_gateway.wait_for("Intake")
    as_gateway.submit({"ExerciseCommand": {"templateId": propose.PKG + "Intake", "contractId": intake["contractId"], "choice": "Intake_Record",
                                           "choiceArgument": {"gatewayToken": registered["contractId"], "sender": who, "amount": "10.0", "label": "m1", "recipient": "44" * 20}}})
    [receipt] = builder.wait_for("Receipt")
    assert (receipt["sender"], float(receipt["amount"]), receipt["recipient"], receipt["label"]) == (who, 10.0, "44" * 20, "m1"), receipt
elif mode == "receipt":
    [receipt] = builder.active("Receipt")
    advance([{"tag": "ReceiptLeg", "value": {"receipt": receipt["contractId"]}}])
    assert builder.active("Receipt") == [], "the receipt is still there after its leg"
elif mode == "payout":
    advance([{"tag": "PayoutLeg", "value": {"id": "c1" * 32, "gatewayToken": registered["contractId"], "from": "55" * 20, "amount": "4.0", "party": who}}])
    [payout] = as_gateway.wait_for("Payout")
    assert (payout["withdrawalId"], payout["party"], float(payout["amount"])) == ("c1" * 32, who, 4.0), payout
    as_gateway.submit({"ExerciseCommand": {"templateId": propose.PKG + "Payout", "contractId": payout["contractId"], "choice": "Payout_Paid", "choiceArgument": {}}})
    time.sleep(1)
    assert as_gateway.active("Payout") == [], "the payout is still there after it was marked paid"
else:
    sys.exit("mode: prepare, receipt or payout")
print("ok")
