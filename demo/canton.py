#!/usr/bin/env python3
"""The Canton side of the demo, through the participants' JSON Ledger API. See demo/README.md.

  canton.py upload-dars                load the token standard's factory and the test token (daml/dars) into all three participants
  canton.py setup                      the registry makes the TKB rules; U gets 100 TKB; the rules go to $CZE_STATE_DIR/demo/disclosed.json
  canton.py dvp <label> <token> <holder> <expected>
                                       U allocates 10 TKB to V (executor: the operator, as the DvP's one leg U to V); then U and V
                                       sign DvpTerms: "if <holder>'s balance of <token> (TKA, slot 0) rose by <expected> in the
                                       proven block, execute that allocation". Prints the allocation and the terms.
  canton.py settled <block number>     the Canton update that created that block's BlockRecord, and the one that created V's newest TKB
                                       holding, each as the users participant reports it (update id, offset, the contract made).
                                       Run 1 checks that the two are the same update: the block and the allocation settle together.
  canton.py status                     print what is on Canton now: the chain head, the block records, the TKB holdings of U and V,
                                       the active allocations and terms

TKB is the Canton-side test token (the Splice reference token); TKA is the EVM-side one. The network runs without Ledger
API authentication (network/README.md), so one Ledger API user, `demo`, acts for U, V and the registry together here.
Settings: CZE_STATE_DIR, CZE_LEDGER_URL (operator, 7575), CZE_CONFIRMER_LEDGER_URL (7576), CZE_USERS_LEDGER_URL (7577).
"""
import hashlib, json, os, sys, time, urllib.error, urllib.request, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USER = "demo"
CHAIN = "#canton-zk-evm:Zk.Chain:"
TOKEN = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:Token"
RULES = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenRules"
ALLOCATION_OF_TOKEN = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenAllocation"
ALLOCATION_FACTORY = "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory"
EXTRA_DARS = ["splice-api-token-transfer-instruction-v1-1.0.0.dar", "splice-api-token-allocation-instruction-v1-1.0.0.dar", "splice-test-token-v1-1.0.1.dar"]
INSTRUMENT = "TKB"
HOLDING_AMOUNT = "100.0"
ALLOCATED_AMOUNT = "10.0"
SLOT = 0   # TKA keeps its balances in the first state variable
NO_EXTRA_ARGS = {"context": {"values": {}}, "meta": {"values": {}}}


class Fail(Exception):
    pass


def env_file(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


class Network:
    """The three participants' Ledger APIs and the parties of this run."""

    def __init__(self):
        state = Path(os.environ.get("CZE_STATE_DIR", ROOT / "state"))
        self.state = state / "demo"
        self.parties = env_file(state / "canton" / "parties.env")
        self.urls = {"operator": os.environ.get("CZE_LEDGER_URL", "http://127.0.0.1:7575"),
                     "confirmer": os.environ.get("CZE_CONFIRMER_LEDGER_URL", "http://127.0.0.1:7576"),
                     "users": os.environ.get("CZE_USERS_LEDGER_URL", "http://127.0.0.1:7577")}

    def party(self, name: str) -> str:
        return self.parties[name.upper() + "_PARTY"]

    def post(self, node: str, path: str, body: dict):
        request = urllib.request.Request(self.urls[node] + path, json.dumps(body).encode(), {"content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise Fail(f"{path} on {node}: {e.code} {e.read().decode(errors='replace')[:800]}") from None

    def submit(self, node: str, acting: list, command: dict, disclosed: list = ()):
        body = {"commands": [command], "commandId": str(uuid.uuid4()), "userId": USER, "actAs": [self.party(p) for p in acting]}
        if disclosed:
            body["disclosedContracts"] = list(disclosed)
        return self.post(node, "/v2/commands/submit-and-wait", body)

    def active(self, node: str, party: str, identifier_filter: dict) -> list:
        """The active contracts of a template or interface that `party` sees on `node`, as their created events."""
        with urllib.request.urlopen(self.urls[node] + "/v2/state/ledger-end", timeout=60) as r:
            offset = json.load(r)["offset"]
        flt = {"cumulative": [{"identifierFilter": identifier_filter}]}
        body = {"eventFormat": {"filtersByParty": {self.party(party): flt}, "verbose": False}, "activeAtOffset": offset}
        found = self.post(node, "/v2/state/active-contracts", body)
        out = []
        for e in found:
            active = e["contractEntry"].get("JsActiveContract")
            if active:
                out.append({**active["createdEvent"], "synchronizerId": active.get("synchronizerId")})
        return out

    def template(self, node: str, party: str, template: str, blob: bool = False) -> list:
        return self.active(node, party, {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": blob}}})

    def wait_for(self, what: str, find, seconds: int = 60):
        """Another participant's commit reaches this one a moment later: look until `find` gives something."""
        deadline = time.time() + seconds
        while True:
            found = find()
            if found or time.time() > deadline:
                if not found:
                    raise Fail(f"timed out waiting for {what}")
                return found
            time.sleep(0.5)


def read_sums(folder: Path) -> dict:
    """daml/dars/SHA256SUMS: one "<sha256>  <file name>" per line."""
    pairs = (line.split() for line in (folder / "SHA256SUMS").read_text().splitlines() if line.strip())
    return {name.lstrip("*"): digest for digest, name in pairs}


def upload_dars(net: Network) -> dict:
    sums = read_sums(ROOT / "daml" / "dars")
    for name in EXTRA_DARS:
        data = (ROOT / "daml" / "dars" / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != sums[name]:
            raise Fail(f"{name} does not match daml/dars/SHA256SUMS")
        for node in net.urls:
            request = urllib.request.Request(net.urls[node] + "/v2/packages?vetAllPackages=true&synchronizeVetting=true", data, {"content-type": "application/octet-stream"})
            try:
                with urllib.request.urlopen(request, timeout=300) as r:
                    r.read()
            except urllib.error.HTTPError as e:
                raise Fail(f"uploading {name} to {node}: {e.code} {e.read().decode(errors='replace')[:500]}") from None
    return {"uploaded": EXTRA_DARS, "to": list(net.urls)}


def utc(offset: timedelta = timedelta()) -> str:
    return (datetime.now(timezone.utc) + offset).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def holdings(net: Network, who: str) -> list:
    """The amounts of the TKB holdings `who` has, as numbers (whole ones without a decimal point)."""
    amounts = sorted(float(e["createArgument"]["holding"]["amount"]) for e in net.template("users", who, TOKEN))
    return [int(a) if a.is_integer() else a for a in amounts]


def setup(net: Network) -> dict:
    registry, u = net.party("registry"), net.party("u")
    net.submit("users", ["registry"], {"CreateCommand": {"templateId": RULES, "createArguments": {"admin": registry}}})
    [rules] = net.wait_for("the token rules", lambda: net.template("users", "registry", RULES, blob=True))
    # U's first holding: signed by U and by the registry that issues it.
    net.submit("users", ["u", "registry"], {"CreateCommand": {"templateId": TOKEN, "createArguments": {"holding": {
        "owner": u, "instrumentId": {"admin": registry, "id": INSTRUMENT}, "amount": HOLDING_AMOUNT, "lock": None, "meta": {"values": {}}}}}})
    net.wait_for("U's holding", lambda: net.template("users", "u", TOKEN))
    disclosed = [{"templateId": rules["templateId"], "contractId": rules["contractId"], "createdEventBlob": rules["createdEventBlob"], "synchronizerId": rules["synchronizerId"]}]
    net.state.mkdir(parents=True, exist_ok=True)
    (net.state / "disclosed.json").write_text(json.dumps(disclosed))
    return {"rules": rules["contractId"], "uHolds": holdings(net, "u"), "disclosed": str(net.state / "disclosed.json")}


def dvp(net: Network, label: str, token: str, holder: str, expected_tokens: int) -> dict:
    u, v, registry = net.party("u"), net.party("v"), net.party("registry")
    disclosed = json.loads((net.state / "disclosed.json").read_text())
    rules = disclosed[0]["contractId"]
    inputs = [e["contractId"] for e in net.template("users", "u", TOKEN)]
    if not inputs:
        raise Fail("U has no TKB holding to allocate")
    before = {e["contractId"] for e in net.template("users", "u", ALLOCATION_OF_TOKEN)}
    leg = {"settlement": {"executor": net.party("operator"), "settlementRef": {"id": label, "cid": None}, "requestedAt": utc(timedelta(minutes=-1)),
                          "allocateBefore": utc(timedelta(hours=1)), "settleBefore": utc(timedelta(hours=2)), "meta": {"values": {}}},
           "transferLegId": "leg-" + label,
           "transferLeg": {"sender": u, "receiver": v, "amount": ALLOCATED_AMOUNT, "instrumentId": {"admin": registry, "id": INSTRUMENT}, "meta": {"values": {}}}}
    net.submit("users", ["u"], {"ExerciseCommand": {"templateId": ALLOCATION_FACTORY, "contractId": rules, "choice": "AllocationFactory_Allocate", "choiceArgument": {
        "expectedAdmin": registry, "allocation": leg, "requestedAt": utc(timedelta(minutes=-1)), "inputHoldingCids": inputs, "extraArgs": NO_EXTRA_ARGS}}}, disclosed)
    [allocation] = net.wait_for("the allocation", lambda: [e for e in net.template("users", "u", ALLOCATION_OF_TOKEN) if e["contractId"] not in before])
    expected = f"{expected_tokens * 10**18:064x}"
    net.submit("users", ["u", "v"], {"CreateCommand": {"templateId": CHAIN + "DvpTerms", "createArguments": {
        "u": u, "v": v, "operator": net.party("operator"), "confirmer": net.party("confirmer"), "builder": net.party("builder"),
        "chainId": os.environ.get("CZE_CHAIN_ID", "770101"), "token": token.lower().removeprefix("0x"), "holder": holder.lower().removeprefix("0x"),
        "slot": str(SLOT), "expected": expected, "allocation": allocation["contractId"]}}})
    terms = net.wait_for("the terms", lambda: [e for e in net.template("operator", "operator", CHAIN + "DvpTerms") if e["createArgument"]["allocation"] == allocation["contractId"]])
    return {"label": label, "allocation": allocation["contractId"], "terms": terms[0]["contractId"], "expected": expected}


def update_of(net: Network, node: str, party: str, event: dict) -> dict:
    """The update that created the contract of this created event, as `node` reports it to `party`: its id and its offset. The update is
    asked for by the event's offset, and it must list this very contract among the events it created."""
    offset = event.get("offset")
    if not isinstance(offset, int):
        raise Fail(f"the created event of {event['contractId'][:16]} has no offset")
    wildcard = [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]
    body = {"offset": offset, "updateFormat": {"includeTransactions": {
        "eventFormat": {"filtersByParty": {net.party(party): {"cumulative": wildcard}}, "verbose": False},
        "transactionShape": "TRANSACTION_SHAPE_ACS_DELTA"}}}
    found = net.post(node, "/v2/updates/update-by-offset", body)
    tx = found.get("update", {}).get("Transaction", {}).get("value")
    if not tx or not tx.get("updateId"):
        raise Fail(f"no transaction at offset {offset} on {node}: {json.dumps(found)[:300]}")
    created = [e["CreatedEvent"]["contractId"] for e in tx.get("events", []) if "CreatedEvent" in e]
    if event["contractId"] not in created:
        raise Fail(f"the update at offset {offset} on {node} did not create {event['contractId'][:16]}")
    return {"updateId": tx["updateId"], "offset": offset, "contract": event["contractId"]}


def settled(net: Network, number: int) -> dict:
    """Where the block's BlockRecord and V's newest TKB holding were made, both read on the users participant."""
    records = [e for e in net.template("users", "reader", CHAIN + "BlockRecord") if int(e["createArgument"]["number"]) == number]
    if len(records) != 1:
        raise Fail(f"expected one BlockRecord for block {number}, found {len(records)}")
    holdings_of_v = sorted(net.template("users", "v", TOKEN), key=lambda e: e["offset"])
    if not holdings_of_v:
        raise Fail("V has no TKB holding")
    return {"record": update_of(net, "users", "reader", records[0]), "holding": update_of(net, "users", "v", holdings_of_v[-1])}


def status(net: Network) -> dict:
    chain = net.template("operator", "operator", CHAIN + "ZkChain")
    records = net.template("users", "reader", CHAIN + "BlockRecord")
    return {
        "chain": [{"headNumber": int(c["createArgument"]["headNumber"]), "headHash": c["createArgument"]["headHash"]} for c in chain],
        "blockRecords": sorted(({"number": int(r["createArgument"]["number"]), "blockHash": r["createArgument"]["blockHash"],
                                 "proofSha256": hashlib.sha256(bytes.fromhex(r["createArgument"]["proofHex"])).hexdigest(),
                                 "proofHex": r["createArgument"]["proofHex"]} for r in records), key=lambda r: r["number"]),
        "tkb": {"u": holdings(net, "u"), "v": holdings(net, "v")},
        "allocations": sorted(e["createArgument"]["allocation"]["settlement"]["settlementRef"]["id"] for e in net.template("users", "u", ALLOCATION_OF_TOKEN)),
        "terms": len(net.template("operator", "operator", CHAIN + "DvpTerms")),
    }


def main(argv: list) -> dict:
    net = Network()
    if argv == ["upload-dars"]:
        return upload_dars(net)
    if argv == ["setup"]:
        return setup(net)
    if argv[:1] == ["dvp"] and len(argv) == 5 and argv[4].isdigit():
        return dvp(net, argv[1], argv[2], argv[3], int(argv[4]))
    if argv[:1] == ["settled"] and len(argv) == 2 and argv[1].isdigit():
        return settled(net, int(argv[1]))
    if argv == ["status"]:
        return status(net)
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        print(json.dumps(main(sys.argv[1:])))
    except Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
