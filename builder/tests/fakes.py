"""Fakes for the builder's tests: reth's builder-only WebSocket port and Engine port, the Canton JSON Ledger
API, and (as shell scripts next to this file) the prover input tool and the prover. Nothing here is real."""
import base64, hashlib, hmac, json, os, socket, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from websockets.exceptions import ConnectionClosed
from websockets.sync.server import serve

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from keccak import keccak256

JWT_SECRET = bytes.fromhex("11" * 32)
LEDGER_TOKEN = "ledger-test-token"
BUILDER = "builder::1220aa"
HEAD_HASH = "0x" + "ab" * 32
HEAD_NUMBER = 4
HEAD_TIME = 1000


class Raw(bytes):
    """Already RLP-encoded: put in as it is."""


def rlp(x) -> bytes:
    if isinstance(x, Raw):
        return x
    if isinstance(x, bytes):
        if len(x) == 1 and x[0] < 0x80:
            return x
        return _len(len(x), 0x80) + x
    body = b"".join(rlp(i) for i in x)
    return _len(len(body), 0xC0) + body


def _len(n: int, base: int) -> bytes:
    if n < 56:
        return bytes([base + n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([base + 55 + len(b)]) + b


def tx(sender: str, nonce: int, gas: int = 21000, price: int = 10, name: str = "") -> dict:
    h = "0x" + hashlib.sha256(f"{sender}{nonce}{name}".encode()).hexdigest()
    return {"hash": h, "from": sender, "nonce": hex(nonce), "gas": hex(gas), "maxFeePerGas": hex(price)}


def raw_of(t: dict) -> str:
    return "0x02" + t["hash"][2:]  # a typed transaction, as bytes


class FakeReth:
    """The builder-only WebSocket port and the Engine port of one reth. `pool` is txpool_content's pending part."""

    def __init__(self, pool: dict, gas_limit: int = 30_000_000):
        self.pool, self.gas_limit = pool, gas_limit
        self.engine_calls: list = []   # (method, params)
        self.ws_calls: list = []       # (method, params)
        self.blocks = {HEAD_HASH: {"number": HEAD_NUMBER, "timestamp": HEAD_TIME, "gasLimit": gas_limit}}
        self.raw_blocks: dict = {}
        self.jwt_failures = 0
        self.balance = "0x0a"   # what eth_getProof says the holder's balance is in the block being built
        self.parent_balance = "0x00"   # ... and in Canton's head, the parent
        self.parent_code_hash = "0x" + "c0" * 32   # the token's code hash there; the hash of no code at all means the account is not there
        self.ws = serve(self._ws, "127.0.0.1", 0, max_size=None)
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), self._engine_handler())
        threading.Thread(target=self.ws.serve_forever, daemon=True).start()
        threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.ws_url = f"ws://127.0.0.1:{self.ws.socket.getsockname()[1]}"
        self.engine_url = f"http://127.0.0.1:{self.http.server_address[1]}"

    def close(self):
        self.ws.shutdown()
        self.http.shutdown()
        self.http.server_close()

    def _ws(self, conn):
        try:
            for message in conn:
                self._one(conn, message)
        except ConnectionClosed:
            pass

    def _one(self, conn, message):
        req = json.loads(message)
        self.ws_calls.append((req["method"], req["params"]))
        try:
            result = self._rpc(req["method"], req["params"])
            conn.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "result": result}))
        except KeyError as e:
            conn.send(json.dumps({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": f"unknown {e}"}}))

    def _rpc(self, method, params):
        if method == "txpool_content":
            return {"pending": {s: {str(int(t["nonce"], 16)): t for t in ts} for s, ts in self.pool.items()}, "queued": {}}
        if method == "eth_getRawTransactionByHash":
            return next(raw_of(t) for ts in self.pool.values() for t in ts if t["hash"] == params[0])
        if method == "eth_getBlockByHash":
            b = self.blocks.get(params[0])
            return b and {"hash": params[0], "number": hex(b["number"]), "timestamp": hex(b["timestamp"]), "gasLimit": hex(b["gasLimit"])}
        if method == "testing_buildBlockV1":
            return self._build(*params)
        if method == "debug_getRawBlock":
            return self.raw_blocks[int(params[0], 16)]
        if method == "eth_getBlockByNumber":
            return {"number": params[0], "transactions": []}
        if method == "debug_executionWitness":
            return {"state": [], "codes": [], "keys": [], "headers": []}
        if method == "eth_getProof":
            if params[2] == hex(HEAD_NUMBER):   # the parent: other values and other nodes than the new block's
                return {"codeHash": self.parent_code_hash, "accountProof": ["0xcc01", "0xcc02"],
                        "storageProof": [{"key": params[1][0], "value": self.parent_balance, "proof": ["0xdd01"]}]}
            return {"codeHash": "0x" + "c0" * 32, "accountProof": ["0xaa01", "0xaa02"],
                    "storageProof": [{"key": params[1][0], "value": self.balance, "proof": ["0xbb01"]}]}
        raise KeyError(method)

    def _build(self, parent, attributes, raws, extra):
        p = self.blocks[parent]
        number, gas_used = p["number"] + 1, 21000 * len(raws)
        header = rlp([bytes.fromhex(parent[2:]), number.to_bytes(4, "big"), gas_used.to_bytes(4, "big"),
                      int(attributes["timestamp"], 16).to_bytes(8, "big")])
        h = "0x" + keccak256(header).hex()
        self.blocks[h] = {"number": number, "timestamp": int(attributes["timestamp"], 16), "gasLimit": self.gas_limit}
        self.raw_blocks[number] = "0x" + rlp([Raw(header), [bytes.fromhex(r[2:]) for r in raws], [], []]).hex()
        payload = {"parentHash": parent, "blockNumber": hex(number), "blockHash": h, "gasLimit": hex(self.gas_limit),
                   "gasUsed": hex(gas_used), "timestamp": attributes["timestamp"], "transactions": raws}
        return {"executionPayload": payload, "executionRequests": []}

    def _engine_handler(self):
        reth = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                auth = self.headers.get("authorization", "")
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                if not valid_jwt(auth.removeprefix("Bearer "), JWT_SECRET):
                    reth.jwt_failures += 1
                    self.send_response(401)
                    self.end_headers()
                    return
                reth.engine_calls.append((body["method"], body["params"]))
                result = ({"status": "VALID"} if body["method"].startswith("engine_newPayload")
                          else {"payloadStatus": {"status": "VALID"}})
                out = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}).encode()
                self.send_response(200)
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)
        return H


def valid_jwt(token: str, secret: bytes) -> bool:
    """What reth checks: three parts, HS256, a signature made with the secret, an iat within 60 seconds."""
    try:
        h, c, s = token.split(".")
        unb64 = lambda x: base64.urlsafe_b64decode(x + "=" * (-len(x) % 4))
        good = hmac.new(secret, f"{h}.{c}".encode(), hashlib.sha256).digest()
        return (json.loads(unb64(h))["alg"] == "HS256" and hmac.compare_digest(unb64(s), good)
                and abs(time.time() - json.loads(unb64(c))["iat"]) <= 60)
    except Exception:
        return False


class FakeLedger:
    """The bits of the Canton JSON Ledger API v2 the builder calls. Advance either commits or is refused."""

    def __init__(self, gas_cap=30_000_000, terms=(), refuse=None, fail_but_commit=False, drop_but_commit=False, allocations=None, chains=1, bad_json=False):
        self.gas_cap, self.terms, self.refuse, self.fail_but_commit = gas_cap, list(terms), refuse, fail_but_commit
        self.allocations = allocations   # ids of the active allocations; None: every terms' own allocation is active
        self.views: dict = {}   # allocation id -> what to change in its interface view (settleBefore, executor, sender, receiver); None: no view
        self.other_chains: list = []   # more ZkChain contracts the party can see (overrides of chain_args), e.g. built by someone else
        self.chains, self.bad_json = chains, bad_json   # how many ZkChain contracts it shows; a reply that is not JSON
        self.commit = True   # a test can set it False: then a dropped Advance leaves the head alone
        self.drop_but_commit = drop_but_commit   # Advance commits, then the connection is closed without a reply
        self.garbage_reply = False   # Advance is answered with bytes that are not an HTTP reply (http.client.BadStatusLine)
        self.head_fails_after_submit = False   # once Advance has been submitted, reading the ZkChain contract fails (HTTP 500)
        self.head = {"headNumber": str(HEAD_NUMBER), "headHash": HEAD_HASH[2:]}
        self.submitted: list = []
        self.queries: list = []
        self.bad_auth = 0
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}"

    def close(self):
        self.http.shutdown()
        self.http.server_close()

    def chain_args(self):
        return {"operator": "op", "confirmer": "co", "builder": BUILDER, "reader": "rd", "chainId": "770101",
                "programVK": "11" * 32, "rootC": "22" * 32, "rulesHash": "33" * 32, "gasCap": str(self.gas_cap), **self.head}

    def _views(self, allocation):
        """The token standard's AllocationView of an allocation: by default one that fits the terms pointing at it
        (executor = the chain's operator, sender = u, receiver = v, settle-before far away)."""
        over = self.views.get(allocation, {})
        if over is None:   # the participant shows no view of it
            return []
        terms = next((a for _, a in self.terms if a["allocation"] == allocation), {})
        view = {"allocation": {
            "settlement": {"executor": over.get("executor", "op"), "settlementRef": {"id": "s1", "cid": None},
                           "requestedAt": "2026-01-01T00:00:00Z", "allocateBefore": "2999-01-01T00:00:00Z",
                           "settleBefore": over.get("settleBefore", "2999-01-01T00:00:00Z"), "meta": {"values": {}}},
            "transferLegId": "leg-0",
            "transferLeg": {"sender": over.get("sender", terms.get("u", "u::1")), "receiver": over.get("receiver", terms.get("v", "v::1")),
                            "amount": "1.0", "instrumentId": {"admin": "a", "id": "T"}, "meta": {"values": {}}}},
            "holdingCids": [], "meta": {"values": {}}}
        return [{"interfaceId": "pkg:Splice.Api.Token.AllocationV1:Allocation", "viewStatus": {"code": 0}, "viewValue": view}]

    def _active(self, template):
        if template.endswith(":Allocation"):   # the token standard's Allocation interface
            ids = [a["allocation"] for _, a in self.terms] if self.allocations is None else self.allocations
            return [{"contractEntry": {"JsActiveContract": {"createdEvent": {
                        "contractId": i, "templateId": "pkg:Some.Token:Allocation", "interfaceViews": self._views(i)}}}}
                    for i in ids]
        def entry(cid, name, args):
            return {"contractEntry": {"JsActiveContract": {"createdEvent": {
                "contractId": cid, "templateId": f"pkg:Zk.Chain:{name}", "createArgument": args}}}}
        if template.endswith(":ZkChain"):
            own = [entry(f"chain-cid-{i}" if self.chains != 1 else "chain-cid", "ZkChain", self.chain_args()) for i in range(self.chains)]
            return own + [entry(f"other-chain-cid-{i}", "ZkChain", {**self.chain_args(), **o}) for i, o in enumerate(self.other_chains)]
        return [entry(c, "DvpTerms", a) for c, a in self.terms]

    def _handler(self):
        ledger = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _reply(self, code, obj):
                out = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def _reply_raw(self, code, out):
                self.send_response(code)
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def _body(self):
                return json.loads(self.rfile.read(int(self.headers["content-length"])))

            def _auth(self):
                if self.headers.get("authorization") != f"Bearer {LEDGER_TOKEN}":
                    ledger.bad_auth += 1

            def do_GET(self):
                self._auth()
                self._reply(200, {"offset": 42} if self.path == "/v2/state/ledger-end" else {})

            def do_POST(self):
                self._auth()
                body = self._body()
                if self.path == "/v2/state/active-contracts":
                    ledger.queries.append(body)
                    if ledger.bad_json:
                        return self._reply_raw(200, b"<html>not json")
                    if ledger.head_fails_after_submit and ledger.submitted:
                        return self._reply(500, {"cause": "the participant is down"})
                    flt = body["eventFormat"]["filtersByParty"][BUILDER]["cumulative"][0]["identifierFilter"]
                    tmpl = (flt.get("TemplateFilter") or flt["InterfaceFilter"])["value"].get("templateId") or flt["InterfaceFilter"]["value"]["interfaceId"]
                    return self._reply(200, ledger._active(tmpl))
                if self.path == "/v2/commands/submit-and-wait":
                    ledger.submitted.append(body)
                    if ledger.refuse and not ledger.fail_but_commit:
                        return self._reply(409, {"code": "INTERPRETATION_ERROR", "cause": ledger.refuse})
                    arg = body["commands"][0]["ExerciseCommand"]["choiceArgument"]
                    header = bytes.fromhex(arg["headerHex"])
                    if ledger.commit:
                        ledger.head = {"headNumber": str(int(ledger.head["headNumber"]) + 1), "headHash": keccak256(header).hex()}
                    if ledger.garbage_reply:
                        self.close_connection = True
                        return self.wfile.write(b"this is not http\r\n\r\n")
                    if ledger.drop_but_commit:
                        self.close_connection = True
                        return self.connection.shutdown(socket.SHUT_RDWR)
                    if ledger.fail_but_commit:
                        return self._reply(503, {"cause": "timed out"})
                    return self._reply(200, {"updateId": "u1", "completionOffset": 43})
                self._reply(404, {})
        return H
