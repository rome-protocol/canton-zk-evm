#!/usr/bin/env python3
"""Part of tests/canton_external.sh: the two sandbox cases of the custody expiry rules, against the real participant.
Usage: custody_cases.py a-setup     50 one-unit test-token holdings for the gateway in one submit, and U's standing acceptance of withdrawals
       custody_cases.py a-advance   One Advance whose withdrawal names all 50 as inputs, built by the builder's own code and sent by its Ledger.advance; the gateway's custody
                                    read at its completion offset less one and at it differs by exactly the withdrawn amount, and run_custody_check says "ok" for it
                                    and "stopped" for one base unit more
       custody_cases.py b           A transfer from U with change, accepted by V; U's custody read at the acceptance's completion offset less one and at it differs by
                                    exactly the amount; run_custody_check says "ok" for that amount and "stopped" for one base unit more
Settings are the ones of tests/canton_external.sh (CZE_*), and CZE_MAX_INBOUND: the participant's Ledger API limit on a request, in bytes, as set for this run.
Prints one "case ..." line with its numbers; any failure exits 1."""
import json, os, re, shutil, sys, tempfile, urllib.error
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


def config(user, party, read_as=(), **more):
    file = os.environ["CZE_TOKEN_FILE_" + user.upper()]   # the user's login file, read again on every call
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
        if url.endswith("/v2/commands/submit-and-wait"):
            sent["bytes"] = len(json.dumps(body).encode())
        return original(url, body, headers, timeout=timeout)
    b.post_json = post_json
    work = tempfile.mkdtemp()   # the custody check's work directory, removed at the end
    cfg = config("builder", parties["BUILDER_PARTY"], (parties["OPERATOR_PARTY"], gateway), disclosed=dc.read_disclosed(net), work_dir=work)
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
    withdrawn = b.base_units(WITHDRAW)
    before = b.custody_sum(ledger.active_holdings(offset - 1), gateway, instrument)
    left = b.custody_sum(ledger.active_holdings(offset), gateway, instrument)
    if left != b.base_units("0.5"):
        fail(f"the gateway's custody after the Advance is {b.canton_amount(left)} TKB, not 0.5")
    if before - left != withdrawn:
        fail(f"the gateway's custody at offset {offset - 1} is {before} and at {offset} is {left} base units: the difference is {before - left}, not {withdrawn}")
    rec = lambda n: {"gateway": gateway, "commandId": "custody-cases-a", "number": None, "plan": [{"instrument": instrument, "withdrawn": n, "deposits": 0}]}
    good, wrong = b.run_custody_check(cfg, rec(withdrawn), offset), b.run_custody_check(cfg, rec(withdrawn + 1), offset)
    shutil.rmtree(work, ignore_errors=True)
    if (good, wrong) != ("ok", "stopped"):
        fail(f"run_custody_check says {good!r} for the withdrawn amount and {wrong!r} for one base unit more, not 'ok' and 'stopped'")
    if sent["bytes"] >= limit:
        fail(f"the request of {sent['bytes']} bytes is not under the limit {limit}")
    print(f"case A: Advance with {len(inputs)} inputs committed at offset {offset} (head {head}); request {sent['bytes']} bytes, participant limit {limit} bytes; gateway custody {b.canton_amount(before)} at offset {offset - 1} and {b.canton_amount(left)} at {offset} TKB, "
          f"a difference of {b.canton_amount(before - left)} TKB = {WITHDRAW} withdrawn; run_custody_check says {good} for it and {wrong} for one base unit more")


def acceptance_offset(begin, party):
    """The offset of the one successful completion of the demo user's commands for `party` after offset `begin`; fails when there is none."""
    ask = {"userId": net.user("demo"), "parties": [party], "beginExclusive": begin}
    for item in net.post("users", f"/v2/commands/completions?limit={dc.COMPLETION_LIMIT}&stream_idle_timeout_ms={dc.COMPLETION_IDLE_MS}", ask, "demo"):
        done = ((item.get("completionResponse") or {}).get("Completion") or {}).get("value") or {}
        if ((done.get("status") or {}).get("code") or 0) == 0 and type(done.get("offset")) is int:
            return done["offset"]
    fail("the acceptance was answered as a duplicate, but no completion of it is on the ledger")


def b_case():
    disclosed = dc.read_disclosed(net)
    begin = net.get("users", "/v2/state/ledger-end", "demo")["offset"]   # the ledger end before anything of this case, for the completion of the acceptance
    old_offers = {e["contractId"] for e in net.template("users", "v", dc.TRANSFER_OFFER)}   # V's offers from before the transfer
    held = [e["contractId"] for e in net.template("users", "u", dc.TOKEN)]
    transfer = {"sender": u, "receiver": net.party("v"), "amount": SENT, "instrumentId": instrument, "requestedAt": dc.utc(dc.timedelta(minutes=-1)),
                "executeBefore": dc.utc(dc.timedelta(hours=1)), "inputHoldingCids": held, "meta": {"values": {}}}
    net.submit("users", ["u"], {"ExerciseCommand": {"templateId": dc.TRANSFER_FACTORY, "contractId": disclosed[0]["contractId"], "choice": "TransferFactory_Transfer",
                                                           "choiceArgument": {"expectedAdmin": registry, "transfer": transfer, "extraArgs": dc.NO_EXTRA_ARGS}}}, disclosed)
    # The test token answers with an offer that holds the amount locked with the sender until the receiver accepts: custody falls in the update of the acceptance.
    new = net.wait_for("the transfer offer", lambda: [e for e in net.template("users", "v", dc.TRANSFER_OFFER) if e["contractId"] not in old_offers])
    if len(new) != 1:
        fail(f"V has {len(new)} new transfer offers, not 1")
    answer = net.submit("users", ["v"], {"ExerciseCommand": {"templateId": dc.TRANSFER_INSTRUCTION, "contractId": new[0]["contractId"], "choice": "TransferInstruction_Accept",
                                                           "choiceArgument": {"extraArgs": dc.NO_EXTRA_ARGS}}})
    offset = answer.get("completionOffset")
    if answer.get("duplicate"):   # a repeat after a 503 was answered as known: the acceptance committed, and its completion (V's only command since `begin`) has the offset
        offset = acceptance_offset(begin, net.party("v"))
    if type(offset) is not int:
        fail(f"the acceptance's answer has no offset: {answer}")
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
