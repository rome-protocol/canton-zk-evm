#!/usr/bin/env python3
"""The Canton side of the demo, through the participants' JSON Ledger API. See demo/README.md.

  canton.py upload-dars                load the token standard's factory and the test token (daml/dars) into all three participants
  canton.py setup                      the registry makes the TKB rules; U gets 100 TKB; the rules go to $CZE_STATE_DIR/demo/disclosed.json,
                                       the list of disclosed contracts that the builder takes with --disclosed
  canton.py register-token <address>   the wrapped token at that EVM address now stands for TKB: network/canton/propose.py token, with
                                       the registry and the rules from setup. The gateway must have made the token and Canton committed that block
  canton.py accept <u|v>               that party signs a standing acceptance of withdrawals from the gateway
  canton.py deposit <label> <address> <amount>
                                       U allocates <amount> TKB to the gateway (executor: the operator) and signs a deposit request for the EVM
                                       address <address>, with a new deposit id. Prints the id: the claim on the EVM must carry it
  canton.py dvp <label> <token> <payee> <amount>
                                       U allocates 10 TKB to V (executor: the operator, as the DvP's one leg U to V); then U and V sign
                                       DvpTerms: "if the gateway records a payment of <amount> TKA (a whole number) of <token> to <payee> with
                                       this id in the proven block, execute that allocation". Prints the id: V's pay on the EVM must carry it
  canton.py payment-id <label>         the payment id of U, V and that label: the SHA-256, in lowercase hex, of the UTF-8 bytes of "<U's party id>,<V's party id>,<label>"
  canton.py resubmit <advance.json>    send a block the builder saved (its block-N/advance.json) to Canton again, with the legs taken out. Demo
                                       only: it shows that a proven block is no good without the legs it recorded. Exits 2 if Canton refuses it
  canton.py settled <block number> [u|v|gateway]
                                       the Canton update that created that block's BlockRecord, and the one that created the newest TKB
                                       holding of that party (V if none is named), each as one participant reports it (update id, offset,
                                       the contract made): the users participant for U and V, the operator's for the gateway. The runs check
                                       that the two are the same update: the block and the Canton token move together.
  canton.py withdraw-allocation <label>
                                       U takes back its allocation with that label (the token standard's own withdrawal, by its sender).
                                       Demo only: it is how the fourth run takes the Canton side away after a block was proven
  canton.py status                     print what is on Canton now: the chain head, the block records, the TKB holdings of U and V and
                                       of the gateway (its custody), the active allocations, terms, deposit requests and acceptances

TKB is the Canton-side test token (the Splice reference token); TKA is the EVM-side one. The network runs without Ledger
API authentication (network/README.md), so one Ledger API user, `demo`, acts for U, V and the registry together here; `resubmit` acts as
the builder's own user. Settings: CZE_STATE_DIR, CZE_LEDGER_URL (operator, 7575), CZE_CONFIRMER_LEDGER_URL (7576),
CZE_USERS_LEDGER_URL (7577), and for register-token also RETH_HTTP_PORT (8545).
"""
import hashlib, json, os, re, secrets, subprocess, sys, time, urllib.error, urllib.request, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USER = "demo"
CHAIN = "#canton-zk-evm:Zk.Chain:"
TOKEN = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:Token"
RULES = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenRules"
ALLOCATION_OF_TOKEN = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenAllocation"
ALLOCATION_INTERFACE = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation"
ALLOCATION_FACTORY = "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory"
DVP_TERMS, DEPOSIT_REQUEST, ACCEPTANCE = CHAIN + "DvpTerms", CHAIN + "DepositRequest", CHAIN + "WithdrawalAcceptance"
EXTRA_DARS = ["splice-api-token-transfer-instruction-v1-1.0.0.dar", "splice-api-token-allocation-instruction-v1-1.0.0.dar", "splice-test-token-v1-1.0.1.dar"]
INSTRUMENT = "TKB"
HOLDING_AMOUNT = "100.0"
ALLOCATED_AMOUNT = "10.0"
NO_EXTRA_ARGS = {"context": {"values": {}}, "meta": {"values": {}}}
PROPOSE = ROOT / "network" / "canton" / "propose.py"
ADVANCE_FIELDS = ("headerHex", "txsHex", "proofHex", "gatewayAccountNodes", "gatewayStorageNodes", "legs")
ADDRESS = re.compile(r"(?:0x)?[0-9a-fA-F]{40}")
CANTON_AMOUNT = re.compile(r"[0-9]+(?:\.[0-9]{1,10})?")   # as a Daml Decimal that the gateway's 10-decimal wrapped token can hold exactly
WHOLE = re.compile(r"[0-9]+")
HOLDER_NODES = {"u": ("users", "reader"), "v": ("users", "reader"), "gateway": ("operator", "operator")}   # holder -> (participant, party that reads the BlockRecord there)


class Fail(Exception):
    pass


class Refused(Fail):
    """Canton answered a command with an error: it refused it."""


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
            with e:
                raise Refused(f"{path} on {node}: {e.code} {e.read().decode(errors='replace')[:800]}") from None

    def submit(self, node: str, acting: list, command: dict, disclosed: list = (), user: str = USER):
        body = {"commands": [command], "commandId": str(uuid.uuid4()), "userId": user, "actAs": [self.party(p) for p in acting]}
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


def holdings(net: Network, who: str, node: str = "users") -> list:
    """The amounts of the TKB holdings `who` has, as numbers (whole ones without a decimal point), on the participant that hosts `who`."""
    amounts = sorted(float(e["createArgument"]["holding"]["amount"]) for e in net.template(node, who, TOKEN))
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


def chain_record(net: Network) -> dict:
    """The chain's state contract as the operator sees it: its id and fields (the chain id, the parties, the gateway)."""
    found = net.template("operator", "operator", CHAIN + "ZkChain")
    if len(found) != 1:
        raise Fail(f"expected one chain on the operator's participant, found {len(found)}")
    return {"contractId": found[0]["contractId"], **found[0]["createArgument"]}


def payment_id(u: str, v: str, label: str) -> str:
    """The EVM payment id of terms between u and v: the SHA-256, in lowercase hex, of the UTF-8 text "<u>,<v>,<label>". It is what
    Daml's `paymentId` makes, and what the template's `ensure` demands of `dvpId`. The EVM `pay` must send these 32 bytes."""
    return hashlib.sha256(f"{u},{v},{label}".encode("utf-8")).hexdigest()


def evm_address(value: str) -> str:
    """An EVM address as the Daml templates write it: 40 lowercase hex digits, no 0x."""
    if not ADDRESS.fullmatch(value):
        raise SystemExit(f"not an EVM address: {value!r}")
    return value.lower().removeprefix("0x")


def read_label(label: str) -> str:
    if not label:
        raise SystemExit("the label must not be empty")
    return label


def read_disclosed(net: Network) -> list:
    path = net.state / "disclosed.json"
    if not path.exists():
        raise Fail(f"no {path}: run `canton.py setup` first")
    return json.loads(path.read_text())


def allocate(net: Network, label: str, receiver: str, amount: str) -> dict:
    """U allocates `amount` TKB to `receiver` through the token standard's factory, with the operator as executor. The token registry's
    rules contract goes with the call as a disclosed contract, because U is not a stakeholder of it. Gives the new allocation."""
    u, registry = net.party("u"), net.party("registry")
    disclosed = read_disclosed(net)
    inputs = [e["contractId"] for e in net.template("users", "u", TOKEN)]
    if not inputs:
        raise Fail("U has no TKB holding to allocate")
    before = {e["contractId"] for e in net.template("users", "u", ALLOCATION_OF_TOKEN)}
    leg = {"settlement": {"executor": net.party("operator"), "settlementRef": {"id": label, "cid": None}, "requestedAt": utc(timedelta(minutes=-1)),
                          "allocateBefore": utc(timedelta(hours=1)), "settleBefore": utc(timedelta(hours=2)), "meta": {"values": {}}},
           "transferLegId": "leg-" + label,
           "transferLeg": {"sender": u, "receiver": receiver, "amount": amount, "instrumentId": {"admin": registry, "id": INSTRUMENT}, "meta": {"values": {}}}}
    net.submit("users", ["u"], {"ExerciseCommand": {"templateId": ALLOCATION_FACTORY, "contractId": disclosed[0]["contractId"], "choice": "AllocationFactory_Allocate", "choiceArgument": {
        "expectedAdmin": registry, "allocation": leg, "requestedAt": utc(timedelta(minutes=-1)), "inputHoldingCids": inputs, "extraArgs": NO_EXTRA_ARGS}}}, disclosed)
    [allocation] = net.wait_for("the allocation", lambda: [e for e in net.template("users", "u", ALLOCATION_OF_TOKEN) if e["contractId"] not in before])
    return allocation


def propose_arguments(net: Network, token: str) -> list:
    """The command line of `propose.py token` that registers the wrapped token at this EVM address for TKB, whose transfer factory is the rules."""
    return ["token", "--evm-token", evm_address(token), "--instrument-admin", net.party("registry"), "--instrument-id", INSTRUMENT,
            "--factory", read_disclosed(net)[0]["contractId"]]


def register_token(net: Network, token: str) -> dict:
    arguments = propose_arguments(net, token)
    done = subprocess.run([sys.executable, str(PROPOSE), *arguments], capture_output=True, text=True, timeout=600)
    if done.returncode != 0:
        raise Fail(f"propose.py token stopped ({done.returncode}): {(done.stderr or done.stdout).strip()[-800:]}")
    return json.loads(done.stdout.strip().splitlines()[-1])


def accept(net: Network, who: str) -> dict:
    if who not in ("u", "v"):
        raise SystemExit(f"only u and v can accept withdrawals here, not {who!r}")
    chain, party = chain_record(net), net.party(who)
    mine = lambda: [e for e in net.template("operator", "operator", ACCEPTANCE) if e["createArgument"]["party"] == party]
    before = {e["contractId"] for e in mine()}
    net.submit("users", [who], {"CreateCommand": {"templateId": ACCEPTANCE, "createArguments": {
        "party": party, "chainId": chain["chainId"], "operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"]}}})
    # The builder looks for it on the operator's participant.
    [made] = net.wait_for("the acceptance", lambda: [e for e in mine() if e["contractId"] not in before])
    return {"party": party, "acceptance": made["contractId"]}


def deposit(net: Network, label: str, recipient: str, amount: str) -> dict:
    """U allocates `amount` TKB to the gateway and signs a request to deposit it for the EVM address `recipient`, with a new deposit id."""
    read_label(label)
    if not CANTON_AMOUNT.fullmatch(amount) or float(amount) == 0:
        raise SystemExit(f"the amount must be more than zero, with at most 10 decimals: {amount!r}")
    address = evm_address(recipient)
    chain = chain_record(net)
    allocation = allocate(net, label, chain["gateway"], amount if "." in amount else amount + ".0")
    deposit_id = secrets.token_hex(32)
    net.submit("users", ["u"], {"CreateCommand": {"templateId": DEPOSIT_REQUEST, "createArguments": {
        "operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"], "chainId": chain["chainId"],
        "depositor": net.party("u"), "depositId": deposit_id, "recipient": address, "allocation": allocation["contractId"]}}})
    [request] = net.wait_for("the deposit request", lambda: [e for e in net.template("operator", "operator", DEPOSIT_REQUEST) if e["createArgument"]["depositId"] == deposit_id])
    return {"label": label, "depositId": deposit_id, "recipient": "0x" + address, "allocation": allocation["contractId"], "request": request["contractId"]}


def dvp(net: Network, label: str, token: str, payee: str, tokens: int) -> dict:
    """U allocates 10 TKB to V; U and V sign the terms for a payment of `tokens` whole TKA of `token` to `payee` with the id of U, V and `label`."""
    read_label(label)
    token, payee = evm_address(token), evm_address(payee)
    if tokens <= 0:
        raise SystemExit("the amount must be more than zero")
    chain, u, v = chain_record(net), net.party("u"), net.party("v")
    allocation = allocate(net, label, v, ALLOCATED_AMOUNT)
    dvp_id = payment_id(u, v, label)
    net.submit("users", ["u", "v"], {"CreateCommand": {"templateId": DVP_TERMS, "createArguments": {
        "u": u, "v": v, "operator": chain["operator"], "confirmer": chain["confirmer"], "builder": chain["builder"], "chainId": chain["chainId"],
        "label": label, "dvpId": dvp_id, "token": token, "payee": payee, "amount": f"{tokens * 10**18:064x}", "allocation": allocation["contractId"]}}})
    [terms] = net.wait_for("the terms", lambda: [e for e in net.template("operator", "operator", DVP_TERMS) if e["createArgument"]["allocation"] == allocation["contractId"]])
    return {"label": label, "id": dvp_id, "allocation": allocation["contractId"], "terms": terms["contractId"]}


def resubmit(net: Network, path: str) -> dict:
    """Sends the Advance the builder saved to Canton again, with `legs` empty and everything else as it was sent. The proof, the header and
    the gateway's proofs are all still good, but the block recorded legs that are no longer attached, so Canton must refuse it."""
    try:
        argument = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise Fail(f"cannot read {path}: {e}") from None
    if not isinstance(argument, dict) or any(k not in argument for k in ADVANCE_FIELDS) or not isinstance(argument["legs"], list):
        raise Fail(f"{path} is not the argument of an Advance: it needs {', '.join(ADVANCE_FIELDS)}")
    if not argument["legs"]:
        raise Fail(f"{path} has no legs: sent again it is the same block, and Canton would commit it outside the builder")
    command = {"ExerciseCommand": {"templateId": CHAIN + "ZkChain", "contractId": chain_record(net)["contractId"], "choice": "Advance", "choiceArgument": {**argument, "legs": []}}}
    try:
        net.submit("operator", ["builder"], command, user="builder")
    except Refused as e:
        return {"committed": False, "reason": str(e)[:600]}
    return {"committed": True}


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


def settled(net: Network, number: int, holder: str = "v") -> dict:
    """Where the block's BlockRecord and the holder's newest TKB holding were made, both read on one participant: the users participant
    for U and V, the operator's for the gateway (which it hosts). Offsets are a participant's own, so only two read there can be compared."""
    if holder not in HOLDER_NODES:
        raise SystemExit(f"the holder must be one of {', '.join(HOLDER_NODES)}, not {holder!r}")
    node, reader = HOLDER_NODES[holder]
    records = [e for e in net.template(node, reader, CHAIN + "BlockRecord") if int(e["createArgument"]["number"]) == number]
    if len(records) != 1:
        raise Fail(f"expected one BlockRecord for block {number}, found {len(records)}")
    held = sorted(net.template(node, holder, TOKEN), key=lambda e: e["offset"])
    if not held:
        raise Fail(f"{holder} has no TKB holding")
    return {"record": update_of(net, node, reader, records[0]), "holding": update_of(net, node, holder, held[-1])}


def withdraw_allocation(net: Network, label: str) -> dict:
    """U withdraws its allocation with this label, as the token standard lets its sender do until the block that settles it commits."""
    read_label(label)
    found = [e for e in net.template("users", "u", ALLOCATION_OF_TOKEN) if e["createArgument"]["allocation"]["settlement"]["settlementRef"]["id"] == label]
    if len(found) != 1:
        raise Fail(f"expected one allocation of U's with the label {label!r}, found {len(found)}")
    cid = found[0]["contractId"]
    net.submit("users", ["u"], {"ExerciseCommand": {"templateId": ALLOCATION_INTERFACE, "contractId": cid, "choice": "Allocation_Withdraw",
                                                     "choiceArgument": {"extraArgs": NO_EXTRA_ARGS}}})
    net.wait_for("the allocation to be gone", lambda: not [e for e in net.template("users", "u", ALLOCATION_OF_TOKEN) if e["contractId"] == cid] or None)
    # The operator is the allocation's executor and the builder submits there: wait for it to see the allocation gone too.
    net.wait_for("the allocation to be gone on the operator's participant",
                 lambda: not [e for e in net.template("operator", "operator", ALLOCATION_OF_TOKEN) if e["contractId"] == cid] or None)
    return {"label": label, "withdrawn": cid}


def status(net: Network) -> dict:
    chain = net.template("operator", "operator", CHAIN + "ZkChain")
    records = net.template("users", "reader", CHAIN + "BlockRecord")
    return {
        "chain": [{"headNumber": int(c["createArgument"]["headNumber"]), "headHash": c["createArgument"]["headHash"]} for c in chain],
        "blockRecords": sorted(({"number": int(r["createArgument"]["number"]), "blockHash": r["createArgument"]["blockHash"],
                                 "proofSha256": hashlib.sha256(bytes.fromhex(r["createArgument"]["proofHex"])).hexdigest(),
                                 "proofHex": r["createArgument"]["proofHex"]} for r in records), key=lambda r: r["number"]),
        "tkb": {"u": holdings(net, "u"), "v": holdings(net, "v")},
        "custody": holdings(net, "gateway", "operator"),   # the gateway party is hosted on the operator's participant
        "allocations": sorted(e["createArgument"]["allocation"]["settlement"]["settlementRef"]["id"] for e in net.template("users", "u", ALLOCATION_OF_TOKEN)),
        "terms": len(net.template("operator", "operator", DVP_TERMS)),
        "deposits": len(net.template("operator", "operator", DEPOSIT_REQUEST)),
        "acceptances": len(net.template("operator", "operator", ACCEPTANCE)),
    }


def main(argv: list) -> dict:
    net = Network()
    n, cmd = len(argv), argv[:1]
    if argv == ["upload-dars"]:
        return upload_dars(net)
    if argv == ["setup"]:
        return setup(net)
    if cmd == ["register-token"] and n == 2:
        return register_token(net, argv[1])
    if cmd == ["accept"] and n == 2:
        return accept(net, argv[1])
    if cmd == ["deposit"] and n == 4:
        return deposit(net, argv[1], argv[2], argv[3])
    if cmd == ["dvp"] and n == 5 and WHOLE.fullmatch(argv[4]):
        return dvp(net, argv[1], argv[2], argv[3], int(argv[4]))
    if cmd == ["payment-id"] and n == 2:
        return {"label": argv[1], "id": payment_id(net.party("u"), net.party("v"), read_label(argv[1]))}
    if cmd == ["resubmit"] and n == 2:
        return resubmit(net, argv[1])
    if cmd == ["settled"] and n in (2, 3) and WHOLE.fullmatch(argv[1]):
        return settled(net, int(argv[1]), *argv[2:])
    if cmd == ["withdraw-allocation"] and n == 2:
        return withdraw_allocation(net, argv[1])
    if argv == ["status"]:
        return status(net)
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
    sys.exit(2 if result.get("committed") is False else 0)   # resubmit: 2 when Canton refuses the block, as the builder does
