#!/usr/bin/env python3
"""Part of tests/canton_network.sh, on the real Canton network: the legs of Daml 0.6.0 for transfers to the gateway.
Usage: canton_receipt_payout.py <state dir> <evm token> prepare   Proposes and accepts the intake, then the custody worker (apps/custody/intake.py) takes U's token-standard transfer of the
                                                                  Splice test token to the gateway (demo/canton.py send-to-gateway, with an address and a label as its memo): the receipt is made by the accept,
                                                                  with the memo's label and recipient.
       canton_receipt_payout.py <state dir> <evm token> receipt   One Advance with a receipt leg: the receipt is gone, the head moves on.
       canton_receipt_payout.py <state dir> <evm token> payout    One Advance with a payout leg: a payout is there, with the leg's fields. The custody worker (apps/custody/payout.py) offers it to U as a
                                                                  token-standard transfer, U accepts the offer (demo/asset.py accept), and the worker marks the payout paid.
The stand-in sidecars' answers are set by the caller for each block."""
import argparse, json, os, subprocess, sys, tempfile, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "network" / "canton"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "custody"))
import propose
import intake
import payout

state, token_address, mode = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
parties = propose.read_env_file(state / "canton" / "parties.env")
URL = os.environ.get("CZE_LEDGER_URL", "http://127.0.0.1:7575")
CONFIRMER_URL = os.environ.get("CZE_CONFIRMER_LEDGER_URL", "http://127.0.0.1:7576")
operator = propose.operator_ledger(URL, parties)
as_gateway = propose.Ledger(URL, propose.user_id("operator"), parties["GATEWAY_PARTY"], (), propose.role_token("operator"))
builder = propose.Ledger(URL, propose.user_id("builder"), parties["BUILDER_PARTY"], (), propose.role_token("builder"))
who = parties["U_PARTY"]   # the sender of the receipt and the payee of the payout are plain fields
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
    as_gateway.wait_for("Intake")
    bearer_file = os.environ.get("CZE_TOKEN_FILE_OPERATOR", "")
    args = argparse.Namespace(ledger_url=URL, ledger_user=propose.user_id("operator"), bearer_file=bearer_file, gateway_party=parties["GATEWAY_PARTY"], work_dir="")
    [taken] = intake.Intake(intake.ledger_of(args), intake.Settings(parties["GATEWAY_PARTY"])).poll()   # no registry: the test token needs no choice context
    assert taken["label"] == "intake-1" and taken["recipient"] == "44" * 20, taken
    [receipt] = builder.wait_for("Receipt")
    assert (receipt["sender"], float(receipt["amount"]), receipt["recipient"], receipt["label"]) == (who, 10.0, "44" * 20, "intake-1"), receipt
elif mode == "receipt":
    [receipt] = builder.active("Receipt")
    advance([{"tag": "ReceiptLeg", "value": {"receipt": receipt["contractId"]}}])
    assert builder.active("Receipt") == [], "the receipt is still there after its leg"
elif mode == "payout":
    advance([{"tag": "PayoutLeg", "value": {"id": "c1" * 32, "gatewayToken": registered["contractId"], "from": "55" * 20, "amount": "4.0", "party": who}}])
    [made] = as_gateway.wait_for("Payout")
    assert (made["payoutId"], made["party"], float(made["amount"])) == ("c1" * 32, who, 4.0), made
    with tempfile.TemporaryDirectory() as work:
        args = argparse.Namespace(ledger_url=URL, ledger_user=propose.user_id("operator"), bearer_file=os.environ.get("CZE_TOKEN_FILE_OPERATOR", ""), gateway_party=parties["GATEWAY_PARTY"], work_dir=work)
        ledger = intake.ledger_of(args)
        ledger.cfg.disclosed = json.loads((state / "demo" / "disclosed.json").read_text())   # the test token's rules, which the gateway's transfer needs
        worker = payout.Payouts(ledger, intake.Settings(parties["GATEWAY_PARTY"]), work, 24)
        [offered] = worker.poll()
        assert offered["offered"] == "c1" * 32 and offered["party"] == who and float(offered["amount"]) == 4.0, offered
        assert worker.poll() == [], "the offer is out: nothing is sent again"
        assert len(as_gateway.active("Payout")) == 1, "the payout is marked paid before U accepted the offer"
        instrument = offered["instrument"]
        done = subprocess.run([sys.executable, str(Path(__file__).resolve().parent.parent / "demo" / "asset.py"), "accept", f"{instrument['admin']}/{instrument['id']}", offered["instruction"]],
                              capture_output=True, text=True, timeout=300)
        assert done.returncode == 0, f"U's accept stopped: {(done.stderr or done.stdout)[-600:]}"
        [paid] = worker.poll()
        assert paid["paid"] == "c1" * 32 and paid["party"] == who, paid
        time.sleep(1)
        assert as_gateway.active("Payout") == [], "the payout is still there after it was paid"
else:
    sys.exit("mode: prepare, receipt or payout")
print("ok")
