#!/usr/bin/env python3
"""The Canton side of the demo, through the participants' JSON Ledger API. See demo/README.md.

  canton.py upload-dars                load the token standard's factory and the test token (daml/dars) into all three participants. With
                                       CZE_CANTON=external: only the test token's DAR, to the one participant, then check that the participant
                                       vets it (it needs the admin token)
  canton.py setup                      the registry makes the TKB rules; U gets 100 TKB; the rules go to $CZE_STATE_DIR/demo/disclosed.json,
                                       the list of disclosed contracts that the builder takes with --disclosed
  canton.py register-token <address>   the wrapped token at that EVM address now stands for TKB: network/canton/propose.py token, with
                                       the registry and the rules from setup. The gateway must have made the token and Canton committed that block
  canton.py accept <u|v>               that party signs a standing acceptance of withdrawals from the gateway
  canton.py deposit <label> <address> <amount>
                                       U allocates <amount> TKB to the gateway (executor: the operator) and signs a deposit request for the EVM
                                       address <address>, with the deposit id derived from U and <label>. Prints the id: the claim on the EVM must carry it
                                       (each label makes one id and the gateway takes an id once, so a label serves one deposit of U)
  canton.py dvp <label> <token> <payee> <amount>
                                       U allocates 10 TKB to V (executor: the operator, as the DvP's one leg U to V); then U and V sign
                                       DvpTerms: "if the gateway records a payment of <amount> TKA (a whole number) of <token> to <payee> with
                                       this id in the proven block, execute that allocation". Prints the id: V's pay on the EVM must carry it
  canton.py payment-id <label>         the payment id of U, V and that label: the SHA-256, in lowercase hex, of the UTF-8 bytes of "<U's party id>,<V's party id>,<label>"
  canton.py return-tkb <label> <amount>
                                       V sends U <amount> TKB by the token standard's plain transfer (the transfer factory is the token rules; U
                                       accepts the offer if the token makes one). It is how the live cycle gives U the TKB that a payment moved to V
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
  canton.py registered <address>       whether the wrapped token at that EVM address is registered for TKB (a GatewayToken the operator sees),
                                       and whether it is proposed (a proposal that the confirmer has not accepted yet: register-token accepts it)
  canton.py accepted <u|v>             whether that party's own acceptance of withdrawals is there (not another party's on the participant)
  canton.py block <block number> [u|v|gateway]
                                       the chain's head, and that block's BlockRecord (hash, the proof's SHA-256), without the other blocks' proofs.
                                       With a party the record is read from the update that made that party's newest TKB holding: one small read,
                                       whatever the size of the chain. Without, every BlockRecord is read (they all stay active)
  canton.py balances                   status without the chain head and the block records: the TKB holdings, the custody, the allocations,
                                       terms, deposit requests and acceptances (a chain with many blocks has many records)
  canton.py status                     print what is on Canton now: the chain head, the block records, the TKB holdings of U and V and
                                       of the gateway (its custody), the active allocations, terms, deposit requests and acceptances

TKB is the Canton-side test token (the Splice reference token); TKA is the EVM-side one. The local network runs without Ledger
API authentication (network/README.md), so one Ledger API user, `demo`, acts for U, V and the registry together here; `resubmit` acts as
the builder's own user. Settings: CZE_STATE_DIR, CZE_LEDGER_URL (operator, 7575), CZE_CONFIRMER_LEDGER_URL (7576),
CZE_USERS_LEDGER_URL (7577), and for register-token also RETH_HTTP_PORT (8545) or CZE_RPC_URL.

On an existing participant (network/external/, network/README.md) set CZE_CANTON=external: CZE_LEDGER_URL is then the one Ledger API for
all three roles (https, or http on this machine; the other two URL settings are not used), CZE_USER_PREFIX goes before the Ledger API user
ids (demo, builder), and CZE_TOKEN_FILE_<ROLE> names a file, mode 0600, with that user's bearer token: DEMO (U, V and the registry),
OPERATOR (the operator and the gateway), READER, BUILDER (resubmit), CONFIRMER (register-token) and ADMIN (upload-dars). A token is read
from its file at every call, so a short-lived one can be written again between calls, and it is never printed. CZE_LEDGER_NO_AUTH=1: a Ledger API
with no login (no token is sent). Everything else is as on the local network; CZE_CANTON unset or `local` changes nothing.
"""
import hashlib, io, json, os, re, secrets, subprocess, sys, time, urllib.error, urllib.request, uuid, zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "network" / "canton"))
import propose   # read_token and auth: the token files are read as propose.py reads them
USER = "demo"
CHAIN = "#canton-zk-evm:Zk.Chain:"
TOKEN = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:Token"
RULES = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenRules"
ALLOCATION_OF_TOKEN = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenAllocation"
ALLOCATION_INTERFACE = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation"
TRANSFER_FACTORY = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory"
TRANSFER_INSTRUCTION = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction"
TRANSFER_OFFER = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1:TokenTransferOffer"
ALLOCATION_FACTORY = "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory"
DVP_TERMS, DEPOSIT_REQUEST, ACCEPTANCE = CHAIN + "DvpTerms", CHAIN + "DepositRequest", CHAIN + "WithdrawalAcceptance"
TEST_TOKEN_DAR = "splice-test-token-v1-1.0.1.dar"
EXTRA_DARS = ["splice-api-token-transfer-instruction-v1-1.0.0.dar", "splice-api-token-allocation-instruction-v1-1.0.0.dar", TEST_TOKEN_DAR]
UPLOAD_PATH = "/v2/packages?vetAllPackages=true&synchronizeVetting=true"
# The role (the name of the token file, CZE_TOKEN_FILE_<ROLE>, and of the Ledger API user, after CZE_USER_PREFIX) that reads and acts for each party.
ROLE_OF_PARTY = {"u": "demo", "v": "demo", "registry": "demo", "operator": "operator", "gateway": "operator", "reader": "reader", "builder": "builder", "confirmer": "confirmer"}
# What each command needs of the participant, so that a missing or unsafe token file stops it before anything is sent.
COMMAND_ROLES = {"upload-dars": ("admin",), "setup": ("demo",), "payment-id": (), "registered": ("operator",), "accepted": ("operator",), "register-token": ("operator", "confirmer"),
                 "accept": ("demo", "operator"), "withdraw-allocation": ("demo", "operator"), "resubmit": ("operator", "builder")}
DEFAULT_ROLES = ("demo", "operator", "reader")
# As network/external/setup.py: a token must not cross a network in the clear.
LOOPBACK_OR_HTTPS = re.compile(r"^(https://[^/]+|http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?)(/.*)?$")
# The seconds to wait before each repeat of a submit that got no answer: 4 tries over about a minute.
SUBMIT_RETRY_WAITS = (5, 15, 30)
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
    """Canton answered a command with an error: it refused it. `status` is the HTTP status."""
    status = None


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
        mode = os.environ.get("CZE_CANTON", "local")
        if mode not in ("local", "external"):
            raise SystemExit(f"CZE_CANTON must be local or external, not {mode!r}")
        self.external = mode == "external"
        if self.external:
            url = os.environ.get("CZE_LEDGER_URL", "")
            if not url:
                raise SystemExit("CZE_CANTON=external needs CZE_LEDGER_URL, the participant's JSON Ledger API")
            if not LOOPBACK_OR_HTTPS.match(url):
                raise SystemExit("the Ledger API URL must be https, or http on this machine (127.0.0.1): a token must not cross a network in the clear")
            self.urls = {node: url.rstrip("/") for node in ("operator", "confirmer", "users")}
        else:
            self.urls = {"operator": os.environ.get("CZE_LEDGER_URL", "http://127.0.0.1:7575"),
                         "confirmer": os.environ.get("CZE_CONFIRMER_LEDGER_URL", "http://127.0.0.1:7576"),
                         "users": os.environ.get("CZE_USERS_LEDGER_URL", "http://127.0.0.1:7577")}

    def party(self, name: str) -> str:
        return self.parties[name.upper() + "_PARTY"]

    def user(self, role: str) -> str:
        """The Ledger API user id of a role: after CZE_USER_PREFIX on an existing participant, as it is on the local network."""
        return os.environ.get("CZE_USER_PREFIX", "") + role if self.external else role

    def token(self, role: str):
        """The bearer token of a role, read from its file now (never kept, never printed); None on the local network and with CZE_LEDGER_NO_AUTH=1."""
        if not self.external:
            return None
        var = "CZE_TOKEN_FILE_" + role.upper()
        path = os.environ.get(var)
        if path:
            return propose.read_token(path)
        if os.environ.get("CZE_LEDGER_NO_AUTH") == "1":
            return None
        raise Fail(f"{var} is not set: a file with the {role} user's token (mode 0600), or CZE_LEDGER_NO_AUTH=1 for a Ledger API with no login")

    def check_roles(self, roles) -> None:
        """Reads the token files of these roles, so that a missing or unsafe one stops the command before it sends anything."""
        for role in roles:
            self.token(role)

    def headers(self, role: str, extra: dict = None) -> dict:
        return {**(extra or {}), **propose.auth(self.token(role))}

    def get(self, node: str, path: str, role: str):
        request = urllib.request.Request(self.urls[node] + path, headers=self.headers(role))
        try:
            with urllib.request.urlopen(request, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            with e:
                raise self.refused(path, node, e) from None

    def post(self, node: str, path: str, body, role: str, content_type: str = "application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        request = urllib.request.Request(self.urls[node] + path, data, self.headers(role, {"content-type": content_type}))
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            with e:
                raise self.refused(path, node, e) from None

    @staticmethod
    def refused(path: str, node: str, e: urllib.error.HTTPError) -> Refused:
        text = e.read().decode(errors="replace")
        err = Refused(f"{path} on {node}: {e.code} {text[:800]}")
        err.status = e.code
        try:
            err.code = json.loads(text).get("code")   # the error code of the Ledger API's JSON answer, when it has one
        except (ValueError, AttributeError):
            err.code = None
        return err

    def submit(self, node: str, acting: list, command: dict, disclosed: list = (), user: str = USER):
        """Sends one command and waits for its commit. The command id is made once, so a try that ends with no answer (HTTP 503 "not able to produce a
        timely response", or a read timeout of the request) is sent again with the same body and the same id, SUBMIT_RETRY_WAITS apart, as often as that
        tuple has entries. The participant may have committed the first try; it knows the id, so the repeat is answered DUPLICATE_COMMAND (HTTP 409,
        on the code, not the text): that counts as committed, and the answer is {"duplicate": True}, as a duplicate carries no events. A repeat that finds
        the first try still running (SUBMISSION_ALREADY_IN_FLIGHT) waits and asks again. Every other error is raised at once."""
        body = {"commands": [command], "commandId": str(uuid.uuid4()), "userId": self.user(user), "actAs": [self.party(p) for p in acting]}
        if disclosed:
            body["disclosedContracts"] = list(disclosed)
        for attempt, wait in enumerate(SUBMIT_RETRY_WAITS + (None,)):
            try:
                return self.post(node, "/v2/commands/submit-and-wait", body, user)
            except Refused as e:
                if e.code == "DUPLICATE_COMMAND" and attempt:
                    print(f"submit: the command id of try {attempt} is known to the participant: it committed", file=sys.stderr)
                    return {"duplicate": True}
                if wait is None or not (e.status == 503 or (attempt and e.code == "SUBMISSION_ALREADY_IN_FLIGHT")):
                    raise
                why = f"{e.status} {e.code or ''}".strip()
            except (TimeoutError, urllib.error.URLError) as e:
                if wait is None or not (isinstance(e, TimeoutError) or isinstance(e.reason, TimeoutError)):
                    raise
                why = "read timeout"
            print(f"submit: try {attempt + 1} of {len(SUBMIT_RETRY_WAITS) + 1} on {node} got {why}; sending it again with the same command id in {wait} s", file=sys.stderr)
            time.sleep(wait)

    def active(self, node: str, party: str, identifier_filter: dict) -> list:
        """The active contracts of a template or interface that `party` sees on `node`, as their created events."""
        role = ROLE_OF_PARTY[party]
        offset = self.get(node, "/v2/state/ledger-end", role)["offset"]
        flt = {"cumulative": [{"identifierFilter": identifier_filter}]}
        body = {"eventFormat": {"filtersByParty": {self.party(party): flt}, "verbose": False}, "activeAtOffset": offset}
        found = self.post(node, "/v2/state/active-contracts", body, role)
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


def checked_dar(name: str) -> bytes:
    """A DAR of daml/dars, as long as it is the one daml/dars/SHA256SUMS names."""
    data = (ROOT / "daml" / "dars" / name).read_bytes()
    if hashlib.sha256(data).hexdigest() != read_sums(ROOT / "daml" / "dars").get(name):
        raise Fail(f"{name} does not match daml/dars/SHA256SUMS")
    return data


def dar_package_id(data: bytes, name: str) -> str:
    """The id of a DAR's main package: the 64 hex digits that end the name of the Main-Dalf in its manifest (network/canton/dar-id.sh)."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            manifest = z.read("META-INF/MANIFEST.MF").decode("utf-8", "replace").replace("\r", "").replace("\n ", "")
    except (zipfile.BadZipFile, KeyError):
        raise Fail(f"{name} is not a DAR") from None
    found = re.search(r"^Main-Dalf: *.*-([0-9a-f]{64})\.dalf$", manifest, re.MULTILINE)
    if not found:
        raise Fail(f"no main package id in the manifest of {name}")
    return found.group(1)


def vetted_here(net: Network, package_id: str) -> bool:
    """Whether THIS participant vets the package on a synchronizer it is connected to (POST /v2/package-vetting/list, as network/external/setup.py asks).
    The vetting of another participant on the synchronizer does not count."""
    me = net.get("operator", "/v2/parties/participant-id", "admin").get("participantId")
    if not me:
        raise Fail("the participant does not say its id (GET /v2/parties/participant-id), so its vetting cannot be checked")
    connected = [s["synchronizerId"] for s in net.get("operator", "/v2/state/connected-synchronizers", "admin").get("connectedSynchronizers", [])]
    try:
        answer = net.post("operator", "/v2/package-vetting/list", {"packageMetadataFilter": {"packageIds": [package_id], "packageNamePrefixes": []},
                                                                     "topologyStateFilter": {"participantIds": [me], "synchronizerIds": []}}, "admin")
    except Refused as e:
        if e.status == 404:
            raise Fail("the participant offers no vetting list (POST /v2/package-vetting/list), so the vetting of the test token cannot be confirmed") from None
        raise
    return any(v.get("synchronizerId") in connected and v.get("participantId", me) == me and any(p.get("packageId") == package_id for p in v.get("packages", []))
               for v in answer.get("vettedPackages", []))


def upload_test_token(net: Network) -> dict:
    """On an existing participant: only the test token's DAR (the token standard's own packages are the participant's already), once, unless this
    participant vets it already; then the vetting is confirmed, which is what the DAR upload with vetAllPackages and synchronizeVetting asked for."""
    data = checked_dar(TEST_TOKEN_DAR)
    package_id = dar_package_id(data, TEST_TOKEN_DAR)
    if vetted_here(net, package_id):
        return {"uploaded": [], "vetted": True, "package": package_id, "to": ["participant"]}
    net.post("operator", UPLOAD_PATH, data, "admin", "application/octet-stream")
    net.wait_for("the test token to be vetted", lambda: vetted_here(net, package_id), 60)
    return {"uploaded": [TEST_TOKEN_DAR], "vetted": True, "package": package_id, "to": ["participant"]}


def upload_dars(net: Network) -> dict:
    if net.external:
        return upload_test_token(net)
    sums = read_sums(ROOT / "daml" / "dars")
    for name in EXTRA_DARS:
        data = (ROOT / "daml" / "dars" / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != sums[name]:
            raise Fail(f"{name} does not match daml/dars/SHA256SUMS")
        for node in net.urls:
            request = urllib.request.Request(net.urls[node] + UPLOAD_PATH, data, {"content-type": "application/octet-stream"})
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
    """The registry's rules and U's first holding, each made only if it is not there: a second run (or one after a stop half way) changes nothing
    that is complete. A second set of rules would be a second token, so more than one is refused."""
    registry, u = net.party("registry"), net.party("u")
    found = net.template("users", "registry", RULES, blob=True)
    if len(found) > 1:
        raise Fail(f"the registry has {len(found)} sets of token rules: there must be one")
    if not found:
        net.submit("users", ["registry"], {"CreateCommand": {"templateId": RULES, "createArguments": {"admin": registry}}})
    [rules] = net.wait_for("the token rules", lambda: net.template("users", "registry", RULES, blob=True))
    # U's first holding: signed by U and by the registry that issues it.
    if not net.template("users", "u", TOKEN):
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


def deposit_id_of(depositor: str, label: str) -> str:
    """The EVM claim id of a deposit: the SHA-256, in lowercase hex, of the UTF-8 text "deposit,<depositor party id>,<label>". It is what
    Daml's `depositIdOf` makes, and what the `DepositRequest`'s `ensure` demands of `depositId` and `label`."""
    return hashlib.sha256(f"deposit,{depositor},{label}".encode("utf-8")).hexdigest()


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


def allocate(net: Network, label: str, receiver: str, amount: str, spec: dict = None, who: str = "u") -> dict:
    """U allocates `amount` TKB to `receiver` through the token standard's factory, with the operator as executor. The token registry's
    rules contract goes with the call as a disclosed contract, because U is not a stakeholder of it. Gives the new allocation. With `spec` (an
    AllocationSpecification, with its own executor and leg) it makes that allocation as the party `who` instead: demo/otc.py allocates a trade's."""
    u, registry = net.party(who), net.party("registry")
    disclosed = read_disclosed(net)
    inputs = [e["contractId"] for e in net.template("users", who, TOKEN)]
    if not inputs:
        raise Fail(f"{who.upper()} has no TKB holding to allocate")
    before = {e["contractId"] for e in net.template("users", who, ALLOCATION_OF_TOKEN)}
    requested = utc(timedelta(minutes=-1))
    if spec is None:
        spec = {"settlement": {"executor": net.party("operator"), "settlementRef": {"id": label, "cid": None}, "requestedAt": requested,
                               "allocateBefore": utc(timedelta(hours=1)), "settleBefore": utc(timedelta(hours=2)), "meta": {"values": {}}},
                "transferLegId": "leg-" + label,
                "transferLeg": {"sender": u, "receiver": receiver, "amount": amount, "instrumentId": {"admin": registry, "id": INSTRUMENT}, "meta": {"values": {}}}}
    else:
        requested = spec["settlement"]["requestedAt"]
    net.submit("users", [who], {"ExerciseCommand": {"templateId": ALLOCATION_FACTORY, "contractId": disclosed[0]["contractId"], "choice": "AllocationFactory_Allocate", "choiceArgument": {
        "expectedAdmin": registry, "allocation": spec, "requestedAt": requested, "inputHoldingCids": inputs, "extraArgs": NO_EXTRA_ARGS}}}, disclosed)
    [allocation] = net.wait_for("the allocation", lambda: [e for e in net.template("users", who, ALLOCATION_OF_TOKEN) if e["contractId"] not in before])
    return allocation


def propose_arguments(net: Network, token: str, instrument: dict = None, factory: str = None) -> list:
    """The command line of `propose.py token` that registers the wrapped token at this EVM address for TKB, whose transfer factory is the rules. demo/cc.py registers the
    token of another instrument ({admin, id}) with the factory that instrument's registry names."""
    rpc = ["--reth-url", os.environ["CZE_RPC_URL"]] if os.environ.get("CZE_RPC_URL") else []   # the chain's RPC, if it is not on this machine's reth port
    instrument = instrument or {"admin": net.party("registry"), "id": INSTRUMENT}
    return ["token", "--evm-token", evm_address(token), "--instrument-admin", instrument["admin"], "--instrument-id", instrument["id"],
            "--factory", factory or read_disclosed(net)[0]["contractId"], *rpc]


def accept_left_proposal(net: Network, address: str, instrument: dict = None, factory: str = None) -> dict:
    """A run that stopped between propose.py's two steps left the operator's proposal for this token, not yet accepted by the confirmer: accept it,
    but only if it is the proposal this command would make (the same instrument and factory), as setup.py does for the chain's."""
    [left] = token_contracts(net, address, "GatewayTokenProposal")
    want = instrument or {"admin": net.party("registry"), "id": INSTRUMENT}
    if left["createArgument"]["instrumentId"] != want or left["createArgument"]["factory"] != (factory or read_disclosed(net)[0]["contractId"]):
        raise Fail(f"a proposal for {address} is there already and is not for {want['id']} with this factory: it cannot be withdrawn from here")
    rpc_url = os.environ.get("CZE_RPC_URL") or f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', '8545')}"
    gateway = chain_record(net)["gatewayAddress"]
    if not propose.gateway_made(rpc_url, gateway, address):   # as propose.py token checks, before it makes the proposal
        raise Fail(f"the gateway at {gateway} did not make the token {address}: the proposal left for it is not accepted")
    mine = [e for e in net.template("confirmer", "confirmer", CHAIN + "GatewayTokenProposal") if e["createArgument"]["evmToken"] == address]
    [proposal] = mine or net.wait_for("the proposal at the confirmer", lambda: [e for e in net.template("confirmer", "confirmer", CHAIN + "GatewayTokenProposal")
                                                                                 if e["createArgument"]["evmToken"] == address])
    net.submit("confirmer", ["confirmer"], {"ExerciseCommand": {"templateId": CHAIN + "GatewayTokenProposal", "contractId": proposal["contractId"],
                                                                "choice": "AcceptToken", "choiceArgument": {}}}, user="confirmer")
    [made] = net.wait_for("the registered token", lambda: token_contracts(net, address, "GatewayToken"))
    return {"contractId": made["contractId"], "evmToken": made["createArgument"]["evmToken"], "instrumentId": made["createArgument"]["instrumentId"]}


def register_token(net: Network, token: str, instrument: dict = None, factory: str = None) -> dict:
    address = evm_address(token)
    if not token_contracts(net, address, "GatewayToken") and token_contracts(net, address, "GatewayTokenProposal"):
        return accept_left_proposal(net, address, instrument, factory)
    arguments = propose_arguments(net, token, instrument, factory)
    # On one participant both of propose.py's Ledger APIs are that participant's; its user prefix and token files come from the environment as they are.
    env = {**os.environ, "CZE_CONFIRMER_LEDGER_URL": net.urls["confirmer"]} if net.external else None
    done = subprocess.run([sys.executable, str(PROPOSE), *arguments], capture_output=True, text=True, timeout=600, env=env)
    if done.returncode != 0:
        raise Fail(f"propose.py token stopped ({done.returncode}): {(done.stderr or done.stdout).strip()[-800:]}")
    return json.loads(done.stdout.strip().splitlines()[-1])


def registered(net: Network, token: str) -> dict:
    """Whether the wrapped token at this EVM address is registered for TKB: a GatewayToken that the operator sees."""
    address = evm_address(token)
    return {"evmToken": address, "registered": bool(token_contracts(net, address, "GatewayToken")), "proposed": bool(token_contracts(net, address, "GatewayTokenProposal"))}


def token_contracts(net: Network, address: str, template: str) -> list:
    return [e for e in net.template("operator", "operator", CHAIN + template) if e["createArgument"]["evmToken"] == address]


def acceptances_of(net: Network, who: str) -> list:
    """The WithdrawalAcceptances of this party that the operator sees. Not everyone's: other parties on the participant have their own."""
    if who not in ("u", "v"):
        raise SystemExit(f"only u and v can accept withdrawals here, not {who!r}")
    party = net.party(who)
    return [e for e in net.template("operator", "operator", ACCEPTANCE) if e["createArgument"]["party"] == party]


def accepted(net: Network, who: str) -> dict:
    """Whether this party has a standing acceptance of withdrawals (its own, not another party's)."""
    found = acceptances_of(net, who)
    return {"party": net.party(who), "accepted": bool(found), "acceptances": len(found)}


def accept(net: Network, who: str) -> dict:
    acceptances_of(net, who)   # refuses a party that is not u or v before anything is sent
    chain, party = chain_record(net), net.party(who)
    mine = lambda: acceptances_of(net, who)
    before = {e["contractId"] for e in mine()}
    if before:   # this party's acceptance is there already (a run that is repeated): it stands, and no second one is made
        return {"party": party, "acceptance": mine()[0]["contractId"]}
    net.submit("users", [who], {"CreateCommand": {"templateId": ACCEPTANCE, "createArguments": {
        "party": party, "chainId": chain["chainId"], "operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"]}}})
    # The builder looks for it on the operator's participant.
    [made] = net.wait_for("the acceptance", lambda: [e for e in mine() if e["contractId"] not in before])
    return {"party": party, "acceptance": made["contractId"]}


def deposit(net: Network, label: str, recipient: str, amount: str) -> dict:
    """U allocates `amount` TKB to the gateway and signs a request to deposit it for the EVM address `recipient`. The request carries `label`, and its
    deposit id is the one derived from U and the label (`deposit_id_of`). A chain on package 0.4.0 or earlier has no label in its request:
    CZE_DEPOSIT_WITHOUT_LABEL=1 makes the request of that package, with a random id, and CZE_DEPOSIT_PACKAGE=<package id> makes it under that
    package (the package-upgrade test makes its 0.2.0 requests so)."""
    read_label(label)
    if not CANTON_AMOUNT.fullmatch(amount) or float(amount) == 0:
        raise SystemExit(f"the amount must be more than zero, with at most 10 decimals: {amount!r}")
    address = evm_address(recipient)
    chain = chain_record(net)
    unlabelled = os.environ.get("CZE_DEPOSIT_WITHOUT_LABEL") == "1"
    deposit_id = secrets.token_hex(32) if unlabelled else deposit_id_of(net.party("u"), label)
    # The id is the same for a label every time, and the gateway takes an id once: a label is for one deposit of U.
    if any(e["createArgument"]["depositId"] == deposit_id for e in net.template("operator", "operator", DEPOSIT_REQUEST)):
        raise SystemExit(f"U already has an open deposit request with the label {label!r}: each label makes one deposit id, so use a label that has not been used")
    allocation = allocate(net, label, chain["gateway"], amount if "." in amount else amount + ".0")
    arguments = {"operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"], "chainId": chain["chainId"],
                 "depositor": net.party("u"), "depositId": deposit_id, "recipient": address, "allocation": allocation["contractId"]}
    if not unlabelled:
        arguments["label"] = label
    package = os.environ.get("CZE_DEPOSIT_PACKAGE")   # the request is made under this package, by its id, not by the package's name
    net.submit("users", ["u"], {"CreateCommand": {"templateId": f"{package}:Zk.Chain:DepositRequest" if package else DEPOSIT_REQUEST, "createArguments": arguments}})
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


def total_of(net: Network, who: str) -> float:
    return sum(holdings(net, who))


def return_tkb(net: Network, label: str, amount: str) -> dict:
    """V sends U `amount` TKB through the token standard's transfer factory (the rules, disclosed to V as for an allocation), with all of V's holdings as
    the inputs. A token that answers with an offer to U has it accepted by U; one that completes the transfer needs no acceptance. Waits until U holds
    the amount more, and gives how it went."""
    read_label(label)
    if not CANTON_AMOUNT.fullmatch(amount) or float(amount) == 0:
        raise SystemExit(f"the amount must be more than zero, with at most 10 decimals: {amount!r}")
    amount = amount if "." in amount else amount + ".0"
    u, v, registry = net.party("u"), net.party("v"), net.party("registry")
    disclosed = read_disclosed(net)
    inputs = [e["contractId"] for e in net.template("users", "v", TOKEN)]
    if total_of(net, "v") < float(amount):
        raise Fail(f"V holds {total_of(net, 'v')} TKB, less than {amount}")
    u_before = total_of(net, "u")
    offers = {e["contractId"] for e in net.template("users", "u", TRANSFER_OFFER)}
    transfer = {"sender": v, "receiver": u, "amount": amount, "instrumentId": {"admin": registry, "id": INSTRUMENT}, "requestedAt": utc(timedelta(minutes=-1)),
                "executeBefore": utc(timedelta(hours=1)), "inputHoldingCids": inputs, "meta": {"values": {"label": label}}}
    net.submit("users", ["v"], {"ExerciseCommand": {"templateId": TRANSFER_FACTORY, "contractId": disclosed[0]["contractId"], "choice": "TransferFactory_Transfer",
                                                   "choiceArgument": {"expectedAdmin": registry, "transfer": transfer, "extraArgs": NO_EXTRA_ARGS}}}, disclosed)
    def arrived():
        offer = [e for e in net.template("users", "u", TRANSFER_OFFER) if e["contractId"] not in offers]
        return {"offer": offer[0]["contractId"]} if offer else ({"offer": None} if total_of(net, "u") >= u_before + float(amount) else None)
    found = net.wait_for("the transfer to reach U", arrived)
    if found["offer"]:
        net.submit("users", ["u"], {"ExerciseCommand": {"templateId": TRANSFER_INSTRUCTION, "contractId": found["offer"], "choice": "TransferInstruction_Accept",
                                                       "choiceArgument": {"extraArgs": NO_EXTRA_ARGS}}})
        net.wait_for("U to hold the TKB", lambda: total_of(net, "u") >= u_before + float(amount) or None)
    return {"label": label, "amount": amount, "from": "v", "to": "u", "offer": found["offer"], "uHolds": holdings(net, "u"), "vHolds": holdings(net, "v")}


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


def update_at(net: Network, node: str, party: str, offset: int, identifier_filter: dict = None) -> dict:
    """The transaction at this offset as `node` reports it to `party` (only the created events that the filter lets through): one bounded read,
    whatever the size of the chain."""
    wildcard = {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}
    flt = [{"identifierFilter": identifier_filter or wildcard}]
    body = {"offset": offset, "updateFormat": {"includeTransactions": {
        "eventFormat": {"filtersByParty": {net.party(party): {"cumulative": flt}}, "verbose": False},
        "transactionShape": "TRANSACTION_SHAPE_ACS_DELTA"}}}
    found = net.post(node, "/v2/updates/update-by-offset", body, ROLE_OF_PARTY[party])
    tx = found.get("update", {}).get("Transaction", {}).get("value")
    if not tx or not tx.get("updateId"):
        raise Fail(f"no transaction at offset {offset} on {node}: {json.dumps(found)[:300]}")
    return tx


def update_of(net: Network, node: str, party: str, event: dict) -> dict:
    """The update that created the contract of this created event, as `node` reports it to `party`: its id and its offset. The update is
    asked for by the event's offset, and it must list this very contract among the events it created."""
    offset = event.get("offset")
    if not isinstance(offset, int):
        raise Fail(f"the created event of {event['contractId'][:16]} has no offset")
    tx = update_at(net, node, party, offset)
    created = [e["CreatedEvent"]["contractId"] for e in tx.get("events", []) if "CreatedEvent" in e]
    if event["contractId"] not in created:
        raise Fail(f"the update at offset {offset} on {node} did not create {event['contractId'][:16]}")
    return {"updateId": tx["updateId"], "offset": offset, "contract": event["contractId"]}


def holder_node(holder: str) -> tuple:
    if holder not in HOLDER_NODES:
        raise SystemExit(f"the holder must be one of {', '.join(HOLDER_NODES)}, not {holder!r}")
    return HOLDER_NODES[holder]


def record_with_holding(net: Network, number: int, holder: str) -> dict:
    """The BlockRecord of this block, found without reading the chain's records: the holder's newest TKB holding was made by the block's update,
    so that update, read for the reader party and filtered to BlockRecord, holds the record. (BlockRecords are never archived: a read of all of them
    grows with the chain, and a Ledger API caps the size of an answer.) The update must hold exactly one record, and it must be this block's."""
    node, reader = holder_node(holder)
    held = sorted(net.template(node, holder, TOKEN), key=lambda e: e.get("offset") or 0)
    if not held:
        raise Fail(f"{holder} has no TKB holding")
    offset = held[-1].get("offset")
    if not isinstance(offset, int):
        raise Fail(f"the created event of {held[-1]['contractId'][:16]} has no offset")
    tx = update_at(net, node, reader, offset, {"TemplateFilter": {"value": {"templateId": CHAIN + "BlockRecord", "includeCreatedEventBlob": False}}})
    made = [e["CreatedEvent"] for e in tx.get("events", []) if "CreatedEvent" in e]
    if len(made) != 1 or int(made[0]["createArgument"]["number"]) != number:
        raise Fail(f"the update of {holder}'s newest TKB holding (offset {offset}) did not make the BlockRecord of block {number}: "
                   f"it made {[int(e['createArgument']['number']) for e in made]}")
    return {"event": made[0], "updateId": tx["updateId"], "offset": offset, "holding": held[-1]}


def settled(net: Network, number: int, holder: str = "v") -> dict:
    """Where the block's BlockRecord and the holder's newest TKB holding were made, both read on one participant: the users participant
    for U and V, the operator's for the gateway (which it hosts). Offsets are a participant's own, so only two read there can be compared.
    The record is the one that the holding's update made (one bounded read, see record_with_holding), and the holding's own update is read too."""
    found = record_with_holding(net, number, holder)
    node, _ = holder_node(holder)
    return {"record": {"updateId": found["updateId"], "offset": found["offset"], "contract": found["event"]["contractId"]},
            "holding": update_of(net, node, holder, found["holding"])}


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


def head(net: Network) -> list:
    return [{"headNumber": int(c["createArgument"]["headNumber"]), "headHash": c["createArgument"]["headHash"]} for c in net.template("operator", "operator", CHAIN + "ZkChain")]


def record_view(argument: dict) -> dict:
    return {"number": int(argument["number"]), "blockHash": argument["blockHash"],
            "proofSha256": hashlib.sha256(bytes.fromhex(argument["proofHex"])).hexdigest(), "proofHex": argument["proofHex"]}


def block_records(net: Network) -> list:
    """Every BlockRecord (all of them are active for good): a read that grows with the chain. Only `status` takes it."""
    return sorted((record_view(r["createArgument"]) for r in net.template("users", "reader", CHAIN + "BlockRecord")), key=lambda r: r["number"])


def block(net: Network, number: int, holder: str = None) -> dict:
    """The chain's head and one block's record. With a holder (u, v or gateway) the record is the one that holder's newest TKB holding was made
    with: one bounded read, for a chain that has many blocks. Without, every record is read and the block picked from them."""
    if holder is not None:
        return {"chain": head(net), "record": record_view(record_with_holding(net, number, holder)["event"]["createArgument"])}
    found = [r for r in block_records(net) if r["number"] == number]
    if len(found) != 1:
        raise Fail(f"expected one BlockRecord for block {number}, found {len(found)}")
    return {"chain": head(net), "record": found[0]}


def status(net: Network) -> dict:
    return {"chain": head(net), "blockRecords": block_records(net), **balances(net)}


def balances(net: Network) -> dict:
    return {
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
    if net.external:
        net.check_roles(COMMAND_ROLES.get(argv[0], DEFAULT_ROLES) if argv else ())
    if argv == ["upload-dars"]:
        return upload_dars(net)
    if argv == ["setup"]:
        return setup(net)
    if cmd == ["register-token"] and n == 2:
        return register_token(net, argv[1])
    if cmd == ["registered"] and n == 2:
        return registered(net, argv[1])
    if cmd == ["block"] and n in (2, 3) and WHOLE.fullmatch(argv[1]):
        if n == 3:
            holder_node(argv[2])
        return block(net, int(argv[1]), *argv[2:])
    if argv == ["balances"]:
        return balances(net)
    if cmd == ["accept"] and n == 2:
        return accept(net, argv[1])
    if cmd == ["accepted"] and n == 2:
        return accepted(net, argv[1])
    if cmd == ["deposit"] and n == 4:
        return deposit(net, argv[1], argv[2], argv[3])
    if cmd == ["dvp"] and n == 5 and WHOLE.fullmatch(argv[4]):
        return dvp(net, argv[1], argv[2], argv[3], int(argv[4]))
    if cmd == ["payment-id"] and n == 2:
        return {"label": argv[1], "id": payment_id(net.party("u"), net.party("v"), read_label(argv[1]))}
    if cmd == ["return-tkb"] and n == 3:
        return return_tkb(net, argv[1], argv[2])
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
