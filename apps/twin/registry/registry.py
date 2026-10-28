#!/usr/bin/env python3
"""The registry service of the Canton twins: the token standard's off-ledger registry API (CIP-0056, V1) for the twins of ERC-20
tokens that an Ostia vault holds, and the parts of lock ids. See README.md.

  registry.py --ledger-url <url> --admin <party> --ostia-rpc <url> [--listen 127.0.0.1:8080] [--state-file <path>]

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
    """The parts of the lock ids that payers announced: id -> (receiver, ref). Kept in memory, and appended to `path` (one JSON line each) so
    that a restart does not lose a lock that is paid but not yet in a block."""
    def __init__(self, path: str | None, limit: int):
        self.path, self.limit, self.parts, self.lock = path, limit, {}, threading.Lock()
        if path and os.path.exists(path):
            with open(path) as f:
                for line in f:
                    entry = json.loads(line)
                    self.parts[entry["lockId"]] = (entry["receiver"], entry["ref"])

    def add(self, receiver: str, ref: str) -> str:
        lid = lock_id(receiver, ref)
        with self.lock:
            if lid not in self.parts:
                if len(self.parts) >= self.limit:
                    raise HttpError(503, "the registry holds as many lock ids as it keeps")
                if self.path:
                    with open(self.path, "a") as f:
                        f.write(json.dumps({"lockId": lid, "receiver": receiver, "ref": ref}) + "\n")
                self.parts[lid] = (receiver, ref)
        return lid

    def get(self, lid: str):
        with self.lock:
            return self.parts.get(lid)


class Registry:
    def __init__(self, ledger: Ledger, ostia: Ostia, admin: str, parts: LockParts, ttl: float = 5.0, supply_ttl: float = 10.0):
        self.ledger, self.ostia, self.admin, self.parts, self.ttl, self.supply_ttl = ledger, ostia, admin, parts, ttl, supply_ttl
        self.lock, self.cache, self.supply_cache = threading.Lock(), None, {}

    def _read(self):
        """(rules by token, tokens with more than one active rules, vaults). Cached for `ttl` seconds."""
        with self.lock:
            if self.cache and time.monotonic() - self.cache[0] < self.ttl:
                return self.cache[1]
            rules, ambiguous = {}, set()
            for created, sync in self.ledger.active(RULES, self.admin, blob=True):
                args = created["createArgument"]
                if args.get("admin") != self.admin:
                    continue
                if args["token"] in rules:
                    ambiguous.add(args["token"])
                rules[args["token"]] = {"created": created, "synchronizerId": sync, **args}
            vaults = []
            for created, _ in self.ledger.active(CHAIN, self.admin):
                if created["createArgument"].get("gateway") == self.admin:
                    vaults += [c["contractAddress"] for c in created["createArgument"].get("contracts") or [] if c.get("contractKind") == "Vault"]
            self.cache = (time.monotonic(), (rules, ambiguous, sorted(set(vaults))))
            return self.cache[1]

    def twin(self, instrument_id: str) -> dict:
        """The active rules of the twin whose instrument id is `erc20:<token>`."""
        token = instrument_id[6:] if instrument_id.startswith("erc20:") else ""
        rules, ambiguous, _ = self._read()
        if token in ambiguous:
            raise HttpError(409, f"{instrument_id} has more than one active TwinRules, so none is served")
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
                rules, ambiguous, vaults = self._read()
                return {"ok": not ambiguous, "twins": len(rules), "ambiguous": sorted(ambiguous), "vaults": vaults}
            if path == "/registry/metadata/v1/info":
                return {"adminId": self.admin, "supportedApis": APIS}
            if path == "/registry/metadata/v1/instruments":
                return self.list_instruments(query)
            if segments[:4] == ["registry", "metadata", "v1", "instruments"] and len(segments) == 5:
                return self.instrument(self.twin(segments[4]))
            if path == "/twin/v1/twins":
                rules, ambiguous, vaults = self._read()
                return {"admin": self.admin, "vaults": vaults, "twins": [
                    {"token": t, "instrumentId": {"admin": self.admin, "id": "erc20:" + t}, "name": r["name"], "symbol": r["symbol"],
                     "decimals": int(r["decimals"]), "rulesContractId": r["created"]["contractId"]} for t, r in sorted(rules.items()) if t not in ambiguous]}
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
        rules, ambiguous, _ = self._read()
        tokens = sorted(t for t in rules if t not in ambiguous)
        try:
            size = min(max(int(query.get("pageSize", ["25"])[0]), 1), 100)
            start = int(query.get("pageToken", ["0"])[0])
        except ValueError:
            raise HttpError(400, "pageSize and pageToken are numbers")
        page = tokens[start:start + size]
        out = {"instruments": [self.instrument(rules[t]) for t in page]}
        if start + size < len(tokens):
            out["nextPageToken"] = str(start + size)
        return out

    def announce(self, body) -> dict:
        """A payer hands the receiver and the ref of a lock it is about to pay; it gets the id to pay against and the vaults that take the lock."""
        receiver, ref = (body.get("receiver"), body.get("ref")) if isinstance(body, dict) else (None, None)
        for name, value in (("receiver", receiver), ("ref", ref)):
            if not isinstance(value, str) or not value or len(value.encode()) > MAX_FIELD:
                raise HttpError(400, f"{name} must be non-empty text of at most {MAX_FIELD} bytes")
        if "::" not in receiver or "," in receiver:
            raise HttpError(400, "receiver is not a party id")
        return {"lockId": self.parts.add(receiver, ref), "receiver": receiver, "ref": ref, "vaults": self.vaults()}


def make_server(registry: Registry, host: str, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        timeout = 20

        def serve(self, method: str):
            try:
                url = urllib.parse.urlsplit(self.path)
                body = None
                if method == "POST":
                    length = int(self.headers.get("content-length") or 0)
                    if length > MAX_BODY:
                        raise HttpError(400, "the body is too large")
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
    p.add_argument("--state-file", help="where the lock id parts are kept across restarts")
    p.add_argument("--max-lock-parts", type=int, default=200000)
    a = p.parse_args(argv)
    token = open(a.token_file).read().strip() if a.token_file else os.environ.get("LEDGER_TOKEN", "")
    if not token:
        sys.exit("a read token is required: LEDGER_TOKEN or --token-file")
    host, _, port = a.listen.rpartition(":")
    registry = Registry(Ledger(a.ledger_url, token), Ostia(a.ostia_rpc), a.admin, LockParts(a.state_file, a.max_lock_parts))
    make_server(registry, host or "127.0.0.1", int(port)).serve_forever()


if __name__ == "__main__":
    main()
