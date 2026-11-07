#!/usr/bin/env python3
"""The accounts service: Canton accounts that a person holds with a key of their own, made and used through the participant's JSON Ledger API.
See README.md.

  accounts.py --ledger-url <url> --user-id <ledger user> --state-file <path> [--listen 127.0.0.1:8081]

The service holds a Ledger API token and no key of any party. An account is an external party: its key is made by its owner, and only that key can
sign for it. The service generates the topology and the transactions to be signed, hands them out, and submits what comes back signed.
"""
import argparse, base64, binascii, collections, contextlib, hashlib, hmac, ipaddress, json, os, re, secrets, sys, threading, time, urllib.error, urllib.parse, urllib.request, uuid
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
ALLOCATION = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation"
REDEEM = "#canton-zk-evm:Zk.Chain:RedeemRequest"
PARTY = re.compile(r"[A-Za-z0-9_-]{1,64}::1220[0-9a-f]{64}\Z")   # hint::fingerprint; a hash fingerprint is "1220" and 64 lowercase hex digits
HINT = re.compile(r"[A-Za-z0-9_-]{1,32}\Z")
SPKI_ED25519 = bytes.fromhex("302a300506032b6570032100")   # the DER prefix of an Ed25519 public key; 32 raw key bytes follow
MAX_BODY = 512 * 1024
MAX_TEXT = 128           # the longest `label` or `ref` in a create (contract ids and party ids are longer and are not capped)
TEXT_FIELDS = ("label", "ref")
MAX_ARGUMENTS = 2048     # bytes of a create's arguments, as JSON
IN_FLIGHT_TTL = 120      # seconds an execute that got no answer counts as open when its transaction has no end time of its own
PENDING_PER_ACCOUNT = 5  # prepared transactions one account may have waiting for its signature
PENDING_TTL = 600        # seconds a topology or a prepared transaction can be signed and sent back
RECORD_MARGIN = 30       # seconds added to PENDING_TTL for the latest time the participant may record a prepared transaction (`maxRecordTime`)
ACCOUNT_RATE = 30        # prepare, execute and holdings requests per account in a minute
NETWORK_RATE = 300       # requests per client network (an IPv4 address, an IPv6 /48) in a minute
HOLDINGS_PAGE, HOLDINGS_PAGES = 100, 50
DAY = 86400
AUTH_WINDOW = 60         # seconds of clock difference an account signature may have
FAILED_VERIFIES = 10     # signatures that fail to verify, per client in a minute, before the service stops verifying for that client
HEALTH_TTL = 5           # seconds /healthz is answered from the last check
TRUSTED_ADDRESSES = (ipaddress.ip_network("127.0.0.1"), ipaddress.ip_network("::1"))
SIGNATURE_FORMAT = "SIGNATURE_FORMAT_RAW"   # the 3.7.1 OpenAPI spec leaves the format a free string and names no value; RAW is what the pinned Canton accepts


SLOW_VERIFY_WARNING = ("WARNING: the cryptography package is not installed: signatures are checked in pure Python (about 5 ms each), so a flood of requests costs "
                       "the service CPU. A deployment must install it.")


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


def norm(address: str):
    """An IP address; an IPv4 address inside an IPv6 one (::ffff:a.b.c.d) is the IPv4 address. ValueError when it is not an address."""
    a = ipaddress.ip_address(address.strip())
    return a.ipv4_mapped or a if a.version == 6 else a


def client_key(address: str) -> str:
    """What limits count a client by: an IPv4 address as it is, an IPv6 address as its /64 (one subscriber holds a whole /64)."""
    try:
        a = norm(address)
    except ValueError:
        return address
    return str(ipaddress.ip_network((a, 64), strict=False)) if a.version == 6 else str(a)


def pending_owner(key: str) -> str:
    """What the caps on waiting entries count a client by: an IPv4 address as it is, an IPv6 address as its /48 (the rate limits stay per /64)."""
    try:
        return str(ipaddress.ip_network(key).supernet(new_prefix=48)) if "/" in key else key
    except ValueError:
        return key


def client_address(peer: str, header: str, n: int, trusted) -> str:
    """The client's address: the n-th entry from the right of the proxy header, but only when the TCP peer is a trusted proxy; otherwise the peer itself."""
    try:
        if header and any(norm(peer) in net for net in trusted):
            entries = [e.strip() for e in header.split(",")]
            if 1 <= n <= len(entries):
                return str(norm(entries[-n]))
    except ValueError:
        pass
    return peer


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
    """What was handed out and may come back signed, for `ttl` seconds: key -> value. At most `limit` entries, `per_owner` for one owner (a client) and, when
    a group (an account) is given, `per_group` for one group. In memory: a restart voids it, and the page asks again."""
    def __init__(self, ttl: float = PENDING_TTL, limit: int = 5000, per_owner: int = 10, clock=time.monotonic, per_group: int = None):
        self.ttl, self.limit, self.per_owner, self.per_group, self.clock = ttl, limit, per_owner, per_group, clock
        self.items, self.lock = {}, threading.Lock()

    def _room(self, now: float, key, owner: str, group: str) -> None:
        if key is None or key not in self.items or self.items[key][0] <= now:   # an entry that is replaced takes no new room
            live = [v for v in self.items.values() if v[0] > now]
            if (len(live) >= self.limit or sum(v[2] == owner for v in live) >= self.per_owner
                    or (group is not None and self.per_group is not None and sum(v[3] == group for v in live) >= self.per_group)):
                raise HttpError(503, "too many requests are waiting for a signature")

    def room(self, owner: str = "", group: str = None) -> None:
        """Refuse (503) as `put` of a new entry would, and add nothing: asked before any call to the participant."""
        with self.lock:
            self._room(self.clock(), None, owner, group)

    def put(self, key: str, value, owner: str = "", group: str = None) -> None:
        with self.lock:
            now = self.clock()
            self._room(now, key, owner, group)
            self.items[key] = (now + self.ttl, value, owner, group)

    def values(self, group: str) -> list:
        """What waits for one group (an account)."""
        with self.lock:
            now = self.clock()
            return [v[1] for v in self.items.values() if v[0] > now and v[3] == group]

    def prune(self) -> None:
        with self.lock:
            now = self.clock()
            self.items = {k: v for k, v in self.items.items() if v[0] > now}

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

    def _room(self, key: str, weight: int, create: bool):
        now = self.clock()
        q = self.hits.setdefault(key, collections.deque()) if create else self.hits.get(key, collections.deque())
        while q and q[0][0] <= now - self.window:
            q.popleft()
        if sum(w for _, w in q) + weight > self.count:
            raise HttpError(429, "too many requests: try again later", retryAfter=int(q[0][0] + self.window - now) + 1 if q else int(self.window))
        return q, now

    def check(self, key: str, weight: int = 1) -> None:
        """Refuse as `hit` would, and count nothing."""
        with self.lock:
            self._room(key, weight, False)

    def hit(self, key: str, weight: int = 1) -> None:
        with self.lock:
            q, now = self._room(key, weight, True)
            q.append((now, weight))

    def prune(self) -> None:
        with self.lock:
            now = self.clock()
            self.hits = {k: q for k, q in self.hits.items() if q and q[-1][0] > now - self.window}


class InFlight:
    """Executes of a limited template that got no answer (a timeout, a 5xx) and may still commit: (account, template) is counted as open until the transaction's
    `maxRecordTime` has passed (`ttl` seconds when it is not given)."""
    def __init__(self, ttl: float = IN_FLIGHT_TTL, clock=time.monotonic):
        self.ttl, self.clock, self.marks, self.lock = ttl, clock, {}, threading.Lock()

    def add(self, key, ttl: float = None) -> None:
        with self.lock:
            self.marks.setdefault(key, []).append(self.clock() + (self.ttl if ttl is None else ttl))

    def count(self, key) -> int:
        with self.lock:
            now = self.clock()
            return sum(t > now for t in self.marks.get(key, ()))

    def prune(self) -> None:
        with self.lock:
            now = self.clock()
            self.marks = {k: live for k, v in self.marks.items() if (live := [t for t in v if t > now])}


class Replays:
    """The account signatures seen inside the time window: (party, seconds, signature) is accepted once."""
    def __init__(self, wall=time.time):
        self.wall, self.seen, self.lock = wall, {}, threading.Lock()

    def used(self, party: str, seconds: int, signature: bytes) -> bool:
        with self.lock:
            return (party, seconds, signature) in self.seen

    def add(self, party: str, seconds: int, signature: bytes) -> bool:
        with self.lock:
            key = (party, seconds, signature)
            if key in self.seen:
                return False
            self.seen[key] = seconds + AUTH_WINDOW
            return True

    def prune(self) -> None:
        with self.lock:
            now = self.wall()
            self.seen = {k: until for k, until in self.seen.items() if until >= now}


class Parties:
    """The parties this service allocated, each with the Ed25519 key it was made with: kept in memory and appended to `path` (one JSON line each), so that it
    answers for them after a restart."""
    def __init__(self, path: str):
        self.path, self.parties, self.lock, self.torn = path, {}, threading.Lock(), False
        if os.path.exists(path):
            with open(path, "rb") as f:
                lines = f.read().split(b"\n")
            # The last piece is empty when the file ends in a newline; else a write did not finish: that line is ignored, and the next append starts a new one.
            self.torn = bool(lines.pop())
            if self.torn:
                print(f"state file {path}: the last line is torn and ignored", file=sys.stderr)
            for line in lines:
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
                    f.write("\n" * self.torn + json.dumps({"party": party, "key": base64.b64encode(key).decode(), "at": int(time.time())}) + "\n")
                    f.flush(); os.fsync(f.fileno())
                self.torn = False
                self.parties[party] = key


class Accounts:
    def __init__(self, ledger: Ledger, user: str, parties: Parties, allow, hint: str = "bridge", synchronizer: str = None, topology_version: int = None,
                 creates: Limiter = None, rate: Limiter = None, topologies: Pending = None, prepared: Pending = None, chain: dict = None,
                 open_limits: dict = None, per_account: Limiter = None, per_client: Limiter = None, overall: Limiter = None, traffic: Limiter = None,
                 max_traffic: int = 200000, new_total: Limiter = None, rights_gap: float = 5.0, failures: Limiter = None, account_rate: Limiter = None,
                 network_rate: Limiter = None):
        self.ledger, self.user, self.parties, self.allow, self.hint = ledger, user, parties, set(allow), hint
        self.synchronizer, self.topology_version = synchronizer, topology_version
        self.creates, self.rate = creates or Limiter(3, DAY), rate or Limiter(60, 60)
        self.account_rate, self.network_rate = account_rate or Limiter(ACCOUNT_RATE, 60), network_rate or Limiter(NETWORK_RATE, 60)
        self.topologies, self.prepared = topologies or Pending(limit=2000), prepared or Pending(per_group=PENDING_PER_ACCOUNT)   # the caps of the two are apart
        self.chain = chain or {}   # the chain's parties by field name: what a create's observers must be
        self.open_limits = {ACCEPTANCE: 1, DEPOSIT: 3} if open_limits is None else open_limits   # most open contracts of a template an account may have
        # What executes and allocations may spend in a day: per account, per client, overall, and the overall traffic that the participant estimates.
        self.per_account, self.per_client, self.overall = per_account or Limiter(50, DAY), per_client or Limiter(200, DAY), overall or Limiter(2000, DAY)
        self.traffic, self.max_traffic = traffic or Limiter(50_000_000, DAY), max_traffic
        self.new_total = new_total or Limiter(200, DAY)   # new accounts a day, all clients: the participant's party and rights quotas are finite
        self.budget_lock = threading.Lock()   # the budgets are checked and charged as one step
        self.failures = failures or Limiter(FAILED_VERIFIES, 60)   # signatures that failed, per client
        self.in_flight = InFlight()
        self.account_locks, self.account_locks_guard = {}, threading.Lock()
        self.secret = secrets.token_bytes(32)
        self.clock, self.wall, self.replays = time.monotonic, time.time, Replays()
        # The ledger user's own rights are the truth of which parties this service holds; read at start and again on a miss, at most every `rights_gap` seconds.
        self.rights, self.rights_at, self.rights_gap, self.rights_lock = set(), None, rights_gap, threading.Lock()
        self.health_at, self.health_error, self.health_lock, self.health_busy = None, None, threading.Lock(), False

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

    def spend(self, ip: str, party: str = None, traffic: int = 0, extra=(), take=None):
        """Count one execute or allocation against the day's budgets. Every budget is checked first and they are charged together, so a refusal (429) charges
        none of them. `take`, when given, runs between the check and the charge and is what removes the prepared entry: it survives a refusal."""
        items = [*extra, *([(self.per_account, party, 1)] if party else []), (self.per_client, ip, 1), (self.overall, "all", 1),
                 *([(self.traffic, "all", traffic)] if traffic else [])]
        with self.budget_lock:
            for limiter, key, weight in items:
                limiter.check(key, weight)
            taken = take() if take else None
            for limiter, key, weight in items:
                limiter.hit(key, weight)
        return taken

    def account_lock(self, party: str):
        with self.account_locks_guard:
            return self.account_locks.setdefault(party, threading.Lock())

    def proves(self, key: bytes, message: bytes, signature: bytes, ip: str) -> bool:
        """Whether the signature verifies. Verifying costs the service CPU whichever party is named, so a client (an IPv6 /48) with FAILED_VERIFIES failures in a
        minute is refused (429) before anything is verified. Failures are not counted per party: anyone can name a party, and that would lock its owner out."""
        name = pending_owner(ip)
        self.failures.check(name)
        if ed25519.verify(key, message, signature):
            return True
        self.failures.hit(name)
        return False

    def known(self, party) -> str:
        if not isinstance(party, str) or party not in self.parties:
            raise HttpError(404, "this service did not make that account")
        return party

    # ---- which parties are held, and proof of the key

    def load_rights(self, force: bool = False) -> None:
        """Read the ledger user's CanActAs rights (the parties this service holds), at most every `rights_gap` seconds unless forced."""
        if not self.rights_lock.acquire(blocking=False):
            return
        try:
            now = self.clock()
            if not force and self.rights_at is not None and now - self.rights_at < self.rights_gap:
                return
            self.rights_at = now
            out = self.ledger.call("GET", "/v2/users/" + urllib.parse.quote(self.user, safe="") + "/rights")
            kinds = [(r.get("kind") or {}) for r in out.get("rights") or [] if isinstance(r, dict)]
            self.rights = {((k.get("CanActAs") or {}).get("value") or {}).get("party") for k in kinds} - {None}
        finally:
            self.rights_lock.release()

    def holds(self, party: str) -> bool:
        if party not in self.rights and isinstance(party, str) and PARTY.match(party):   # only an id that could be a party is worth a read of the rights
            self.load_rights()
        return party in self.rights

    def key_of(self, party) -> bytes:
        if isinstance(party, str):
            if party in self.parties:
                return self.parties.key(party)
            if self.holds(party):   # the user can act as it, the state file has no line for it: the Ledger API does not give a party's key
                raise HttpError(409, "this service holds that account but not its key: register it again (topology, then allocate, with the same key)")
        raise HttpError(404, "this service did not make that account")

    def authenticate(self, party, method: str, path: str, raw: bytes, header, ip: str = "") -> None:
        """Proof of the account's key on a request about it: header `<unix seconds>.<base64 signature>`, the signature over
        `accounts-v1\\n<METHOD>\\n<PATH>\\n<hex sha256 of the body>\\n<unix seconds>`, within AUTH_WINDOW of the server's time, and not seen before."""
        key = self.key_of(party)
        m = re.fullmatch(r"(\d{1,12})\.([A-Za-z0-9+/=]{1,100})", header or "")
        try:
            signature = base64.b64decode(m[2], validate=True) if m else b""
        except (binascii.Error, ValueError):
            signature = b""
        if len(signature) != 64:
            raise HttpError(401, "this request needs the account's signature in X-Account-Signature: <unix seconds>.<base64 signature>")
        seconds = int(m[1])
        message = f"accounts-v1\n{method}\n{path}\n{hashlib.sha256(raw).hexdigest()}\n{seconds}".encode()
        if abs(self.wall() - seconds) > AUTH_WINDOW:
            raise HttpError(401, "the account's signature is not valid for this request, or is too old")
        if self.replays.used(party, seconds, signature):
            raise HttpError(401, "this signature was used already")
        if not self.proves(key, message, signature, ip):
            raise HttpError(401, "the account's signature is not valid for this request, or is too old")
        if not self.replays.add(party, seconds, signature):
            raise HttpError(401, "this signature was used already")

    def health(self) -> dict:
        """The participant's answer to /v2/version, asked at most every HEALTH_TTL seconds however many ask. The lock is not held during the call: while one
        request refreshes the answer, the others get the last one."""
        with self.health_lock:
            refresh = not self.health_busy and (self.health_at is None or self.clock() - self.health_at >= HEALTH_TTL)
            self.health_busy = self.health_busy or refresh
            asked, error = self.health_at is not None, self.health_error
        if refresh:
            try:
                self.ledger.call("GET", "/v2/version")
                error = None
            except HttpError as e:
                error = e.message
            finally:
                with self.health_lock:
                    self.health_error, self.health_at, self.health_busy = error, self.clock(), False
        elif not asked:
            error = "not checked yet"
        return {"ok": True, "accounts": len(self.parties.parties)} if error is None else {"ok": False, "error": error}

    def sweep(self) -> None:
        """Drop what has expired from the limiters, the pending maps and the replay memory (a timer thread calls this)."""
        for part in (self.creates, self.rate, self.per_account, self.per_client, self.overall, self.traffic, self.new_total, self.failures, self.account_rate, self.network_rate, self.in_flight, self.topologies, self.prepared, self.replays):
            part.prune()

    def start_sweeper(self, every: float = 30) -> threading.Thread:
        def loop():
            while True:
                time.sleep(every)
                try:
                    self.sweep()
                except Exception as e:
                    print(f"sweep: {type(e).__name__}: {e}", file=sys.stderr)
        thread = threading.Thread(target=loop, daemon=True)
        thread.start()
        return thread

    # ---- the routes

    def handle(self, method: str, path: str, body, ip: str, raw: bytes = b"", auth: str = None):
        if path == "/healthz" and method == "GET":
            return self.health()
        ip = client_key(ip)
        self.rate.hit(ip)
        self.network_rate.hit(pending_owner(ip))   # a /48 holds many /64s, each with a rate of its own
        if method == "POST":
            route = {"/accounts/v1/topology": self.topology, "/accounts/v1/allocate": self.allocate, "/accounts/v1/prepare": self.prepare,
                     "/accounts/v1/execute": self.execute}.get(path)
            if route:
                body = body if isinstance(body, dict) else {}
                if route in (self.prepare, self.execute):   # the party the request is about must have signed it
                    sigs = body.get("partySignatures")
                    first = sigs[0] if isinstance(sigs, list) and sigs else None
                    party = body.get("party") if route == self.prepare else first.get("party") if isinstance(first, dict) else None
                    if isinstance(party, str):
                        self.authenticate(party, method, path, raw, auth, ip)
                        self.account_rate.hit(party)   # counted once the key has proved the account: naming a party cannot use up its rate
                return route(body, ip)
        elif method == "GET":
            m = re.fullmatch(r"/accounts/v1/(holdings|allocations|open)/([^/]+)", path)
            if m:
                party = urllib.parse.unquote(m.group(2))
                self.authenticate(party, method, path, raw, auth, ip)
                self.account_rate.hit(party)
                return getattr(self, m.group(1))(party)
        raise HttpError(404, "no such route")

    def topology(self, body: dict, ip: str) -> dict:
        raw = b64(body.get("publicKey"), "publicKey (an Ed25519 key)", (32, 44))
        if len(raw) == 44 and not raw.startswith(SPKI_ED25519):
            raise HttpError(400, "publicKey is not an Ed25519 key")
        if body.get("partyHint") not in (None, self.hint):
            raise HttpError(400, f"every account is named {self.hint}: partyHint is that or left out")
        raw = raw[-32:]
        # One blob for one key, and it is not minted again while it lives: asking again hands out the same one (it was checked then) and costs the participant nothing.
        blob = hmac.new(self.secret, raw, hashlib.sha256).hexdigest()[:48]
        again = self.topologies.get(blob)
        if again:
            return {"party": again[0], "exists": False, "multiHash": again[3], "topologyTransactions": again[2], "blob": blob}
        self.topologies.room(pending_owner(ip))   # a client at its cap costs the participant nothing
        if not ed25519.usable_key(raw):
            raise HttpError(400, "publicKey is not a usable Ed25519 key")
        key = {"format": "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", "keySpec": "SIGNING_KEY_SPEC_EC_CURVE25519",
               "keyData": base64.b64encode(SPKI_ED25519 + raw).decode()}
        request = {"synchronizer": self.sync_id(), "partyHint": self.hint, "publicKey": key}
        if self.topology_version:
            request["protocolVersion"] = self.topology_version
        made = self.ledger.call("POST", "/v2/parties/external/generate-topology", request)
        party = made["partyId"]
        if party in self.parties:
            return {"party": party, "exists": True}
        self.topologies.put(blob, (party, made["publicKeyFingerprint"], made["topologyTransactions"], made["multiHash"], raw), pending_owner(ip))
        return {"party": party, "exists": False, "multiHash": made["multiHash"], "topologyTransactions": made["topologyTransactions"], "blob": blob}

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
        if not self.proves(raw, base64.b64decode(multi_hash), base64.b64decode(signature), ip):
            raise HttpError(401, "the signature is not the key's signature of the multi-hash")
        if self.holds(party):   # the participant has this party for the service's user, the state file lost its line: the key is proved, so the line is written again
            self.parties.add(party, raw)
            self.topologies.drop(blob)
            return {"party": party, "created": False, "restored": True}
        self.spend(ip, extra=[(self.creates, ip, 1), (self.new_total, "all", 1)])
        # The user gets the right to act as the new party in the same call, so the service's user needs no admin right of its own.
        self.ledger.call("POST", "/v2/parties/external/allocate", {
            "synchronizer": self.sync_id(), "onboardingTransactions": [{"transaction": t} for t in transactions],
            "multiHashSignatures": [self.signature(signature, fingerprint)], "userId": self.user, "waitForAllocation": True})
        self.parties.add(party, raw)
        self.rights = self.rights | {party}
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
        """A create names other parties as observers, and they see it and are sent it: so only the chain's own parties may be named, and the account itself (for a
        create with no open limit, the account alone). `label` and `ref` are short, and the whole of the arguments is small; contract ids and party ids are not capped."""
        if not isinstance(arguments, dict):
            raise HttpError(400, "a CreateCommand has createArguments")
        if len(json.dumps(arguments, separators=(",", ":"))) > MAX_ARGUMENTS:
            raise HttpError(400, f"the createArguments are longer than {MAX_ARGUMENTS} bytes")
        for field in CHAIN_FIELDS:
            if (template in CHAIN_CREATES or field in arguments) and (not self.chain.get(field) or arguments.get(field) != self.chain[field]):
                raise HttpError(403, f"{field} is not the chain's {field}")
        unlimited = self.open_limits.get(template, 1) is None   # a template that was set to `none` is one with no limit; one that was not set is not
        stack, allowed = [(arguments, False)], {party} if unlimited else {party, *self.chain.values()}
        while stack:
            value, free = stack.pop()
            if isinstance(value, dict):
                stack.extend((v, free or k in TEXT_FIELDS) for k, v in value.items())
            elif isinstance(value, list):
                stack.extend((v, free) for v in value)
            elif isinstance(value, str):
                if free and len(value) > MAX_TEXT:
                    raise HttpError(400, f"a label or ref in this create is longer than {MAX_TEXT} characters")
                if "::" in value and value not in allowed:
                    raise HttpError(403, "a party that is neither the account nor the chain's is named")

    def open_contracts(self, party: str, template: str) -> None:
        """An account holds few open contracts of a template that is limited: the account's own active contracts say how many."""
        limit = self.open_limits.get(template)
        if limit is None:
            return
        flt = {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": False}}}}]}
        page = self.ledger.call("POST", "/v2/state/active-contracts-page", {"eventFormat": {"filtersByParty": {party: flt}, "verbose": False}, "maxPageSize": limit})
        if len(page.get("activeContracts") or []) + self.in_flight.count((party, template)) >= limit:   # an execute that got no answer may still commit
            raise HttpError(409, f"this account has {limit} open already: only {limit} at a time")

    def prepare(self, body: dict, ip: str) -> dict:
        party = self.known(body.get("party"))
        commands = self.check_commands(party, body.get("commands"))
        self.prepared.room(pending_owner(ip), party)   # a client or an account at its cap costs the participant nothing: no read, no prepare
        request = {"commandId": str(uuid.uuid4()), "userId": self.user, "actAs": [party], "synchronizerId": self.sync_id(),
                   "commands": commands, "readAs": [], "packageIdSelectionPreference": [], "prefetchContractKeys": [],
                   "verboseHashing": False, "disclosedContracts": body.get("disclosedContracts", [])}   # the JSON API wants every list, though they are optional
        record_by = int(self.wall()) + PENDING_TTL + RECORD_MARGIN   # the participant records it by then or never: the wait for its signature plus a margin
        request["maxRecordTime"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record_by))
        if not isinstance(request["disclosedContracts"], list):
            raise HttpError(400, "disclosedContracts is a list")
        template = commands[0]["CreateCommand"]["templateId"] if "CreateCommand" in commands[0] else None
        limited = template is not None and self.open_limits.get(template) is not None
        # For a limited template the check, the prepare and the entry are one step per account: two prepares do not both see "none open".
        with self.account_lock(party) if limited else contextlib.nullcontext():
            if limited:
                if any(v["template"] == template for v in self.prepared.values(party)):
                    raise HttpError(409, "this account has a transaction of that kind waiting for its signature: execute it first (or wait for it to expire)")
                self.open_contracts(party, template)
            made = self.ledger.call("POST", "/v2/interactive-submission/prepare", request)
            tx, version = made["preparedTransaction"], made["hashingSchemeVersion"]
            cost = (made.get("costEstimation") or {}).get("totalTrafficCostEstimation")
            if not isinstance(cost, int) or isinstance(cost, bool):
                raise HttpError(502, "the ledger gave no estimate of the cost of this transaction")
            if cost > self.max_traffic:
                raise HttpError(403, f"this transaction would cost more than the {self.max_traffic} that this service allows one")
            self.prepared.put(hashlib.sha256(tx.encode()).hexdigest(), {"party": party, "version": version, "hash": base64.b64decode(made["preparedTransactionHash"]),
                                                                       "cost": cost, "template": template, "record_by": record_by}, pending_owner(ip), party)
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
        if not self.proves(self.parties.key(party), found["hash"], raw_signature, ip):   # a wrong signature costs the participant nothing
            raise HttpError(401, "the signature is not this account's signature of the transaction's hash")

        def take():   # the one attempt: the entry is gone before anything is sent, whatever comes of it
            taken = self.prepared.take(key)
            if taken is None:
                raise HttpError(404, "no such prepared transaction for this account, or it has expired: prepare it again")
            return taken

        limited = found["template"] is not None and self.open_limits.get(found["template"]) is not None
        # For a limited template the count of open contracts and the send are one step per account: it holds the lock until the ledger has committed.
        with self.account_lock(party) if limited else contextlib.nullcontext():
            if limited:
                self.open_contracts(party, found["template"])
            found = self.spend(ip, party, found["cost"], take=take)   # an over-budget execute leaves the entry in place and charges nothing
            try:
                done = self.ledger.call("POST", "/v2/interactive-submission/executeAndWait", {
                    "preparedTransaction": tx, "submissionId": str(uuid.uuid4()), "userId": self.user, "hashingSchemeVersion": found["version"],
                    "deduplicationPeriod": {"Empty": {}},
                    "partySignatures": {"signatures": [{"party": party, "signatures": [self.signature(signature, party.split("::")[1])]}]}})
            except HttpError as e:
                if limited and e.status == 502:   # no answer (a timeout, a 5xx): the transaction may commit later, so the next count includes it
                    self.in_flight.add((party, found["template"]), max(found["record_by"] - self.wall(), 0))   # open until it cannot be recorded any more
                raise
        return {"updateId": done["updateId"]}

    def active(self, party: str, identifier_filter: dict, what: str) -> list:
        """The created events of the party's active contracts that match the filter, all pages of one snapshot."""
        self.known(party)
        flt = {"cumulative": [{"identifierFilter": identifier_filter}]}
        request, out = {"eventFormat": {"filtersByParty": {party: flt}, "verbose": False}, "maxPageSize": HOLDINGS_PAGE}, []
        for _ in range(HOLDINGS_PAGES):
            page = self.ledger.call("POST", "/v2/state/active-contracts-page", request)
            out += [(entry.get("contractEntry") or {}).get("JsActiveContract", {}).get("createdEvent") or {} for entry in page.get("activeContracts") or []]
            if not page.get("nextPageToken"):
                return out
            request = {**request, "activeAtOffset": page["activeAtOffset"], "pageToken": page["nextPageToken"]}
        raise HttpError(500, f"the account has more {what} than this service lists")

    def views(self, party: str, interface: str, what: str) -> list:
        """(contract id, view) of the party's contracts of an interface."""
        found = self.active(party, {"InterfaceFilter": {"value": {"interfaceId": interface, "includeInterfaceView": True, "includeCreatedEventBlob": False}}}, what)
        return [(e["contractId"], v.get("viewValue")) for e in found for v in e.get("interfaceViews") or []]

    def holdings(self, party: str) -> dict:
        """The party's own CIP-0056 holdings (the Holding interface's view, owner = the party), all pages of one snapshot."""
        return {"party": party, "holdings": [{"contractId": cid, "instrumentId": v["instrumentId"], "amount": v["amount"], "locked": bool(v.get("lock"))}
                                             for cid, v in self.views(party, HOLDING, "holdings") if isinstance(v, dict) and v.get("owner") == party]}   # a holding the party only observes is not its own

    def allocations(self, party: str) -> dict:
        """The party's own allocations (the Allocation interface's view, the party the sender of the leg): the contract id the participant committed, the specification and the holdings."""
        return {"party": party, "allocations": [{"contractId": cid, "allocation": v["allocation"], "holdingCids": v.get("holdingCids", [])} for cid, v in self.views(party, ALLOCATION, "allocations")
                                                if isinstance(v, dict) and ((v.get("allocation") or {}).get("transferLeg") or {}).get("sender") == party]}

    def open(self, party: str) -> dict:
        """The party's open DepositRequests and RedeemRequests (those the service allows it to create), by contract id, with their arguments."""
        out = {"party": party, "depositRequests": [], "redeemRequests": []}
        for template, key, owner in ((DEPOSIT, "depositRequests", "depositor"), (REDEEM, "redeemRequests", "holder")):
            if template in self.allow:
                found = self.active(party, {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": False}}}, "open requests")
                out[key] = [{"contractId": e["contractId"], "arguments": e["createArgument"]} for e in found if (e.get("createArgument") or {}).get(owner) == party]
        return out


def open_limits_from(allow, deposit_requests: int, given) -> dict:
    """The open limits: the built-in two, and `--open-limit Template=N` (N is a number, or `none` for a create that names no one). SystemExit when an allowed create
    has none: a create names observers, and an account must not be able to make them without end."""
    limits = {ACCEPTANCE: 1, DEPOSIT: deposit_requests}
    for entry in given or []:
        template, _, n = entry.rpartition("=")
        if template not in allow or template.count("#") != 1 or not (n == "none" or n.isdigit() and int(n) >= 1):
            sys.exit(f"--open-limit {entry!r}: Template=N (N from 1, or none) for a template that is an allowed create")
        limits[template] = None if n == "none" else int(n)
    unlimited = [e for e in allow if e.count("#") == 1 and e not in limits]
    if unlimited:
        sys.exit("an allowed create has no open limit: " + ", ".join(unlimited) + " (give --open-limit Template=N, or Template=none for one that names no other party)")
    return limits


def make_server(service: Accounts, host: str, port: int, ip_header: str = None, proxies: int = 1, trusted=TRUSTED_ADDRESSES) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        timeout = 20

        def serve(self, method: str):
            headers = {}
            try:
                body, raw = None, b""
                if method == "POST":
                    try:
                        length = int(self.headers.get("content-length") or 0)
                    except ValueError:
                        length = -1
                    if not 0 <= length <= MAX_BODY:
                        raise HttpError(400, f"the body must be at most {MAX_BODY} bytes")
                    raw = self.rfile.read(length)
                    try:
                        body = json.loads(raw or b"null")
                    except ValueError:
                        raise HttpError(400, "the body is not JSON")
                # Behind reverse proxies the client is the entry that the nearest trusted proxy wrote: the `proxies`-th from the right, and only from a trusted peer.
                ip = client_address(self.client_address[0], ",".join(self.headers.get_all(ip_header, [])) if ip_header else "", proxies, trusted)
                status, out = 200, service.handle(method, urllib.parse.urlsplit(self.path).path, body, ip, raw, self.headers.get("X-Account-Signature"))
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
    p.add_argument("--open-limit", action="append", metavar="TEMPLATE=N", help="open contracts one account may have of an allowed create (#package:Module:Entity=N, or =none for one "
                   "that names no other party); every allowed create needs one; repeat")
    p.add_argument("--accounts-per-day", type=int, default=3, help="accounts made per client address in 24 hours")
    p.add_argument("--requests-per-minute", type=int, default=60, help="requests per client address in a minute")
    p.add_argument("--requests-per-account-minute", type=int, default=ACCOUNT_RATE, help="prepare, execute and holdings requests per account in a minute")
    p.add_argument("--requests-per-network-minute", type=int, default=NETWORK_RATE, help="requests per client network (an IPv4 address, an IPv6 /48) in a minute")
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
    p.add_argument("--max-pending-per-client", type=int, default=10, help="topologies, and prepared transactions, waiting for a signature for one client address (an IPv6 /48) (each)")
    p.add_argument("--max-pending-per-account", type=int, default=PENDING_PER_ACCOUNT, help="prepared transactions waiting for a signature for one account")
    p.add_argument("--accounts-per-day-total", type=int, default=200, help="new accounts in 24 hours, all clients together")
    p.add_argument("--client-ip-header", help="the header in which the reverse proxy puts the client's address, such as X-Forwarded-For")
    p.add_argument("--trusted-proxies", type=int, default=1, help="proxies in front of the service: the client's address is this many entries from the right of --client-ip-header")
    p.add_argument("--trusted-proxy-addresses", default="127.0.0.1,::1", help="comma-separated addresses or networks of the proxies; the header is read only from a peer among them")
    a = p.parse_args(argv)
    token = "" if a.token_file else os.environ.get("LEDGER_TOKEN", "")
    if not (token or a.token_file):
        sys.exit("a token is required: LEDGER_TOKEN or --token-file")
    allow = a.allow or list(DEFAULT_ALLOW)
    if not HINT.match(a.party_hint) or not all(ALLOW_ENTRY.match(e) for e in allow):
        sys.exit("a party hint is letters, digits, - and _; an allowed command is #package:Module:Entity or #package:Module:Entity#Choice")
    open_limits = open_limits_from(allow, a.open_deposit_requests, a.open_limit)
    chain = {}
    if a.chain_parties:
        with open(a.chain_parties) as f:
            chain = json.load(f)
    chain = {f: getattr(a, f"chain_{f}") or chain.get(f) for f in CHAIN_FIELDS}
    if not all(PARTY.match(v or "") for v in chain.values()):
        print("the chain's parties are not all set: creates that name them are refused", file=sys.stderr)
        chain = {}
    try:
        trusted = [ipaddress.ip_network(x.strip(), strict=False) for x in a.trusted_proxy_addresses.split(",") if x.strip()]
    except ValueError as e:
        sys.exit(f"--trusted-proxy-addresses: {e}")
    if a.trusted_proxies < 1:
        sys.exit("--trusted-proxies is at least 1")
    host, _, port = a.listen.rpartition(":")
    service = Accounts(Ledger(a.ledger_url, a.token_file, token), a.user_id, Parties(a.state_file), allow, a.party_hint, a.synchronizer_id, a.topology_protocol_version,
                       Limiter(a.accounts_per_day, DAY), Limiter(a.requests_per_minute, 60), Pending(limit=a.max_pending_topologies, per_owner=a.max_pending_per_client),
                       Pending(limit=a.max_pending_prepared, per_owner=a.max_pending_per_client, per_group=a.max_pending_per_account), chain, open_limits,
                       Limiter(a.executes_per_account_day, DAY), Limiter(a.executes_per_client_day, DAY), Limiter(a.executes_per_day, DAY),
                       Limiter(a.traffic_per_day, DAY), a.max_transaction_traffic, Limiter(a.accounts_per_day_total, DAY),
                       account_rate=Limiter(a.requests_per_account_minute, 60), network_rate=Limiter(a.requests_per_network_minute, 60))
    try:
        service.load_rights(force=True)
    except HttpError as e:
        print(f"the ledger user's rights could not be read now ({e.message}); they are read again when an account is missed", file=sys.stderr)
    if ed25519.Ed25519PublicKey is None:
        print(SLOW_VERIFY_WARNING, file=sys.stderr)
    service.start_sweeper()
    make_server(service, host or "127.0.0.1", int(port), a.client_ip_header, a.trusted_proxies, trusted).serve_forever()


if __name__ == "__main__":
    main()
