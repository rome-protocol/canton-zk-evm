#!/usr/bin/env python3
"""A list of contracts that someone made longer than the participant's page, on the real network: 201 WithdrawalAcceptances that V signs, and U's own
acceptance made after them, so that it is on the second page of the builder's read (it needs the Canton of the rehearsal's demo, run before). The
builder reads the acceptances 200 at a time and matches a withdrawal leg of U with U's acceptance on page 2. V's 201 are archived at the end, and
U has one acceptance again (a new contract).

  demo_paged_acceptances.py          needs CZE_STATE_DIR of a running network that demo/run.sh has run on; prints one line and exits 0, or says what failed
"""
import json, sys, time, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "builder"))
sys.path.insert(0, str(ROOT / "demo"))
import builder as b  # noqa: E402
import canton as c  # noqa: E402

SPAM = 201   # one more than a page of 200


def main() -> str:
    net = c.Network()
    u, v = net.party("u"), net.party("v")
    chain = c.chain_record(net)
    cfg = b.Config(ws_url="", engine_url="", jwt_secret=b"", ledger_url=net.urls["operator"], ledger_user="builder", ledger_token="", party=net.party("builder"),
                   fee_recipient="", genesis="", work_dir="", make_input_cmd="", prove_cmd="", read_as=(net.party("operator"), net.party("gateway")))
    ledger = b.Ledger(cfg)
    create = lambda party: {"CreateCommand": {"templateId": c.ACCEPTANCE, "createArguments": {
        "party": party, "chainId": chain["chainId"], "operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"]}}}
    archive = lambda cid: {"ExerciseCommand": {"templateId": c.ACCEPTANCE, "contractId": cid, "choice": "Archive", "choiceArgument": {}}}

    def many(party: str, commands: list) -> None:   # one transaction: the commands of one party
        body = {"commands": commands, "commandId": str(uuid.uuid4()), "userId": net.user(c.USER), "actAs": [net.party(party)]}
        net.post("users", "/v2/commands/submit-and-wait", body, c.USER)

    def settled(enough) -> list:   # the builder's own read of the acceptances, until `enough` holds of it
        deadline = time.time() + 120
        while True:
            found = ledger.active(b.ACCEPTANCE)
            if enough(found) or time.time() > deadline:
                if not enough(found):
                    raise SystemExit(f"timed out: the builder reads {len(found)} acceptances")
                return found
            time.sleep(1)

    for old in c.acceptances_of(net, "u"):   # U's acceptance, made before the demo's runs, is on page 1 of any later read: it is made again, after V's
        net.submit("users", ["u"], archive(old["contractId"]))
    many("v", [create(v)] * SPAM)
    net.submit("users", ["u"], create(u))
    found = settled(lambda f: len(f) >= SPAM + 1 and any(a["party"] == u for a in f))

    asked = []
    real = b.post_json
    b.post_json = lambda url, body, headers, timeout=120: (asked.append(body), real(url, body, headers, timeout))[1]
    try:
        canton = b.Canton(ledger, ledger.head(), b.utcnow())
        registered = canton.tokens[0]   # the one wrapped token the demo registered
        leg = b.withdrawal_leg(b.LegEvent(b.WITHDRAWAL, "ab" * 32, registered["evmToken"], "c3" * 20, 10 ** 10, u, "0x" + "00" * 32), canton, None)
        acceptances = canton.acceptances
    finally:
        b.post_json = real
    mine = [i for i, a in enumerate(acceptances) if a["party"] == u]
    pages = [q for q in asked if c.ACCEPTANCE in json.dumps(q)]
    if len(mine) != 1 or mine[0] < b.LIST_PAGE:
        raise SystemExit(f"U's acceptance is at {mine} of {len(acceptances)}: it must be one, after the first page of {b.LIST_PAGE}")
    if len(pages) != -(-len(acceptances) // b.LIST_PAGE) or len(pages) < 2:
        raise SystemExit(f"{len(acceptances)} acceptances were read in {len(pages)} requests")
    if leg["value"]["acceptance"] != acceptances[mine[0]]["contractId"]:
        raise SystemExit(f"the leg names {leg['value']['acceptance']}, not U's acceptance {acceptances[mine[0]]['contractId']}")
    many("v", [archive(a["contractId"]) for a in found if a["party"] == v])
    settled(lambda f: not any(a["party"] == v for a in f))
    return f"a withdrawal leg matched U's acceptance at {mine[0] + 1} of {len(acceptances)} acceptances, read in {len(pages)} pages; V's {SPAM} are archived"


if __name__ == "__main__":
    print(main())
