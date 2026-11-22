#!/usr/bin/env python3
"""Part of tests/canton_external.sh: the two sandbox cases of the custody expiry rules, against the real participant.
Usage: custody_cases.py a-setup     50 one-unit test-token holdings for the gateway in one submit, and U's standing acceptance of withdrawals
       custody_cases.py a-advance   One Advance whose withdrawal names all 50 as inputs, built by the builder's own code and sent by its Ledger.advance
       custody_cases.py b           A transfer from U with change; custody read at the completion offset less one and at it differs by exactly the amount;
                                    run_custody_check says "ok" for that amount and "stopped" for one base unit more
Settings are the ones of tests/canton_external.sh (CZE_*), and CZE_MAX_INBOUND: the participant's Ledger API limit on a request, in bytes, as set for this run.
Prints one "case ..." line with its numbers; any failure exits 1."""
import json, os, re, sys, tempfile, urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for sub in ("builder", "demo", "network/canton"):
    sys.path.insert(0, str(ROOT / sub))
import builder as b
import canton as dc   # demo/canton.py
import propose

INPUTS, EACH, WITHDRAW, SENT = 50, "1.0", "49.5", "4.0"
WRAPPED, BURNER, LEG_ID = "12" * 20, "34" * 20, "aa" * 32   # the wrapped token canton_external.sh registers; a burner and a withdrawal id
SIZE_WORDS = re.compile(r"RESOURCE_EXHAUSTED|max|size|larger|too (large|big)", re.I)


def fail(text):
    print("FAIL:", text, file=sys.stderr)
    raise SystemExit(1)


net = dc.Network()
u, gateway, registry = net.party("u"), net.party("gateway"), net.party("registry")
instrument = {"admin": registry, "id": dc.INSTRUMENT}


def config(user, party, read_as=(), token_role="", **more):
    file = os.environ["CZE_TOKEN_FILE_" + (token_role or user).upper()]   # the user's login file, read again on every call
    return b.Config(ws_url="", engine_url="", jwt_secret=b"", ledger_url=os.environ["CZE_LEDGER_URL"], ledger_user=net.user(user), party=party, fee_recipient="",
                    genesis="", work_dir=more.pop("work_dir", ""), make_input_cmd="", prove_cmd="", read_as=tuple(read_as), **{"ledger_token": "", "ledger_token_file": file}, **more)


def a_setup():
    # The gateway signs its holdings with the registry; the demo user acts for the registry, so it may act for the gateway too in this sandbox.
    propose.change_acts_as("POST", net.urls["users"], net.user("demo"), {gateway}, propose.role_token("admin"))
    create = lambda: {"CreateCommand": {"templateId": dc.TOKEN, "createArguments": {"holding": {
        "owner": gateway, "instrumentId": instrument, "amount": EACH, "lock": None, "meta": {"values": {}}}}}}
    net.post("users", "/v2/commands/submit-and-wait", {"commands": [create() for _ in range(INPUTS)], "commandId": "custody-50-holdings", "userId": net.user("demo"),
                                                    "actAs": [gateway, registry]}, "demo")
    net.wait_for("the gateway's holdings", lambda: len(net.template("operator", "gateway", dc.TOKEN)) == INPUTS or None)
    dc.accept(net, "u")


def a_advance():
    parties = net.parties
    sent = {}
    original = b.post_json
    def post_json(url, body, headers, timeout=120):   # what Ledger.advance sends, measured as post_json encodes it
        sent["bytes"] = len(json.dumps(body).encode())
        return original(url, body, headers, timeout=timeout)
    b.post_json = post_json
    cfg = config("builder", parties["BUILDER_PARTY"], (parties["OPERATOR_PARTY"], gateway), disclosed=dc.read_disclosed(net))
    ledger = b.Ledger(cfg)
    chain = ledger.head()
    leg = b.LegEvent(b.WITHDRAWAL, LEG_ID, WRAPPED, BURNER, b.base_units(WITHDRAW), u, b.ZERO32)
    canton = b.Canton(ledger, chain, datetime.now(timezone.utc))
    leg_out = b.withdrawal_leg(leg, canton, None)
    inputs = leg_out["value"]["inputs"]
    if len(inputs) != INPUTS or len(set(inputs)) != INPUTS:
        fail(f"the builder's withdrawal names {len(inputs)} inputs, not {INPUTS}")
    argument = {"headerHex": "01", "txsHex": "", "proofHex": "02", "gatewayAccountNodes": [], "gatewayStorageNodes": [], "legs": [leg_out]}
    limit = int(os.environ["CZE_MAX_INBOUND"])
    try:
        answer = ledger.advance(chain, argument)
    except urllib.error.HTTPError as e:
        text = e.read().decode("utf-8", "replace")
        kind = "a size refusal" if e.code == 413 or SIZE_WORDS.search(text) else "a refusal"
        fail(f"the participant answered {kind}: HTTP {e.code}, request of {sent.get('bytes')} bytes, limit {limit}: {text[:400]}")
    offset = answer["completionOffset"]
    if answer["updateId"] is None or type(offset) is not int:
        fail(f"the Advance's answer has no update id or offset: {answer}")
    head = ledger.head()["headNumber"]
    if head != "2":
        fail(f"the chain's head is {head}, not 2: the Advance did not commit")
    left = b.custody_sum(ledger.active_holdings(offset), gateway, instrument)
    if left != b.base_units("0.5"):
        fail(f"the gateway's custody after the Advance is {b.canton_amount(left)} TKB, not 0.5")
    if sent["bytes"] >= limit:
        fail(f"the request of {sent['bytes']} bytes is not under the limit {limit}")
    print(f"case A: Advance with {len(inputs)} inputs committed at offset {offset} (head {head}); request {sent['bytes']} bytes, participant limit {limit} bytes; gateway custody left {b.canton_amount(left)} TKB")


def b_case():
    disclosed = dc.read_disclosed(net)
    held = [e["contractId"] for e in net.template("users", "u", dc.TOKEN)]
    transfer = {"sender": u, "receiver": net.party("v"), "amount": SENT, "instrumentId": instrument, "requestedAt": dc.utc(dc.timedelta(minutes=-1)),
                "executeBefore": dc.utc(dc.timedelta(hours=1)), "inputHoldingCids": held, "meta": {"values": {}}}
    answer = net.submit("users", ["u"], {"ExerciseCommand": {"templateId": dc.TRANSFER_FACTORY, "contractId": disclosed[0]["contractId"], "choice": "TransferFactory_Transfer",
                                                           "choiceArgument": {"expectedAdmin": registry, "transfer": transfer, "extraArgs": dc.NO_EXTRA_ARGS}}}, disclosed)
    offset = answer.get("completionOffset")
    if type(offset) is not int:
        fail(f"the transfer's answer has no offset: {answer}")
    sent = b.base_units(SENT)
    with tempfile.TemporaryDirectory() as work:
        cfg = config("demo", u, work_dir=work)   # reads as U: the builder's own user reads as the gateway only
        ledger = b.Ledger(cfg)
        before = b.custody_sum(ledger.active_holdings(offset - 1), u, instrument)
        after = b.custody_sum(ledger.active_holdings(offset), u, instrument)
        if before - after != sent or before == after:
            fail(f"custody at offset {offset - 1} is {before} and at {offset} is {after} base units: the difference is {before - after}, not {sent}")
        rec = lambda n: {"gateway": u, "commandId": "custody-cases", "number": None, "plan": [{"instrument": instrument, "withdrawn": n, "deposits": 0}]}
        good, wrong = b.run_custody_check(cfg, rec(sent), offset), b.run_custody_check(cfg, rec(sent + 1), offset)
        if (good, wrong) != ("ok", "stopped"):
            fail(f"run_custody_check says {good!r} for the amount and {wrong!r} for one base unit more, not 'ok' and 'stopped'")
    print(f"case B: custody at offset {offset - 1} is {before} and at {offset} is {after} base units, a difference of {before - after} = {SENT} TKB; run_custody_check says {good} for it and {wrong} for one base unit more")


{"a-setup": a_setup, "a-advance": a_advance, "b": b_case}[sys.argv[1]]()
