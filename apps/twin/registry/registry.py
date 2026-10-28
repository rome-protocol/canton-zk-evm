#!/usr/bin/env python3
"""The registry service of the Canton twins: the token standard's off-ledger registry API (CIP-0056, V1) for the twins of ERC-20
tokens that an Ostia vault holds, and the parts of lock ids. See README.md.

  registry.py --ledger-url <url> --admin <party> --ostia-rpc <url> --chain-id <id> --state-file <path> [--listen 127.0.0.1:8080]

It reads the Canton JSON Ledger API with a read token (the environment variable LEDGER_TOKEN, or --token-file) and Ostia's JSON-RPC.
It holds no key of any party and writes nothing to Canton. What it serves is checked on the ledger by the choices that use it.
"""
import argparse, hashlib, json, os, re, sys, threading, time, urllib.parse, urllib.request
from datetime import datetime, timezone
from decimal import ROUND_DOWN, Decimal, localcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

RULES = "#ostia-twin:Twin.Twin:TwinRules"
CHAIN = "#canton-zk-evm:Zk.Chain:ZkChain"
APIS = {f"splice-api-token-{n}-v1": 1 for n in ("metadata", "holding", "transfer-instruction", "allocation", "allocation-instruction")}
TWIN_DECIMALS = 10
HEX40 = re.compile(r"[0-9a-f]{40}\Z")
PARTY = re.compile(r"[^\s:,]+::1220[0-9a-f]{64}\Z")   # name::namespace: a hash fingerprint is "1220" and 64 lowercase hex digits
LOCK_PARTS_TTL = 14 * 24 * 3600   # seconds an announced lock stays; a payer can announce it again
HEX64 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
BALANCE_OF = "0x70a08231"
MAX_BODY = 64 * 1024
MAX_FIELD = 256
CONTEXT = {"choiceContextData": {"values": {}}, "disclosedContracts": []}   # the twin's choices need no context of a registry


class HttpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


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
    """The parts of the lock ids that payers announced: id -> (receiver, ref, announced at). Kept in memory, and appended to `path` (one JSON line
    each, flushed to disk) so that a restart does not lose a lock that is paid but not yet in a block. An entry lives `ttl` seconds from its
    announcement; a payer announces it again to get it back, and gets the same id. The file is compacted when it loads and when entries expire."""
    def __init__(self, path: str, limit: int, ttl: float = LOCK_PARTS_TTL, clock=time.time):
        self.path, self.limit, self.ttl, self.clock, self.parts, self.lock = path, limit, ttl, clock, {}, threading.Lock()
        self.swept = clock()
        if os.path.exists(path):
            dropped = 0
            with open(path) as f:
                for line in f:
                    try:
                        e = json.loads(line)
                        receiver, ref, at = e["receiver"], e["ref"], float(e.get("at", self.swept))
                        if e["lockId"] != lock_id(receiver, ref):
                            raise ValueError("the id is not the one of the parts")
                    except (ValueError, KeyError, TypeError, AttributeError, UnicodeEncodeError) as err:
                        dropped += 1
                        print(f"state file {path}: a line is dropped ({type(err).__name__}: {err})", file=sys.stderr)
                        continue
                    self.parts[e["lockId"]] = (receiver, ref, max(at, self.parts.get(e["lockId"], (0, 0, 0))[2]))
            self.sweep(force=bool(dropped))

    def _alive(self, entry) -> bool:
        return self.clock() - entry[2] < self.ttl

    def sweep(self, force: bool = False):
        """Drop what expired and rewrite the file when anything went (or `force`). The caller holds the lock, or is the constructor."""
        expired = [k for k, v in self.parts.items() if not self._alive(v)]
        for k in expired:
            del self.parts[k]
        self.swept = self.clock()
        if (expired or force or self._lines != len(self.parts)) and self.path:
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                for k, (receiver, ref, at) in self.parts.items():
                    f.write(json.dumps({"lockId": k, "receiver": receiver, "ref": ref, "at": at}) + "\n")
                f.flush(); os.fsync(f.fileno())
            os.replace(tmp, self.path)
        self._lines = len(self.parts)

    _lines = 0

    def _append(self, lid: str, entry):
        if self.path:
            with open(self.path, "a") as f:
                f.write(json.dumps({"lockId": lid, "receiver": entry[0], "ref": entry[1], "at": entry[2]}) + "\n")
                f.flush(); os.fsync(f.fileno())
            self._lines += 1

    def add(self, receiver: str, ref: str) -> str:
        lid = lock_id(receiver, ref)
        with self.lock:
            now = self.clock()
            if now - self.swept > 3600 or len(self.parts) >= self.limit:
                self.sweep()
            known = self.parts.get(lid)
            if known is None and len(self.parts) >= self.limit:
                raise HttpError(503, "the registry holds as many lock ids as it keeps")
            if known is None or now - known[2] > self.ttl / 2:   # a new one, or an old one that is brought back
                entry = (receiver, ref, now)
                self.parts[lid] = entry
                self._append(lid, entry)
        return lid

    def get(self, lid: str):
        with self.lock:
            found = self.parts.get(lid)
            return found if found and self._alive(found) else None


class Registry:
    def __init__(self, ledger: Ledger, ostia: Ostia, admin: str, parts: LockParts, chain_id, ttl: float = 5.0, supply_ttl: float = 10.0):
        self.ledger, self.ostia, self.admin, self.parts, self.chain_id, self.ttl, self.supply_ttl = ledger, ostia, admin, parts, str(chain_id), ttl, supply_ttl
        self.lock, self.cache, self.supply_cache = threading.Lock(), None, {}

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
        out = {"id": "erc20:" + rules["token"], "name": rules["name"], "symbol": rules["symbol"], "decimals": TWIN_DECIMALS,
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

    def handle(self, method: str, path: str, query: dict, body):
        segments = [urllib.parse.unquote(s) for s in path.strip("/").split("/")]
        if method == "GET":
            if path == "/healthz":
                try:
                    rules, problems, vaults = self._read()
                except HttpError as e:
                    return {"ok": False, "error": e.message}
                return {"ok": not problems["pinnedWithoutRules"], "twins": len(rules), **problems, "vaults": vaults}
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
                return {"lockId": segments[3], "receiver": found[0], "ref": found[1]}
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
                return self.announce(body)
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

    def announce(self, body) -> dict:
        """A payer hands the receiver and the ref of a lock it is about to pay; it gets the id to pay against and the vaults that take the lock."""
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
        vaults = self.vaults()
        return {"lockId": self.parts.add(receiver, ref), "receiver": receiver, "ref": ref, "vaults": vaults}


def make_server(registry: Registry, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        timeout = 20

        def serve(self, method: str):
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
                status, out = 200, registry.handle(method, url.path, urllib.parse.parse_qs(url.query), body)
            except HttpError as e:
                status, out = e.status, {"error": e.message}
            except Exception as e:   # the ledger or Ostia did not answer, or answered something else than expected
                print(f"{method} {self.path}: {type(e).__name__}: {e}", file=sys.stderr)
                status, out = 500, {"error": "the registry could not read what it needs"}
            data = json.dumps(out).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
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
    p.add_argument("--max-lock-parts", type=int, default=200000)
    p.add_argument("--lock-parts-ttl-days", type=float, default=LOCK_PARTS_TTL / 86400, help="how long an announced lock is kept; a payer announces it again")
    a = p.parse_args(argv)
    token = open(a.token_file).read().strip() if a.token_file else os.environ.get("LEDGER_TOKEN", "")
    if not token:
        sys.exit("a read token is required: LEDGER_TOKEN or --token-file")
    host, _, port = a.listen.rpartition(":")
    registry = Registry(Ledger(a.ledger_url, token), Ostia(a.ostia_rpc), a.admin, LockParts(a.state_file, a.max_lock_parts, a.lock_parts_ttl_days * 86400), a.chain_id)
    make_server(registry, host or "127.0.0.1", int(port)).serve_forever()


if __name__ == "__main__":
    main()
