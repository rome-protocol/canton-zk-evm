#!/usr/bin/env python3
"""The registry service of the Canton twins: the token standard's off-ledger registry API (CIP-0056, V1) for the twins of ERC-20
tokens that an Ostia vault holds, and the parts of lock ids. See README.md.

  registry.py --ledger-url <url> --admin <party> --ostia-rpc <url> --chain-id <id> --state-file <path> [--listen 127.0.0.1:8080]

It reads the Canton JSON Ledger API with a read token (the environment variable LEDGER_TOKEN, or --token-file) and Ostia's JSON-RPC.
It holds no key of any party and writes nothing to Canton. What it serves is checked on the ledger by the choices that use it.
"""
import argparse, collections, hashlib, ipaddress, json, os, re, sys, threading, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal, localcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RULES = "#ostia-twin:Twin.Twin:TwinRules"
ACCEPTANCE = "#ostia-twin:Twin.Twin:TwinAcceptance"
CHAIN = "#canton-zk-evm:Zk.Chain:ZkChain"
APIS = {f"splice-api-token-{n}-v1": 1 for n in ("metadata", "holding", "transfer-instruction", "allocation", "allocation-instruction")}
TWIN_DECIMALS = 10
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
PARTY = re.compile(r"[^\s:,]+::1220[0-9a-f]{64}\Z")   # name::namespace: a hash fingerprint is "1220" and 64 lowercase hex digits
LOCK_PARTS_TTL = 6 * 3600   # seconds an announced lock stays when nobody announces it again: the Bridge page announces a lock again each time it works on one that is not settled
PARTS_PER_RECEIVER = 20     # live announcements for one receiver (a Canton party)
PARTS_PER_CLIENT = 100      # live announcements from one client network (an IPv4 address, an IPv6 /48)
ANNOUNCE_PER_MINUTE = 20          # announcements a minute from one client network
ANNOUNCE_PER_MINUTE_TOTAL = 300   # and from all clients together: a backstop over the per-client counts
TRUSTED_ADDRESSES = (ipaddress.ip_network("127.0.0.1"), ipaddress.ip_network("::1"))
HEX64 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
BALANCE_OF = "0x70a08231"
MAX_BODY = 64 * 1024
MAX_FIELD = 256
CONTEXT = {"choiceContextData": {"values": {}}, "disclosedContracts": []}   # the twin's choices need no context of a registry


class HttpError(Exception):
    def __init__(self, status: int, message: str, retry_after: int = None):
        super().__init__(message)
        self.status, self.message, self.retry_after = status, message, retry_after


def norm(address: str):
    """An IP address; an IPv4 address inside an IPv6 one (::ffff:a.b.c.d) is the IPv4 address. ValueError when it is not an address."""
    a = ipaddress.ip_address(address.strip())
    return a.ipv4_mapped or a if a.version == 6 else a


def client_net(address: str) -> str:
    """What the limits count a client by: an IPv4 address as it is, an IPv6 address as its /48 (a subscriber holds a whole /64, and some hold a /48). Not an address: as it is."""
    try:
        a = norm(address)
    except ValueError:
        return address
    return str(ipaddress.ip_network((a, 48), strict=False)) if a.version == 6 else str(a)


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


class Rate:
    """At most `count` hits per key in `window` seconds (429 with the wait after that). `check` refuses as `hit` would and counts nothing."""
    def __init__(self, count: int, window: float = 60, clock=time.monotonic):
        self.count, self.window, self.clock, self.hits, self.lock = count, window, clock, {}, threading.Lock()

    def _room(self, key: str, create: bool):
        now = self.clock()
        q = self.hits.setdefault(key, collections.deque()) if create else self.hits.get(key, collections.deque())
        while q and q[0] <= now - self.window:
            q.popleft()
        if len(q) >= self.count:
            raise HttpError(429, "Too many moves were started just now. Try again in a minute.", int(q[0] + self.window - now) + 1)
        return q, now

    def check(self, key: str) -> None:
        with self.lock:
            self._room(key, False)

    def hit(self, key: str) -> None:
        with self.lock:
            q, now = self._room(key, True)
            q.append(now)
        if len(self.hits) > 10000:   # a flood of client networks must not grow this without end
            self.prune()

    def used(self, key: str) -> int:
        with self.lock:
            now = self.clock()
            return sum(t > now - self.window for t in self.hits.get(key, ()))

    def prune(self) -> None:
        with self.lock:
            now = self.clock()
            self.hits = {k: q for k, q in self.hits.items() if q and q[-1] > now - self.window}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def lock_id(receiver: str, ref: str) -> str:
    """The id of the EVM payment that locks an ERC-20 for `receiver` under `ref`: Chain.daml's `lockId`."""
    return hashlib.sha256(f"lock,{receiver},{ref}".encode()).hexdigest()


def twin_amount(base_units: int, erc20_decimals: int) -> str:
    """An ERC-20 amount in base units as a twin amount (a Daml Decimal: 10 decimal places, rounded down)."""
    with localcontext() as ctx:
        ctx.prec = 100
        return format((Decimal(base_units) / Decimal(10) ** erc20_decimals).quantize(Decimal(1).scaleb(-TWIN_DECIMALS), ROUND_DOWN), "f")


def http_json(url: str, body, headers: dict, timeout: float = 20):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data, {"content-type": "application/json", **headers})
    with urllib.request.urlopen(request, timeout=timeout) as r:
        return json.load(r)


class Ledger:
    """A read-only view of the Canton JSON Ledger API (v2)."""
    def __init__(self, url: str, token: str):
        self.url, self.auth = url.rstrip("/"), {"authorization": f"Bearer {token}"}

    def active(self, template: str, party: str, blob: bool = False) -> list:
        """(created event, synchronizer id) of each active contract of a template that `party` sees."""
        offset = http_json(self.url + "/v2/state/ledger-end", None, self.auth)["offset"]
        flt = {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": blob}}}}]}
        body = {"eventFormat": {"filtersByParty": {party: flt}, "verbose": False}, "activeAtOffset": offset}
        found = http_json(self.url + "/v2/state/active-contracts", body, self.auth)
        return [(e["contractEntry"]["JsActiveContract"]["createdEvent"], e["contractEntry"]["JsActiveContract"].get("synchronizerId"))
                for e in found if "JsActiveContract" in e["contractEntry"]]


    def active_pages(self, template: str, party: str, size: int):
        """The created event of each active contract of a template that `party` sees, one page of at most `size` at a time (the participant refuses a
        list longer than its limit). Every page is read at the ledger end that one request gave, named in each request: the participant refuses a page
        token used with another offset than the first request named."""
        offset = http_json(self.url + "/v2/state/ledger-end", None, self.auth)["offset"]
        flt = {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": False}}}}]}
        body = {"eventFormat": {"filtersByParty": {party: flt}, "verbose": False}, "activeAtOffset": offset, "maxPageSize": size}
        while True:
            out = http_json(self.url + "/v2/state/active-contracts-page", body, self.auth)
            for e in out["activeContracts"]:
                if "JsActiveContract" in e["contractEntry"]:
                    yield e["contractEntry"]["JsActiveContract"]["createdEvent"]
            if not out.get("nextPageToken"):
                return
            body = {**body, "pageToken": out["nextPageToken"]}


class Ostia:
    """What Ostia's JSON-RPC says of the vaults."""
    def __init__(self, url: str):
        self.url = url

    def balance(self, token: str, holder: str) -> int:
        call = {"to": "0x" + token, "data": BALANCE_OF + holder.rjust(64, "0")}
        reply = http_json(self.url, {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [call, "latest"]}, {})
        result = reply.get("result")
        if not isinstance(result, str) or not HEX64.match(result):
            raise ValueError(f"eth_call balanceOf gave {str(reply)[:120]}")
        return int(result, 16)


class LockParts:
    """The parts of the lock ids that payers announced: id -> (receiver, ref, announced at, the receiver's acceptance contract id). Kept in memory, and appended to `path` (one JSON line
    each, flushed to disk) so that a restart does not lose a lock that is paid but not yet in a block. An entry lives `ttl` seconds from its latest announcement: a payer announces the same
    parts again to keep them (the Bridge page does at every step of a lock that is not settled), and gets the same id. The file is compacted when it loads and when entries expire.
    The store has three caps on live entries: `limit` in all, `per_client` for one client network (the announcer's IPv4 address or IPv6 /48) and `per_receiver` for one receiver from one
    client network (so that a network that fills a receiver's room leaves the receiver's own network its room), so that one party cannot fill what everyone needs (503 for the first,
    429 for the other two)."""
    def __init__(self, path: str, limit: int, ttl: float = LOCK_PARTS_TTL, clock=time.time, per_receiver: int = PARTS_PER_RECEIVER, per_client: int = PARTS_PER_CLIENT):
        self.path, self.limit, self.ttl, self.clock, self.parts, self.lock = path, limit, ttl, clock, {}, threading.Lock()
        self.per_receiver, self.per_client = per_receiver, per_client
        self.clients = {}   # id -> (client network that announced it, the time of its latest line in the file); entries from before the clients were kept have none
        self.by_receiver, self.by_client = collections.Counter(), collections.Counter()   # by_receiver is keyed (receiver, client network)
        self.swept = clock()
        if os.path.exists(path):
            dropped = 0
            with open(path) as f:
                for line in f:
                    try:
                        e = json.loads(line)
                        receiver, ref, at, acceptance = e["receiver"], e["ref"], float(e.get("at", self.swept)), e.get("acceptance")
                        client = e.get("client") or ""
                        if e["lockId"] != lock_id(receiver, ref) or not isinstance(client, str):
                            raise ValueError("the id is not the one of the parts")
                    except (ValueError, KeyError, TypeError, AttributeError, UnicodeEncodeError) as err:
                        dropped += 1
                        print(f"state file {path}: a line is dropped ({type(err).__name__}: {err})", file=sys.stderr)
                        continue
                    at = max(at, self.parts.get(e["lockId"], (0, 0, 0))[2])
                    self.parts[e["lockId"]] = (receiver, ref, at, acceptance)
                    self.clients[e["lockId"]] = (client, at)
            self.sweep(force=bool(dropped))

    def _alive(self, entry) -> bool:
        return self.clock() - entry[2] < self.ttl

    def _count(self):
        """The live counts per receiver and client network, and per client network, worked out from the entries (the caller holds the lock, or is the constructor)."""
        self.by_receiver, self.by_client = collections.Counter(), collections.Counter()
        for lid, (receiver, _, _, _) in self.parts.items():
            owner = self.clients.get(lid, ("",))[0]
            self.by_receiver[(receiver, owner)] += 1
            if owner:
                self.by_client[owner] += 1

    def sweep(self, force: bool = False):
        """Drop what expired and rewrite the file when anything went (or `force`). The caller holds the lock, or is the constructor."""
        expired = [k for k, v in self.parts.items() if not self._alive(v)]
        for k in expired:
            del self.parts[k]
            self.clients.pop(k, None)
        self.swept = self.clock()
        self._count()
        if (expired or force or self._lines != len(self.parts)) and self.path:
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                for k, (receiver, ref, at, acceptance) in self.parts.items():
                    f.write(json.dumps({"lockId": k, "receiver": receiver, "ref": ref, "at": at, "acceptance": acceptance, "client": self.clients.get(k, ("",))[0]}) + "\n")
                f.flush(); os.fsync(f.fileno())
            os.replace(tmp, self.path)
        self._lines = len(self.parts)

    _lines = 0

    def _append(self, lid: str, entry, client: str):
        if self.path:
            with open(self.path, "a") as f:
                f.write(json.dumps({"lockId": lid, "receiver": entry[0], "ref": entry[1], "at": entry[2], "acceptance": entry[3], "client": client}) + "\n")
                f.flush(); os.fsync(f.fileno())
            self._lines += 1

    def _full(self, receiver: str, client: str):
        """The refusal for an announcement of new parts that the caps do not allow, or None."""
        if len(self.parts) >= self.limit:
            return HttpError(503, "The Bridge has started too many moves in the last few hours. Try again in a few hours.")
        if self.by_receiver[(receiver, client)] >= self.per_receiver:
            return HttpError(429, "Too many moves to this Canton account were started in the last few hours. Try again later.", int(self.ttl))
        if client and self.by_client[client] >= self.per_client:
            return HttpError(429, "This network has started too many moves in the last few hours. Try again later, or from another network.", int(self.ttl))
        return None

    def _forget(self, lid: str) -> None:
        """Remove an entry and its counts (the caller holds the lock)."""
        entry, owner = self.parts.pop(lid, None), self.clients.pop(lid, ("", 0))[0]
        if entry is not None and self.by_receiver[(entry[0], owner)] > 0:
            self.by_receiver[(entry[0], owner)] -= 1
        if owner and self.by_client[owner] > 0:
            self.by_client[owner] -= 1

    def add(self, receiver: str, ref: str, acceptance: str, client: str = "") -> str:
        lid = lock_id(receiver, ref)
        with self.lock:
            now = self.clock()
            if now - self.swept > (60 if len(self.parts) >= self.limit else 3600):   # a full store is swept at most once a minute
                self.sweep()
            known = self.parts.get(lid)
            if known is not None and not self._alive(known):
                self._forget(lid)
                known = None
            if known is None:
                refused = self._full(receiver, client)
                if refused and refused.status == 429 and now - self.swept > 10:   # entries that have expired still count until a sweep: look again with them gone, at most every ten seconds
                    self.sweep()
                    refused = self._full(receiver, client)
                if refused:
                    raise refused
                self.by_receiver[(receiver, client)] += 1
                if client:
                    self.by_client[client] += 1
                self.clients[lid] = (client, 0)
            # Announcing again keeps the entry: it lives `ttl` from now, whoever announces it (the client that first announced it keeps the count). The file is written when the entry is new,
            # when its acceptance changed, or when its latest line is older than half a life: a restart then reads a time at most that far back.
            owner, logged = self.clients.get(lid, (client, 0))
            entry = (receiver, ref, now, acceptance)
            self.parts[lid] = entry
            if known is None or known[3] != acceptance or now - logged > self.ttl / 2:
                self.clients[lid] = (owner, now)
                self._append(lid, entry, owner)
        return lid

    def get(self, lid: str):
        with self.lock:
            found = self.parts.get(lid)
            return found if found and self._alive(found) else None

    def live(self) -> int:
        """The entries held (some may have expired and not been swept yet)."""
        with self.lock:
            return len(self.parts)


class Registry:
    def __init__(self, ledger: Ledger, ostia: Ostia, admin: str, parts: LockParts, chain_id, ttl: float = 5.0, supply_ttl: float = 10.0, page_size: int = 100,
                 announce_rate: Rate = None, announce_total: Rate = None):
        self.ledger, self.ostia, self.admin, self.parts, self.chain_id, self.ttl, self.supply_ttl = ledger, ostia, admin, parts, str(chain_id), ttl, supply_ttl
        self.lock, self.cache, self.supply_cache = threading.Lock(), None, {}
        self.page_size = page_size
        self.announce_rate, self.announce_total = announce_rate or Rate(ANNOUNCE_PER_MINUTE), announce_total or Rate(ANNOUNCE_PER_MINUTE_TOTAL)   # per client network; and over everyone
        self.acceptances, self.acceptances_error = None, "not read yet"   # party -> the contract id of its active TwinAcceptance of the admin; None until the first read

    def _read(self):
        """(rules by token, problems, vaults), from the one chain record of `chain_id` whose gateway is the admin. The twins are the ones the chain
        record pins (`ZkChain.twins`), each with the pinned `TwinRules` contract and decimals: the legs of `Advance` accept no other. `problems`
        names the pinned tokens whose rules are not active, and the active rules that no pin names. Cached for `ttl` seconds."""
        with self.lock:
            if self.cache and time.monotonic() - self.cache[0] < self.ttl:
                return self.cache[1]
            chains = [c for c, _ in self.ledger.active(CHAIN, self.admin)
                      if c["createArgument"].get("gateway") == self.admin and str(c["createArgument"].get("chainId")) == self.chain_id]
            if len(chains) != 1:
                raise HttpError(500, f"the ledger has {len(chains)} active chain records of chain {self.chain_id} for this gateway, not exactly one")
            chain = chains[0]["createArgument"]
            active = {c["contractId"]: (c, sync) for c, sync in self.ledger.active(RULES, self.admin, blob=True) if c["createArgument"].get("admin") == self.admin}
            rules, missing = {}, []
            for pin in chain.get("twins") or []:
                hit = active.pop(pin["twinRules"], None)
                if hit is None or hit[0]["createArgument"].get("token") != pin["twinToken"]:
                    missing.append(pin["twinToken"])
                    continue
                created, sync = hit
                rules[pin["twinToken"]] = {"created": created, "synchronizerId": sync, **created["createArgument"], "decimals": pin["twinDecimals"]}
            vaults = sorted({c["contractAddress"] for c in chain.get("contracts") or [] if c.get("contractKind") == "Vault"})
            problems = {"pinnedWithoutRules": sorted(missing), "unpinnedRules": sorted(active)}   # the second is a cross-check only
            self.cache = (time.monotonic(), (rules, problems, vaults))
            return self.cache[1]

    def refresh_acceptances(self):
        """Read every active TwinAcceptance of the admin, a page at a time, into the index party -> contract id. Off the request path: a request reads the
        index only. A read that fails keeps the last index and says so in /healthz."""
        try:
            found = {}
            for c in self.ledger.active_pages(ACCEPTANCE, self.admin, self.page_size):
                a = c["createArgument"]
                if a.get("admin") == self.admin and isinstance(a.get("party"), str):
                    found.setdefault(a["party"], c["contractId"])
            self.acceptances, self.acceptances_error = found, None
        except Exception as e:
            self.acceptances_error = f"{type(e).__name__}: {e}"[:200]
            print(f"acceptances: {self.acceptances_error}", file=sys.stderr)

    def keep_acceptances_fresh(self, every: float = 10.0, stop: threading.Event | None = None):
        """refresh_acceptances now, then every `every` seconds on a thread of its own."""
        self.refresh_acceptances()
        stop = stop or threading.Event()

        def loop():
            while not stop.wait(every):
                self.refresh_acceptances()
        threading.Thread(target=loop, daemon=True).start()
        return stop

    def twin(self, instrument_id: str) -> dict:
        """The pinned rules of the twin whose instrument id is `erc20:<token>`."""
        token = instrument_id[6:] if instrument_id.startswith("erc20:") else ""
        rules = self._read()[0]
        if token not in rules:
            raise HttpError(404, f"no twin {instrument_id}")
        return rules[token]

    def vaults(self) -> list:
        return self._read()[2]

    def instrument(self, rules: dict) -> dict:
        out = {"id": "erc20:" + rules["token"], "name": rules["name"], "symbol": rules["symbol"], "decimals": min(int(rules["decimals"]), TWIN_DECIMALS),
               "paused": False, "supportedApis": APIS}
        supply = self.supply(rules)
        if supply:
            out["totalSupply"], out["totalSupplyAsOf"] = supply
        return out

    def supply(self, rules: dict):
        """(the vaults' balance of the token as a twin amount, the time it was read), or None when Ostia cannot say. Cached for `supply_ttl`."""
        token = rules["token"]
        with self.lock:
            hit = self.supply_cache.get(token)
        if hit and time.monotonic() - hit[0] < self.supply_ttl:
            return hit[1]
        try:
            total = sum(self.ostia.balance(token, v) for v in self.vaults())
            value = (twin_amount(total, int(rules["decimals"])), now_iso())
        except Exception as e:
            print(f"supply of {token}: {e}", file=sys.stderr)
            return None
        with self.lock:
            self.supply_cache[token] = (time.monotonic(), value)
        return value

    def disclosed(self, rules: dict) -> dict:
        c = rules["created"]
        if not c.get("createdEventBlob") or not rules.get("synchronizerId"):
            raise HttpError(500, "the participant gave no created event blob or synchronizer for the rules")
        return {"templateId": c["templateId"], "contractId": c["contractId"], "createdEventBlob": c["createdEventBlob"],
                "synchronizerId": rules["synchronizerId"]}

    def factory(self, rules: dict, extra: dict) -> dict:
        return {"factoryId": rules["created"]["contractId"],
                "choiceContext": {"choiceContextData": {"values": {}}, "disclosedContracts": [self.disclosed(rules)]}, **extra}

    def checked_instrument(self, args, instrument) -> dict:
        if not isinstance(instrument, dict) or not isinstance(instrument.get("id"), str):
            raise HttpError(400, "the choice arguments carry no instrument id")
        if args.get("expectedAdmin") != self.admin or instrument.get("admin") != self.admin:
            raise HttpError(400, "the admin is not this registry's")
        return self.twin(instrument["id"])

    # ---- the routes

    def handle(self, method: str, path: str, query: dict, body, client: str = ""):
        segments = [urllib.parse.unquote(s) for s in path.strip("/").split("/")]
        if method == "GET":
            if path == "/healthz":
                try:
                    rules, problems, vaults = self._read()
                except HttpError as e:
                    return {"ok": False, "error": e.message}
                return {"ok": not problems["pinnedWithoutRules"] and self.acceptances is not None, "twins": len(rules), **problems, "vaults": vaults,
                        "acceptances": len(self.acceptances or {}), "acceptancesError": self.acceptances_error,
                        "lockParts": {"held": self.parts.live(), "limit": self.parts.limit, "perReceiver": self.parts.per_receiver, "perClient": self.parts.per_client,
                                      "announcementsLastMinute": self.announce_total.used("all"), "announcementsPerMinute": self.announce_total.count}}
            if path == "/registry/metadata/v1/info":
                return {"adminId": self.admin, "supportedApis": APIS}
            if path == "/registry/metadata/v1/instruments":
                return self.list_instruments(query)
            if segments[:4] == ["registry", "metadata", "v1", "instruments"] and len(segments) == 5:
                return self.instrument(self.twin(segments[4]))
            if path == "/twin/v1/twins":
                rules, _, vaults = self._read()
                return {"admin": self.admin, "vaults": vaults, "twins": [
                    {"token": t, "instrumentId": {"admin": self.admin, "id": "erc20:" + t}, "name": r["name"], "symbol": r["symbol"],
                     "decimals": int(r["decimals"]), "rulesContractId": r["created"]["contractId"]} for t, r in sorted(rules.items())]}
            if segments[:3] == ["twin", "v1", "lock-parts"] and len(segments) == 4:
                found = self.parts.get(segments[3])
                if not found:
                    raise HttpError(404, "no such lock id")
                current = (self.acceptances or {}).get(found[0])   # the index's current acceptance; a part saved before acceptances were kept has none of its own
                return {"lockId": segments[3], "receiver": found[0], "ref": found[1], "acceptance": current or found[3]}
        elif method == "POST":
            if path == "/registry/transfer-instruction/v1/transfer-factory":
                args = self.choice_arguments(body)
                t = args.get("transfer")
                rules = self.checked_instrument(args, t.get("instrumentId") if isinstance(t, dict) else None)
                return self.factory(rules, {"transferKind": "self" if t.get("sender") == t.get("receiver") else "direct"})
            if path == "/registry/allocation-instruction/v1/allocation-factory":
                args = self.choice_arguments(body)
                a = args.get("allocation")
                leg = a.get("transferLeg") if isinstance(a, dict) else None
                return self.factory(self.checked_instrument(args, leg.get("instrumentId") if isinstance(leg, dict) else None), {})
            if segments[:3] == ["registry", "transfer-instruction", "v1"] and len(segments) == 6 and segments[4] == "choice-contexts":
                raise HttpError(404, "the twin completes a transfer at once: it has no transfer instruction")
            if segments[:3] == ["registry", "allocations", "v1"] and len(segments) == 6 and segments[4:5] == ["choice-contexts"] \
                    and segments[5] in ("execute-transfer", "withdraw", "cancel"):
                return CONTEXT   # the allocation's choices read nothing from a registry
            if path == "/twin/v1/lock-parts":
                return self.announce(body, client_net(client) if client else "")
        raise HttpError(404, "no such route")

    @staticmethod
    def choice_arguments(body) -> dict:
        args = body.get("choiceArguments") if isinstance(body, dict) else None
        if not isinstance(args, dict):
            raise HttpError(400, "choiceArguments is required")
        return args

    def list_instruments(self, query: dict) -> dict:
        rules = self._read()[0]
        tokens = sorted(rules)
        try:
            size = min(max(int(query.get("pageSize", ["25"])[0]), 1), 100)
            start = int(query.get("pageToken", ["0"])[0])
        except ValueError:
            raise HttpError(400, "pageSize and pageToken are numbers")
        if start < 0:
            raise HttpError(400, "pageToken is not a position in the list")
        page = tokens[start:start + size]
        out = {"instruments": [self.instrument(rules[t]) for t in page]}
        if start + size < len(tokens):
            out["nextPageToken"] = str(start + size)
        return out

    def announce(self, body, client: str = "") -> dict:
        """A payer hands the receiver and the ref of a lock it is about to pay; it gets the id to pay against and the vaults that take the lock. A receiver that has not
        accepted twins (no active TwinAcceptance in the index) is refused with 409: a lock for it would be refused by Canton. The answer carries the contract id of
        the receiver's acceptance, and the parts keep it: the builder reads that one contract and believes nothing else."""
        # The rate per client network counts every announcement, a refused one too: junk costs the service something, so each network is limited. The ceiling over everyone counts only
        # the announcements that are well formed (it is checked first, but hit after the checks below): a flood of junk from many networks then cannot fill what everyone shares.
        self.announce_rate.check(client)
        self.announce_total.check("all")
        self.announce_rate.hit(client)
        receiver, ref = (body.get("receiver"), body.get("ref")) if isinstance(body, dict) else (None, None)
        for name, value in (("receiver", receiver), ("ref", ref)):
            try:
                ok = isinstance(value, str) and 0 < len(value.encode()) <= MAX_FIELD
            except UnicodeEncodeError:
                ok = False
            if not ok:
                raise HttpError(400, f"{name} must be non-empty text of at most {MAX_FIELD} bytes")
        if not PARTY.match(receiver):
            raise HttpError(400, "receiver is not a party id (name::1220 and 64 lowercase hex digits)")
        token = body.get("token")
        if token is not None:   # optional: a payer that says which token it locks gets no answer for a token that has no twin
            if not isinstance(token, str) or not HEX40.match(token):
                raise HttpError(400, "token is 40 lowercase hex digits")
            if token not in self._read()[0]:
                raise HttpError(404, f"no twin erc20:{token}")
        if self.acceptances is None:
            raise HttpError(503, "the acceptance index is not ready")
        acceptance = self.acceptances.get(receiver)
        if acceptance is None:
            raise HttpError(409, "the receiver has not accepted twins: its party must sign a TwinAcceptance first")
        self.announce_total.hit("all")   # a valid announcement for a receiver that accepted twins: the only kind that counts against the ceiling over everyone
        vaults = self.vaults()
        return {"lockId": self.parts.add(receiver, ref, acceptance, client), "receiver": receiver, "ref": ref, "acceptance": acceptance, "vaults": vaults}


def make_server(registry: Registry, host: str, port: int, ip_header: str = None, proxies: int = 1, trusted=TRUSTED_ADDRESSES) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        timeout = 20

        def serve(self, method: str):
            headers = {}
            try:
                url = urllib.parse.urlsplit(self.path)
                body = None
                if method == "POST":
                    try:
                        length = int(self.headers.get("content-length") or 0)
                    except ValueError:
                        length = -1
                    if not 0 <= length <= MAX_BODY:
                        raise HttpError(400, "the content length is not a size up to the limit")
                    try:
                        body = json.loads(self.rfile.read(length) or b"null")
                    except ValueError:
                        raise HttpError(400, "the body is not JSON")
                # Behind a reverse proxy the client is the entry that the nearest trusted proxy wrote: the `proxies`-th from the right, and only from a trusted peer.
                client = client_address(self.client_address[0], ",".join(self.headers.get_all(ip_header, [])) if ip_header else "", proxies, trusted)
                status, out = 200, registry.handle(method, url.path, urllib.parse.parse_qs(url.query), body, client)
            except HttpError as e:
                status, out = e.status, {"error": e.message}
                if e.retry_after is not None:
                    headers["retry-after"] = str(e.retry_after)
            except Exception as e:   # the ledger or Ostia did not answer, or answered something else than expected
                print(f"{method} {self.path}: {type(e).__name__}: {e}", file=sys.stderr)
                status, out = 500, {"error": "the registry could not read what it needs"}
            data = json.dumps(out).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            for k, v in headers.items():
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
    p.add_argument("--admin", required=True, help="the twins' admin party (the gateway party)")
    p.add_argument("--ostia-rpc", required=True)
    p.add_argument("--listen", default="127.0.0.1:8080")
    p.add_argument("--token-file", help="a file with the read token; the environment variable LEDGER_TOKEN is used when it is not given")
    p.add_argument("--chain-id", required=True, help="the chain whose chain record (ZkChain) and vaults are served; exactly one active record must exist")
    p.add_argument("--state-file", required=True, help="where the lock id parts are kept across restarts")
    p.add_argument("--max-lock-parts", type=int, default=200000, help="live lock announcements in all")
    p.add_argument("--max-lock-parts-per-receiver", type=int, default=PARTS_PER_RECEIVER, help="live lock announcements for one receiver (a Canton party)")
    p.add_argument("--max-lock-parts-per-client", type=int, default=PARTS_PER_CLIENT, help="live lock announcements from one client network (an IPv4 address or an IPv6 /48)")
    p.add_argument("--lock-parts-ttl-hours", type=float, default=LOCK_PARTS_TTL / 3600, help="how long an announced lock is kept without a new announcement; a payer announces it again to keep it")
    p.add_argument("--announcements-per-minute", type=int, default=ANNOUNCE_PER_MINUTE, help="lock announcements per client network (an IPv4 address or an IPv6 /48) in a minute")
    p.add_argument("--announcements-per-minute-total", type=int, default=ANNOUNCE_PER_MINUTE_TOTAL, help="lock announcements from all clients together in a minute")
    p.add_argument("--client-ip-header", help="the header in which the reverse proxy puts the client's address, such as X-Real-IP: the announcement limits count clients by it (without it every client is the proxy)")
    p.add_argument("--trusted-proxies", type=int, default=1, help="proxies in front of the service: the client's address is this many entries from the right of --client-ip-header")
    p.add_argument("--trusted-proxy-addresses", default="127.0.0.1,::1", help="comma-separated addresses or networks of the proxies; the header is read only from a peer among them")
    a = p.parse_args(argv)
    token = open(a.token_file).read().strip() if a.token_file else os.environ.get("LEDGER_TOKEN", "")
    if not token:
        sys.exit("a read token is required: LEDGER_TOKEN or --token-file")
    host, _, port = a.listen.rpartition(":")
    try:
        trusted = [ipaddress.ip_network(x.strip(), strict=False) for x in a.trusted_proxy_addresses.split(",") if x.strip()]
    except ValueError as e:
        sys.exit(f"--trusted-proxy-addresses: {e}")
    if a.trusted_proxies < 1:
        sys.exit("--trusted-proxies is at least 1")
    if min(a.max_lock_parts, a.max_lock_parts_per_receiver, a.max_lock_parts_per_client, a.announcements_per_minute, a.announcements_per_minute_total) < 1 or a.lock_parts_ttl_hours <= 0:
        sys.exit("the lock part limits are at least 1, and the lock parts' life is more than 0 hours")
    parts = LockParts(a.state_file, a.max_lock_parts, a.lock_parts_ttl_hours * 3600, per_receiver=a.max_lock_parts_per_receiver, per_client=a.max_lock_parts_per_client)
    registry = Registry(Ledger(a.ledger_url, token), Ostia(a.ostia_rpc), a.admin, parts, a.chain_id, announce_rate=Rate(a.announcements_per_minute), announce_total=Rate(a.announcements_per_minute_total))
    registry.keep_acceptances_fresh()
    make_server(registry, host or "127.0.0.1", int(port), a.client_ip_header, a.trusted_proxies, trusted).serve_forever()


if __name__ == "__main__":
    main()
