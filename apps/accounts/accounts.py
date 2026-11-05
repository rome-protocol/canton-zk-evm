#!/usr/bin/env python3
"""The accounts service: Canton accounts that a person holds with a key of their own, made and used through the participant's JSON Ledger API.
See README.md.

  accounts.py --ledger-url <url> --user-id <ledger user> --state-file <path> [--listen 127.0.0.1:8081]

The service holds a Ledger API token and no key of any party. An account is an external party: its key is made by its owner, and only that key can
sign for it. The service generates the topology and the transactions to be signed, hands them out, and submits what comes back signed.
"""
import argparse, base64, binascii, collections, hashlib, hmac, json, os, re, secrets, sys, threading, time, urllib.error, urllib.parse, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ed25519

# What the service lets an account sign: a create of a template ("#package:Module:Entity") or an exercise of one choice ("#package:Module:Entity#Choice").
DEFAULT_ALLOW = (
    "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance",
    "#canton-zk-evm:Zk.Chain:DepositRequest",
    "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory#AllocationFactory_Allocate",
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory#TransferFactory_Transfer",
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction#TransferInstruction_Accept",
)
CHAIN_CREATES = DEFAULT_ALLOW[:2]   # these creates name the chain's parties as observers: they are checked against the configured ones
CHAIN_FIELDS = ("operator", "confirmer", "gateway", "builder")
ACCEPTANCE, DEPOSIT = CHAIN_CREATES
ALLOW_ENTRY = re.compile(r"#[a-z0-9][a-z0-9-]*:[A-Za-z0-9_.]+:[A-Za-z0-9_]+(#[A-Za-z0-9_]+)?\Z")
HOLDING = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding"
PARTY = re.compile(r"[A-Za-z0-9_-]{1,64}::1220[0-9a-f]{64}\Z")   # hint::fingerprint; a hash fingerprint is "1220" and 64 lowercase hex digits
HINT = re.compile(r"[A-Za-z0-9_-]{1,32}\Z")
SPKI_ED25519 = bytes.fromhex("302a300506032b6570032100")   # the DER prefix of an Ed25519 public key; 32 raw key bytes follow
MAX_BODY = 512 * 1024
PENDING_TTL = 600        # seconds a topology or a prepared transaction can be signed and sent back
HOLDINGS_PAGE, HOLDINGS_PAGES = 100, 50
DAY = 86400
SIGNATURE_FORMAT = "SIGNATURE_FORMAT_RAW"   # the 3.7.1 OpenAPI spec leaves the format a free string and names no value; RAW is what the pinned Canton accepts


class HttpError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


def b64(value, name: str, sizes: tuple) -> bytes:
    """Strict base64 text of one of the allowed byte lengths."""
    try:
        raw = base64.b64decode(value, validate=True) if isinstance(value, str) else None
    except (binascii.Error, ValueError):
        raw = None
    if raw is None or len(raw) not in sizes:
        raise HttpError(400, f"{name} must be base64 of {' or '.join(map(str, sizes))} bytes")
    return raw


def text(body, name: str, limit: int = 4096) -> str:
    value = body.get(name) if isinstance(body, dict) else None
    if not isinstance(value, str) or not 0 < len(value) <= limit:
        raise HttpError(400, f"{name} must be non-empty text")
    return value


class Ledger:
    """The JSON Ledger API (v2). The token is read from its file for each call (a rotated token is picked up) or is the fixed one given at start."""
    def __init__(self, url: str, token_file: str = None, token: str = ""):
        self.url, self.token_file, self.fixed = url.rstrip("/"), token_file, token

    def call(self, method: str, path: str, body=None):
        try:
            token = open(self.token_file).read().strip() if self.token_file else self.fixed
            if not token:
                raise OSError("the token file is empty")
            request = urllib.request.Request(self.url + path, None if body is None else json.dumps(body).encode(), method=method,
                                             headers={"content-type": "application/json", "authorization": f"Bearer {token}"})
            with urllib.request.urlopen(request, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            with e:
                raw = e.read().decode(errors="replace")
            try:
                answer = json.loads(raw)
            except ValueError:
                answer = {}
            if e.code in (401, 403) or e.code >= 500:   # the service's own login or the participant: not the caller's fault
                print(f"{method} {path}: {e.code} {raw[:300]}", file=sys.stderr)
                raise HttpError(502, "the ledger could not do that now") from None
            raise HttpError(422, "the ledger refused the request", code=answer.get("code"), detail=str(answer.get("cause") or raw)[:300]) from None
        except (OSError, ValueError) as e:
            print(f"{method} {path}: {type(e).__name__}: {e}", file=sys.stderr)
            raise HttpError(502, "the ledger could not be reached") from None


class Pending:
    """What was handed out and may come back signed, for `ttl` seconds: key -> value. At most `limit` entries, and `per_owner` for one owner (a client).
    In memory: a restart voids it, and the page asks again."""
    def __init__(self, ttl: float = PENDING_TTL, limit: int = 5000, per_owner: int = 10, clock=time.monotonic):
        self.ttl, self.limit, self.per_owner, self.clock, self.items, self.lock = ttl, limit, per_owner, clock, {}, threading.Lock()

    def put(self, key: str, value, owner: str = "") -> None:
        with self.lock:
            now = self.clock()
            if key not in self.items:
                self.items = {k: v for k, v in self.items.items() if v[0] > now}
                if len(self.items) >= self.limit or sum(v[2] == owner for v in self.items.values()) >= self.per_owner:
                    raise HttpError(503, "too many requests are waiting for a signature")
            self.items[key] = (now + self.ttl, value, owner)

    def get(self, key: str):
        with self.lock:
            hit = self.items.get(key)
            return hit[1] if hit and hit[0] > self.clock() else None

    def take(self, key: str):
        """The value, removed in the same step: of two callers for one key, one gets it."""
        with self.lock:
            hit = self.items.pop(key, None)
            return hit[1] if hit and hit[0] > self.clock() else None

    def drop(self, key: str) -> None:
        with self.lock:
            self.items.pop(key, None)


class Limiter:
    """At most `count` in total weight per key in `window` seconds."""
    def __init__(self, count: int, window: float, clock=time.monotonic):
        self.count, self.window, self.clock, self.hits, self.lock = count, window, clock, {}, threading.Lock()

    def hit(self, key: str, weight: int = 1) -> None:
        with self.lock:
            now = self.clock()
            q = self.hits.setdefault(key, collections.deque())
            while q and q[0][0] <= now - self.window:
                q.popleft()
            if sum(w for _, w in q) + weight > self.count:
                raise HttpError(429, "too many requests: try again later", retryAfter=int(q[0][0] + self.window - now) + 1 if q else int(self.window))
            q.append((now, weight))
            if len(self.hits) > 10000:
                self.hits = {k: v for k, v in self.hits.items() if v and v[-1][0] > now - self.window}


class Parties:
    """The parties this service allocated, each with the Ed25519 key it was made with: kept in memory and appended to `path` (one JSON line each), so that it
    answers for them after a restart."""
    def __init__(self, path: str):
        self.path, self.parties, self.lock = path, {}, threading.Lock()
        if os.path.exists(path):
            with open(path) as f:
                for line in f:
                    try:
                        entry = json.loads(line)
                        self.parties[entry["party"]] = base64.b64decode(entry["key"], validate=True)
                    except (ValueError, KeyError, TypeError):
                        print(f"state file {path}: a line is dropped", file=sys.stderr)

    def __contains__(self, party: str) -> bool:
        return party in self.parties

    def key(self, party: str) -> bytes:
        return self.parties[party]

    def add(self, party: str, key: bytes) -> None:
        with self.lock:
            if party not in self.parties:
                with open(self.path, "a") as f:
                    f.write(json.dumps({"party": party, "key": base64.b64encode(key).decode(), "at": int(time.time())}) + "\n")
                    f.flush(); os.fsync(f.fileno())
                self.parties[party] = key


class Accounts:
    def __init__(self, ledger: Ledger, user: str, parties: Parties, allow, hint: str = "bridge", synchronizer: str = None, topology_version: int = None,
                 creates: Limiter = None, rate: Limiter = None, topologies: Pending = None, prepared: Pending = None, chain: dict = None,
                 open_limits: dict = None, per_account: Limiter = None, per_client: Limiter = None, overall: Limiter = None, traffic: Limiter = None,
                 max_traffic: int = 200000):
        self.ledger, self.user, self.parties, self.allow, self.hint = ledger, user, parties, set(allow), hint
        self.synchronizer, self.topology_version = synchronizer, topology_version
        self.creates, self.rate = creates or Limiter(3, DAY), rate or Limiter(60, 60)
        self.topologies, self.prepared = topologies or Pending(limit=2000), prepared or Pending()   # the caps of the two are apart
        self.chain = chain or {}   # the chain's parties by field name: what a create's observers must be
        self.open_limits = {ACCEPTANCE: 1, DEPOSIT: 3} if open_limits is None else open_limits   # most open contracts of a template an account may have
        # What executes and allocations may spend in a day: per account, per client, overall, and the overall traffic that the participant estimates.
        self.per_account, self.per_client, self.overall = per_account or Limiter(50, DAY), per_client or Limiter(200, DAY), overall or Limiter(2000, DAY)
        self.traffic, self.max_traffic = traffic or Limiter(50_000_000, DAY), max_traffic
        self.secret = secrets.token_bytes(32)

    def sync_id(self) -> str:
        if not self.synchronizer:
            found = self.ledger.call("GET", "/v2/state/connected-synchronizers").get("connectedSynchronizers") or []
            if len(found) != 1:
                raise HttpError(502, f"the participant is connected to {len(found)} synchronizers: name one with --synchronizer-id")
            self.synchronizer = found[0]["synchronizerId"]
        return self.synchronizer

    @staticmethod
    def signature(raw_b64: str, fingerprint: str) -> dict:
        return {"format": SIGNATURE_FORMAT, "signature": raw_b64, "signedBy": fingerprint, "signingAlgorithmSpec": "SIGNING_ALGORITHM_SPEC_ED25519"}

    def spend(self, ip: str, party: str = None, traffic: int = 0) -> None:
        """Count one execute or allocation against the day's budgets, the narrowest first: a client over its own budget draws nothing from the wider ones."""
        if party:
            self.per_account.hit(party)
        self.per_client.hit(ip)
        self.overall.hit("all")
        if traffic:
            self.traffic.hit("all", traffic)

    def known(self, party) -> str:
        if not isinstance(party, str) or party not in self.parties:
            raise HttpError(404, "this service did not make that account")
        return party

    # ---- the routes

    def handle(self, method: str, path: str, body, ip: str):
        if path == "/healthz" and method == "GET":
            try:
                self.ledger.call("GET", "/v2/version")
                return {"ok": True, "accounts": len(self.parties.parties)}
            except HttpError as e:
                return {"ok": False, "error": e.message}
        self.rate.hit(ip)
        if method == "POST":
            route = {"/accounts/v1/topology": self.topology, "/accounts/v1/allocate": self.allocate, "/accounts/v1/prepare": self.prepare,
                     "/accounts/v1/execute": self.execute}.get(path)
            if route:
                return route(body if isinstance(body, dict) else {}, ip)
        elif method == "GET":
            m = re.fullmatch(r"/accounts/v1/holdings/([^/]+)", path)
            if m:
                return self.holdings(urllib.parse.unquote(m.group(1)))
        raise HttpError(404, "no such route")

    def topology(self, body: dict, ip: str) -> dict:
        raw = b64(body.get("publicKey"), "publicKey (an Ed25519 key)", (32, 44))
        if len(raw) == 44 and not raw.startswith(SPKI_ED25519):
            raise HttpError(400, "publicKey is not an Ed25519 key")
        if body.get("partyHint") not in (None, self.hint):
            raise HttpError(400, f"every account is named {self.hint}: partyHint is that or left out")
        raw = raw[-32:]
        # One blob for one key, and it is not minted again while it lives: asking again hands out the same one and costs the participant nothing.
        blob = hmac.new(self.secret, raw, hashlib.sha256).hexdigest()[:48]
        again = self.topologies.get(blob)
        if again:
            return {"party": again[0], "exists": False, "multiHash": again[3], "blob": blob}
        key = {"format": "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", "keySpec": "SIGNING_KEY_SPEC_EC_CURVE25519",
               "keyData": base64.b64encode(SPKI_ED25519 + raw).decode()}
        request = {"synchronizer": self.sync_id(), "partyHint": self.hint, "publicKey": key}
        if self.topology_version:
            request["protocolVersion"] = self.topology_version
        made = self.ledger.call("POST", "/v2/parties/external/generate-topology", request)
        party = made["partyId"]
        if party in self.parties:
            return {"party": party, "exists": True}
        self.topologies.put(blob, (party, made["publicKeyFingerprint"], made["topologyTransactions"], made["multiHash"], raw), ip)
        return {"party": party, "exists": False, "multiHash": made["multiHash"], "blob": blob}

    def allocate(self, body: dict, ip: str) -> dict:
        blob = text(body, "blob", 100)
        signature = text(body, "signature", 200)
        b64(signature, "signature", (64,))
        found = self.topologies.get(blob)
        if found is None:
            raise HttpError(404, "no such topology, or it has expired: ask for it again")
        party, fingerprint, transactions, multi_hash, raw = found
        if party in self.parties:
            return {"party": party, "created": False}
        if not ed25519.verify(raw, base64.b64decode(multi_hash), base64.b64decode(signature)):
            raise HttpError(401, "the signature is not the key's signature of the multi-hash")
        self.creates.hit(ip)
        self.spend(ip)
        # The user gets the right to act as the new party in the same call, so the service's user needs no admin right of its own.
        self.ledger.call("POST", "/v2/parties/external/allocate", {
            "synchronizer": self.sync_id(), "onboardingTransactions": [{"transaction": t} for t in transactions],
            "multiHashSignatures": [self.signature(signature, fingerprint)], "userId": self.user, "waitForAllocation": True})
        self.parties.add(party, raw)
        self.topologies.drop(blob)
        return {"party": party, "created": True}

    def check_commands(self, party: str, commands) -> list:
        if not isinstance(commands, list) or len(commands) != 1:
            raise HttpError(400, "commands must hold exactly one command")
        command = commands[0]
        kind, args = next(iter(command.items())) if isinstance(command, dict) and len(command) == 1 else (None, None)
        if kind not in ("CreateCommand", "ExerciseCommand") or not isinstance(args, dict) or not isinstance(args.get("templateId"), str):
            raise HttpError(400, "the command is a CreateCommand or an ExerciseCommand with a templateId")
        if kind == "ExerciseCommand" and not isinstance(args.get("choice"), str):
            raise HttpError(400, "an ExerciseCommand names its choice")
        wanted = args["templateId"] + ("#" + args["choice"] if kind == "ExerciseCommand" else "")
        if wanted not in self.allow:
            raise HttpError(403, f"{wanted} is not on this service's list of allowed commands (name the package, not its id)")
        if kind == "CreateCommand":
            self.check_create(party, wanted, args.get("createArguments"))
        return commands

    def check_create(self, party: str, template: str, arguments) -> None:
        """A create names other parties as observers, and they see it and are sent it: so only the chain's own parties may be named, and the account itself."""
        if not isinstance(arguments, dict):
            raise HttpError(400, "a CreateCommand has createArguments")
        for field in CHAIN_FIELDS:
            if (template in CHAIN_CREATES or field in arguments) and (not self.chain.get(field) or arguments.get(field) != self.chain[field]):
                raise HttpError(403, f"{field} is not the chain's {field}")
        stack, allowed = [arguments], {party, *self.chain.values()}
        while stack:
            value = stack.pop()
            if isinstance(value, (dict, list)):
                stack.extend(value.values() if isinstance(value, dict) else value)
            elif isinstance(value, str) and "::" in value and value not in allowed:
                raise HttpError(403, "a party that is neither the account nor the chain's is named")

    def open_contracts(self, party: str, template: str) -> None:
        """An account holds few open contracts of a template that is limited: the account's own active contracts say how many."""
        limit = self.open_limits.get(template)
        if limit is None:
            return
        flt = {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": False}}}}]}
        page = self.ledger.call("POST", "/v2/state/active-contracts-page", {"eventFormat": {"filtersByParty": {party: flt}, "verbose": False}, "maxPageSize": limit})
        if len(page.get("activeContracts") or []) >= limit:
            raise HttpError(409, f"this account has {limit} open already: only {limit} at a time")

    def prepare(self, body: dict, ip: str) -> dict:
        party = self.known(body.get("party"))
        commands = self.check_commands(party, body.get("commands"))
        request = {"commandId": str(uuid.uuid4()), "userId": self.user, "actAs": [party], "synchronizerId": self.sync_id(),
                   "commands": commands, "readAs": [], "packageIdSelectionPreference": [], "prefetchContractKeys": [],
                   "verboseHashing": False, "disclosedContracts": body.get("disclosedContracts", [])}   # the JSON API wants every list, though they are optional
        if not isinstance(request["disclosedContracts"], list):
            raise HttpError(400, "disclosedContracts is a list")
        template = commands[0]["CreateCommand"]["templateId"] if "CreateCommand" in commands[0] else None
        if template:
            self.open_contracts(party, template)
        made = self.ledger.call("POST", "/v2/interactive-submission/prepare", request)
        tx, version = made["preparedTransaction"], made["hashingSchemeVersion"]
        cost = (made.get("costEstimation") or {}).get("totalTrafficCostEstimation")
        if not isinstance(cost, int) or isinstance(cost, bool):
            raise HttpError(502, "the ledger gave no estimate of the cost of this transaction")
        if cost > self.max_traffic:
            raise HttpError(403, f"this transaction would cost more than the {self.max_traffic} that this service allows one")
        self.prepared.put(hashlib.sha256(tx.encode()).hexdigest(), {"party": party, "version": version, "hash": base64.b64decode(made["preparedTransactionHash"]),
                                                                   "cost": cost, "template": template}, ip)
        return {"party": party, "preparedTransaction": tx, "preparedTransactionHash": made["preparedTransactionHash"], "hashingSchemeVersion": version}

    def execute(self, body: dict, ip: str) -> dict:
        tx = text(body, "preparedTransaction", MAX_BODY)
        sigs = body.get("partySignatures")
        if not isinstance(sigs, list) or len(sigs) != 1 or not isinstance(sigs[0], dict):
            raise HttpError(400, "partySignatures holds one entry: the party and its signature")
        party, signature = self.known(sigs[0].get("party")), sigs[0].get("signature")
        raw_signature = b64(signature, "signature", (64,))
        key = hashlib.sha256(tx.encode()).hexdigest()
        found = self.prepared.get(key)   # only what this service prepared, for this party, is executed: the list of allowed commands holds
        if found is None or found["party"] != party:
            raise HttpError(404, "no such prepared transaction for this account, or it has expired: prepare it again")
        if not ed25519.verify(self.parties.key(party), found["hash"], raw_signature):   # a wrong signature costs the participant nothing
            raise HttpError(401, "the signature is not this account's signature of the transaction's hash")
        found = self.prepared.take(key)   # the one attempt: the entry is gone before anything is sent, whatever comes of it
        if found is None:
            raise HttpError(404, "no such prepared transaction for this account, or it has expired: prepare it again")
        self.spend(ip, party, found["cost"])
        if found["template"]:
            self.open_contracts(party, found["template"])
        done = self.ledger.call("POST", "/v2/interactive-submission/executeAndWait", {
            "preparedTransaction": tx, "submissionId": str(uuid.uuid4()), "userId": self.user, "hashingSchemeVersion": found["version"],
            "deduplicationPeriod": {"Empty": {}},
            "partySignatures": {"signatures": [{"party": party, "signatures": [self.signature(signature, party.split("::")[1])]}]}})
        return {"updateId": done["updateId"]}

    def holdings(self, party: str) -> dict:
        """The party's CIP-0056 holdings (the Holding interface's view), all pages of one snapshot."""
        self.known(party)
        flt = {"cumulative": [{"identifierFilter": {"InterfaceFilter": {"value": {"interfaceId": HOLDING, "includeInterfaceView": True, "includeCreatedEventBlob": False}}}}]}
        request, out = {"eventFormat": {"filtersByParty": {party: flt}, "verbose": False}, "maxPageSize": HOLDINGS_PAGE}, []
        for _ in range(HOLDINGS_PAGES):
            page = self.ledger.call("POST", "/v2/state/active-contracts-page", request)
            for entry in page.get("activeContracts") or []:
                event = (entry.get("contractEntry") or {}).get("JsActiveContract", {}).get("createdEvent") or {}
                for view in event.get("interfaceViews") or []:
                    v = view.get("viewValue")
                    if isinstance(v, dict):
                        out.append({"contractId": event["contractId"], "instrumentId": v["instrumentId"], "amount": v["amount"], "locked": bool(v.get("lock"))})
            if not page.get("nextPageToken"):
                return {"party": party, "holdings": out}
            request = {**request, "activeAtOffset": page["activeAtOffset"], "pageToken": page["nextPageToken"]}
        raise HttpError(500, "the account holds more than this service lists")


def make_server(service: Accounts, host: str, port: int, ip_header: str = None) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        timeout = 20

        def serve(self, method: str):
            headers = {}
            try:
                body = None
                if method == "POST":
                    try:
                        length = int(self.headers.get("content-length") or 0)
                    except ValueError:
                        length = -1
                    if not 0 <= length <= MAX_BODY:
                        raise HttpError(400, f"the body must be at most {MAX_BODY} bytes")
                    try:
                        body = json.loads(self.rfile.read(length) or b"null")
                    except ValueError:
                        raise HttpError(400, "the body is not JSON")
                # Behind a reverse proxy the client is the last address that the proxy itself wrote into the header.
                ip = (self.headers.get(ip_header) or "").split(",")[-1].strip() if ip_header else ""
                status, out = 200, service.handle(method, urllib.parse.urlsplit(self.path).path, body, ip or self.client_address[0])
            except HttpError as e:
                status, out = e.status, {"error": e.message, **{k: v for k, v in e.extra.items() if v is not None and k != "retryAfter"}}
                if "retryAfter" in e.extra:
                    headers["retry-after"] = str(e.extra["retryAfter"])
            except Exception as e:
                print(f"{method} {self.path}: {type(e).__name__}: {e}", file=sys.stderr)
                status, out = 500, {"error": "the service could not do that"}
            data = json.dumps(out).encode()
            self.send_response(status)
            for k, v in {"content-type": "application/json", "content-length": str(len(data)), **headers}.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self): self.serve("GET")
        def do_POST(self): self.serve("POST")
        def log_message(self, *args): pass

    return ThreadingHTTPServer((host, port), Handler)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    p.add_argument("--ledger-url", required=True)
    p.add_argument("--user-id", required=True, help="the Ledger API user of the token: it gets the right to act as each account it makes")
    p.add_argument("--state-file", required=True, help="where the accounts made are kept across restarts")
    p.add_argument("--token-file", help="a file with the token, read again for each call; the environment variable LEDGER_TOKEN is used when it is not given")
    p.add_argument("--listen", default="127.0.0.1:8081")
    p.add_argument("--synchronizer-id", help="the synchronizer to make accounts on; by default the one the participant is connected to")
    p.add_argument("--topology-protocol-version", type=int, help="ask for topology transactions of this protocol version; by default the synchronizer's own")
    p.add_argument("--party-hint", default="bridge", help="the name every account is given before its key's fingerprint")
    p.add_argument("--allow", action="append", help="an allowed command: #package:Module:Entity (a create) or #package:Module:Entity#Choice (an exercise); repeat; replaces the built-in list")
    p.add_argument("--accounts-per-day", type=int, default=3, help="accounts made per client address in 24 hours")
    p.add_argument("--requests-per-minute", type=int, default=60, help="requests per client address in a minute")
    p.add_argument("--chain-parties", help="a JSON file {\"operator\": ..., \"confirmer\": ..., \"gateway\": ..., \"builder\": ...}: the chain's parties, the only observers a create may name")
    for field in CHAIN_FIELDS:
        p.add_argument(f"--chain-{field}", help=f"the chain's {field} party (overrides the file)")
    p.add_argument("--open-deposit-requests", type=int, default=3, help="open DepositRequests one account may have (it may have one WithdrawalAcceptance)")
    p.add_argument("--executes-per-account-day", type=int, default=50, help="executes per account in 24 hours")
    p.add_argument("--executes-per-client-day", type=int, default=200, help="executes and allocations per client address in 24 hours")
    p.add_argument("--executes-per-day", type=int, default=2000, help="executes and allocations in 24 hours, all clients together")
    p.add_argument("--max-transaction-traffic", type=int, default=200000, help="the most traffic the participant may estimate for one transaction (bytes)")
    p.add_argument("--traffic-per-day", type=int, default=50_000_000, help="the traffic of the executes in 24 hours, all clients together (bytes, as estimated)")
    p.add_argument("--max-pending-topologies", type=int, default=2000, help="topologies waiting for a signature")
    p.add_argument("--max-pending-prepared", type=int, default=5000, help="prepared transactions waiting for a signature")
    p.add_argument("--max-pending-per-client", type=int, default=10, help="topologies, and prepared transactions, waiting for a signature for one client address (each)")
    p.add_argument("--client-ip-header", help="the header in which the reverse proxy puts the client's address, such as X-Forwarded-For")
    a = p.parse_args(argv)
    token = "" if a.token_file else os.environ.get("LEDGER_TOKEN", "")
    if not (token or a.token_file):
        sys.exit("a token is required: LEDGER_TOKEN or --token-file")
    allow = a.allow or list(DEFAULT_ALLOW)
    if not HINT.match(a.party_hint) or not all(ALLOW_ENTRY.match(e) for e in allow):
        sys.exit("a party hint is letters, digits, - and _; an allowed command is #package:Module:Entity or #package:Module:Entity#Choice")
    chain = {}
    if a.chain_parties:
        with open(a.chain_parties) as f:
            chain = json.load(f)
    chain = {f: getattr(a, f"chain_{f}") or chain.get(f) for f in CHAIN_FIELDS}
    if not all(PARTY.match(v or "") for v in chain.values()):
        print("the chain's parties are not all set: creates that name them are refused", file=sys.stderr)
        chain = {}
    host, _, port = a.listen.rpartition(":")
    service = Accounts(Ledger(a.ledger_url, a.token_file, token), a.user_id, Parties(a.state_file), allow, a.party_hint, a.synchronizer_id, a.topology_protocol_version,
                       Limiter(a.accounts_per_day, DAY), Limiter(a.requests_per_minute, 60), Pending(limit=a.max_pending_topologies, per_owner=a.max_pending_per_client),
                       Pending(limit=a.max_pending_prepared, per_owner=a.max_pending_per_client), chain, {ACCEPTANCE: 1, DEPOSIT: a.open_deposit_requests},
                       Limiter(a.executes_per_account_day, DAY), Limiter(a.executes_per_client_day, DAY), Limiter(a.executes_per_day, DAY),
                       Limiter(a.traffic_per_day, DAY), a.max_transaction_traffic)
    make_server(service, host or "127.0.0.1", int(port), a.client_ip_header).serve_forever()


if __name__ == "__main__":
    main()
