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
PROOF_WINDOW = 1   # reth is run with --rpc.eth-proof-window 1
HEAD_TIME = 1000
GATEWAY = "a7e0" + "00" * 18   # the gateway contract's address, 40 lowercase hex digits, as the chain record writes it
LEG_TOPIC = "0x" + keccak256(b"Leg(uint8,bytes32,address,address,uint256,string)").hex()   # the gateway's Leg event
DEPOSIT, WITHDRAWAL, PAYMENT = 1, 2, 3


class RpcError(Exception):
    """An error answer to a call on reth's port."""


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


def rlp_decode(b: bytes):
    """The inverse of rlp(): a list of byte strings and lists."""
    def item(i):
        t = b[i]
        if t < 0x80:
            return b[i:i + 1], i + 1
        if t < 0xB8:
            return b[i + 1:i + 1 + t - 0x80], i + 1 + t - 0x80
        if t < 0xC0:
            n = int.from_bytes(b[i + 1:i + t - 0xB6], "big"); s = i + t - 0xB6
            return b[s:s + n], s + n
        if t < 0xF8:
            n, s = t - 0xC0, i + 1
        else:
            n = int.from_bytes(b[i + 1:i + t - 0xF6], "big"); s = i + t - 0xF6
        end, out, j = s + n, [], s
        while j < end:
            x, j = item(j)
            out.append(x)
        return out, end
    return item(0)[0]


def _len(n: int, base: int) -> bytes:
    if n < 56:
        return bytes([base + n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([base + 55 + len(b)]) + b


class Leg:
    """One Leg event of the gateway, as a test writes it: kind, id (64 hex digits), token and account (40), amount in
    base units, and the party text of a withdrawal."""

    def __init__(self, kind: int, id: str, token: str, account: str, amount: int, party: str = ""):
        self.kind, self.id, self.token, self.account, self.amount, self.party = kind, id, token, account, amount, party

    def data(self) -> bytes:
        word = lambda n: n.to_bytes(32, "big")
        text = self.party.encode()
        return (word(self.kind) + bytes.fromhex(self.id) + bytes(12) + bytes.fromhex(self.token) + bytes(12) + bytes.fromhex(self.account)
                + word(self.amount) + word(0xC0) + word(len(text)) + text + bytes(-len(text) % 32))


def tx(sender: str, nonce: int, gas: int = 21000, price: int = 10, name: str = "", used: int = 21000, size: int = 0) -> dict:
    """`gas` is the transaction's gas limit, as the pool shows it. `used` (the `_used` field) is what the fake reth charges when it
    runs the transaction. A real pool does not know it and the builder never reads it. `size` (the `_size` field) is the number of padding bytes
    after the transaction's hash in its raw form, for a big transaction."""
    h = "0x" + hashlib.sha256(f"{sender}{nonce}{name}".encode()).hexdigest()
    return {"hash": h, "from": sender, "nonce": hex(nonce), "gas": hex(gas), "maxFeePerGas": hex(price), "_used": used, "_size": size}


def raw_of(t: dict) -> str:
    return "0x02" + t["hash"][2:] + "ab" * t.get("_size", 0)  # a typed transaction, as bytes: the hash, then padding


def hash_of(raw: str) -> str:
    return "0x" + raw[4:68]


class FakeReth:
    """The builder-only WebSocket port and the Engine port of one reth. `pool` is txpool_content's pending part."""

    def __init__(self, pool: dict, gas_limit: int = 30_000_000, skip_invalid: bool = True, max_request: int = 15_000_000):
        self.pool, self.gas_limit = pool, gas_limit
        self.fail_proof_reads = 0   # how many of the next eth_getProof calls fail
        self.max_request = max_request   # reth refuses a WebSocket request over 15 MB (the connection is closed, code 1009)
        self.vanished: set = set()       # hashes that txpool_content still lists but eth_getRawTransactionByHash answers null for (replaced or evicted since)
        self.ws_frames: list = []        # the size of each WebSocket request, in characters
        self.batches: list = []          # the number of calls in each JSON-RPC batch request
        # reth's --testing.skip-invalid-transactions, which network/reth/launch.sh always passes. On: a transaction whose gas limit is above the
        # gas the block has left is left out, with its sender's later ones. Off: the build fails on it, as reth 2.5.2 does without the flag.
        self.skip_invalid = skip_invalid
        self.tamper: list = []   # one entry per build, first first: None (build as asked), "extra" (add a transaction nobody asked for), "reorder", or "over_cap" (report gasUsed above the cap); once used up, builds are honest
        self.tamper_always = None   # a way of lying about every build from then on (the same names)
        self.genesis = "0x" + "66" * 32   # the hash of block 0
        self.mined: dict = {}   # hash -> transaction, for every transaction the pool lost when a block holding it became head
        self.engine_calls: list = []   # (method, params)
        self.ws_calls: list = []       # (method, params)
        self.blocks = {HEAD_HASH: {"number": HEAD_NUMBER, "timestamp": HEAD_TIME, "gasLimit": gas_limit}}
        self.raw_blocks: dict = {}
        self.by_number: dict = {}   # number -> the hash of the block most recently built at that height
        self.jwt_failures = 0
        self.tx_legs: dict = {}   # transaction hash -> the Leg events that transaction makes, in order, when it is in a block (or a function from the block's transaction hashes to them)
        self.block_txs: dict = {}   # block hash -> the hashes of its transactions
        self.bad_log_data = None   # bytes to put in place of the first log's data
        self.head = HEAD_HASH   # the block reth's head is at: a forkchoice that fails leaves it where it was
        self.refuse_resend = False   # eth_sendRawTransaction answers an error for every transaction
        self.crash_on_send = False   # the first eth_sendRawTransaction breaks the WebSocket handler (close code 1011), as a dropped connection would
        self.no_state_for_genesis = False   # a persistent reth cannot move back to the genesis block once a block is built: the forkchoice to it is an error
        self.sync_on_final = False   # the forkchoice that makes a new block head, safe and finalized at once answers SYNCING (once)
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
        self.ws_frames.append(len(message))
        if len(message) > self.max_request:
            conn.close(1009, "message too big")
            return
        req = json.loads(message)
        if isinstance(req, list):
            self.batches.append(len(req))
        if isinstance(req, list):   # a JSON-RPC batch: one frame holding an array, answered by one frame holding an array
            conn.send(json.dumps([self._answer(r) for r in req]))
            return
        conn.send(json.dumps(self._answer(req)))

    def _answer(self, req) -> dict:
        self.ws_calls.append((req["method"], req["params"]))
        try:
            return {"jsonrpc": "2.0", "id": req["id"], "result": self._rpc(req["method"], req["params"])}
        except KeyError as e:
            return {"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32601, "message": f"unknown {e}"}}
        except RpcError as e:
            return {"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32000, "message": str(e)}}

    def became_head(self, block_hash):
        """What reth 2.5.2 does when a block becomes head: its transactions leave the pool as mined (and a sender left with none
        is forgotten). Moving the head back to an earlier block puts nothing back."""
        self.head = block_hash
        for hash_ in self.block_txs.get(block_hash, []):
            for sender in list(self.pool):
                for t in self.pool[sender]:
                    if t["hash"] == hash_:
                        self.mined[hash_] = t
                self.pool[sender] = [t for t in self.pool[sender] if t["hash"] != hash_]
                if not self.pool[sender]:
                    del self.pool[sender]

    def chain_txs(self) -> set:
        """The hashes of the transactions of every block on the head's chain (the head and each parent back to the first block reth knows)."""
        out, h = set(), self.head
        while h in self.blocks:
            out.update(self.block_txs.get(h, []))
            h = self.blocks[h].get("parent")
        return out

    def send_raw(self, raw):
        """eth_sendRawTransaction: a transaction already in the pool is `already known`; one reth never saw is refused."""
        hash_ = hash_of(raw)
        if self.crash_on_send:
            self.crash_on_send = False
            raise RuntimeError("the connection broke")
        if self.refuse_resend:
            raise RpcError("refused")
        if hash_ in self.chain_txs():   # in any block on the head's chain: the head's state has the transaction, so the nonce is used
            raise RpcError("nonce too low")
        if any(t["hash"] == hash_ for ts in self.pool.values() for t in ts):
            raise RpcError("already known")
        if hash_ not in self.mined:
            raise RpcError("unknown transaction")
        t = self.mined[hash_]
        self.pool[t["from"]] = sorted([*self.pool.get(t["from"], []), t], key=lambda x: int(x["nonce"], 16))
        return hash_

    def _rpc(self, method, params):
        if method == "txpool_content":
            return {"pending": {s: {str(int(t["nonce"], 16)): t for t in ts} for s, ts in self.pool.items()}, "queued": {}}
        if method == "txpool_status":
            return {"pending": hex(sum(len(ts) for ts in self.pool.values())), "queued": "0x0"}
        if method == "eth_getRawTransactionByHash":
            if params[0] in self.vanished:
                return None
            return next(raw_of(t) for ts in self.pool.values() for t in ts if t["hash"] == params[0])
        if method == "eth_sendRawTransaction":
            return self.send_raw(params[0])
        if method == "eth_getBlockByHash":
            b = self.blocks.get(params[0])
            return b and {"hash": params[0], "number": hex(b["number"]), "timestamp": hex(b["timestamp"]), "gasLimit": hex(b["gasLimit"])}
        if method == "testing_buildBlockV1":
            return self._build(*params)
        if method == "debug_getRawBlock":
            return self.raw_blocks[int(params[0], 16)]
        if method == "eth_getBlockByNumber" and int(params[0], 16) == 0:
            return {"number": "0x0", "hash": self.genesis, "transactions": []}
        if method == "eth_getBlockByNumber":
            return {"number": params[0], "hash": self.by_number.get(int(params[0], 16)),
                    "transactions": [{"hash": t} for t in self.block_txs.get(self.by_number.get(int(params[0], 16)), [])]}
        if method == "debug_executionWitness":
            return {"state": [], "codes": [], "keys": [], "headers": []}
        if method == "eth_getLogs":
            return self._logs(params[0])
        if method == "eth_getProof":   # only the gateway's account and its legs slot are ever asked for
            if self.fail_proof_reads:
                self.fail_proof_reads -= 1
                raise RpcError("the state of the block is not available")
            # reth --rpc.eth-proof-window 1: the state of a block more than one below the head is gone, and the call fails
            if int(params[2], 16) < self.blocks[self.head]["number"] - PROOF_WINDOW:
                raise RpcError(f"distance to target block exceeds maximum proof window {PROOF_WINDOW}")
            return {"codeHash": "0x" + "c0" * 32, "accountProof": ["0xaa01", "0xaa02"],
                    "storageProof": [{"key": params[1][0], "value": "0x00", "proof": ["0xbb01"]}]}
        raise KeyError(method)

    def _run(self, raws):
        """What reth 2.5.2's testing_buildBlockV1 does with a list of transactions: each one runs if its gas limit is no more than the gas the
        block has left (the Ethereum rule: the gas used so far plus the limit is at most the block's gas limit). One that does not fit fails the build, or,
        with skip_invalid, is left out together with its sender's later ones. Returns (the raw transactions that ran, the gas they used)."""
        by_raw = {raw_of(t): t for ts in [*self.pool.values(), *([t] for t in self.mined.values())] for t in ts}
        ran, used, stopped = [], 0, set()
        for raw in raws:
            t = by_raw[raw]
            if t["from"] in stopped:
                continue
            limit = int(t["gas"], 16)
            if limit > self.gas_limit - used:
                if not self.skip_invalid:
                    raise RpcError(f"transaction gas limit {limit} is more than blocks available gas {self.gas_limit - used}")
                stopped.add(t["from"])
                continue
            ran.append(raw)
            used += t["_used"]
        return ran, used

    def _build(self, parent, attributes, raws, extra):
        p = self.blocks[parent]
        raws, gas_used = self._run(raws)
        how = self.tamper.pop(0) if self.tamper else self.tamper_always
        reported = gas_used
        if how == "extra":
            raws = [*raws, "0x02" + "ee" * 32]
        elif how == "reorder":
            raws = raws[::-1]
        elif how == "over_cap":
            reported = self.gas_limit + 1
        number = p["number"] + 1
        header = rlp([bytes.fromhex(parent[2:]), number.to_bytes(4, "big"), gas_used.to_bytes(4, "big"),
                      int(attributes["timestamp"], 16).to_bytes(8, "big")])
        h = "0x" + keccak256(header).hex()
        self.blocks[h] = {"number": number, "timestamp": int(attributes["timestamp"], 16), "gasLimit": self.gas_limit, "parent": parent}
        self.block_txs[h] = [hash_of(r) for r in raws]
        self.by_number[number] = h
        self.raw_blocks[number] = "0x" + rlp([Raw(header), [bytes.fromhex(r[2:]) for r in raws], [], []]).hex()
        payload = {"parentHash": parent, "blockNumber": hex(number), "blockHash": h, "gasLimit": hex(self.gas_limit),
                   "gasUsed": hex(reported), "timestamp": attributes["timestamp"], "transactions": raws}
        return {"executionPayload": payload, "executionRequests": []}

    def _logs(self, flt):
        """The Leg events of the transactions of the block flt names, in log order; other filters match nothing."""
        out = []
        in_block = self.block_txs.get(flt.get("blockHash"), [])
        for hash_ in in_block:
            legs = self.tx_legs.get(hash_, [])
            for leg in legs(in_block) if callable(legs) else legs:   # a function of the block's transactions, for a leg that depends on them
                data = self.bad_log_data if self.bad_log_data is not None and not out else leg.data()
                out.append({"address": "0x" + GATEWAY, "topics": [LEG_TOPIC], "data": "0x" + data.hex(), "blockHash": flt["blockHash"],
                            "transactionHash": hash_, "logIndex": hex(len(out)), "removed": False})
        if flt.get("address") not in ("0x" + GATEWAY, GATEWAY) or flt.get("topics") != [LEG_TOPIC]:
            return []
        return out

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
                status = "VALID"
                if body["method"].startswith("engine_forkchoiceUpdated"):
                    state = body["params"][0]
                    if (reth.no_state_for_genesis and state["headBlockHash"] == HEAD_HASH
                            and any(m.startswith("engine_newPayload") for m, _ in reth.engine_calls)):
                        out = json.dumps({"jsonrpc": "2.0", "id": body["id"], "error": {"code": -38002, "message": f"no state found for block {HEAD_HASH}"}}).encode()
                        self.send_response(200)
                        self.send_header("content-length", str(len(out)))
                        self.end_headers()
                        self.wfile.write(out)
                        return
                    if (reth.sync_on_final and state["headBlockHash"] == state["safeBlockHash"] == state["finalizedBlockHash"]
                            and state["headBlockHash"] != HEAD_HASH):
                        reth.sync_on_final, status = False, "SYNCING"
                    else:
                        reth.became_head(state["headBlockHash"])
                result = ({"status": "VALID"} if body["method"].startswith("engine_newPayload")
                          else {"payloadStatus": {"status": status}})
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
        self.views: dict = {}   # allocation id -> what to change in its interface view (settleBefore, executor, sender, receiver, amount, instrument); None: no view
        self.requests: list = []      # (contract id, create arguments) of the DepositRequest contracts it shows
        self.tokens: list = []        # ... of the GatewayToken contracts
        self.acceptances: list = []   # ... of the WithdrawalAcceptance contracts
        self.holdings: list = []      # (contract id, the Holding interface's view) of the holdings it shows
        self.other_chains: list = []   # more ZkChain contracts the party can see (overrides of chain_args), e.g. built by someone else
        self.chains, self.bad_json = chains, bad_json   # how many ZkChain contracts it shows; a reply that is not JSON
        self.commit = True   # a test can set it False: then a dropped Advance leaves the head alone
        self.drop_but_commit = drop_but_commit   # Advance commits, then the connection is closed without a reply
        self.garbage_reply = False   # Advance is answered with bytes that are not an HTTP reply (http.client.BadStatusLine)
        self.head_fails_after_submit = False   # once Advance has been submitted, reading the ZkChain contract fails (HTTP 500)
        self.head = {"headNumber": str(HEAD_NUMBER), "headHash": HEAD_HASH[2:]}
        # The ZkChain contracts of the builder: the ids that can be exercised now. Each commit archives the contract it exercised and
        # creates a new one with a new id (as Canton does), and a command on an archived or an unknown id is refused.
        self.cids = ["chain-cid"] if chains == 1 else [f"chain-cid-{i}" for i in range(chains)]
        self.consumed: list = []
        self.commit_count = 0
        self.submitted: list = []
        self.queries: list = []
        self.gets: list = []   # the path of each GET it answers (ledger-end, traffic, ...)
        self.bad_auth = 0
        self.traffic: list = []   # the traffic states GET /traffic answers with, one for each read; when none is left it reports none (404)
        self.paid: object = None   # the paidTrafficCost POST /v2/commands/completions shows for the last submitted command; None: no completion shown
        self.completion_queries: list = []   # (query string, body) of each completions read
        self.completions_delay = 0.0   # seconds the completions read takes to answer
        self.answer_time = None   # time.time() when submit-and-wait was answered
        self.completions_fail = False   # the completions read is answered with HTTP 500
        self.outcomes: dict = {}   # command id -> the completion the participant shows for it (None: none yet)
        self.no_completion = False   # a command that gets no answer has no completion either (it is still in progress)
        self.reply_status = None   # Advance is answered with this HTTP status and nothing else: no command is taken, no completion comes
        self.late = False   # Advance is answered with a 503 (a timeout), and the command commits or fails only when `land` is called
        self.pending: list = []   # (command id, header) of the commands `late` holds back
        self.record_time = "2020-01-01T00:00:00.000000Z"   # Canton's time the OffsetCheckpoint of a completions read shows (far in the past: no command's window is over)
        self.land_offset = 43   # the offset `land` gives a decided command's completion
        self.earlier: list = []   # completions of the builder user from before the submit (offset <= the ledger end), as the participant shows them
        self.others: list = []   # completions of other commands, each with its own offset
        self.http = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}"

    def land(self, ok: bool = True, message: str = "rejected") -> None:
        """The commands held back by `late` are decided now: committed (the head moves) or failed (the head stays)."""
        for command_id, header, cid in self.pending:
            no = self.refusal(header, cid) if ok else None   # it is decided now, against the head as it is now, as Canton does
            if ok and not no:
                self.advance(header, cid)
            self.outcomes[command_id] = {"commandId": command_id, "offset": self.land_offset, "updateId": "u1", "status": {}} if ok and not no else \
                {"commandId": command_id, "offset": self.land_offset, "status": {"code": 9, "message": no[2] if no else message}}
        self.pending = []

    def advance(self, header: bytes, cid: str) -> None:
        """A committed Advance: the head moves to the block, the exercised contract is archived and a new one (a new id) is created."""
        self.head = {"headNumber": str(int(self.head["headNumber"]) + 1), "headHash": keccak256(header).hex()}
        self.commit_count += 1
        self.consumed.append(cid)
        self.cids[self.cids.index(cid)] = f"{cid.split('@')[0]}@{self.commit_count}"

    def refusal(self, header: bytes, cid: str):
        """What Canton says to an Advance that cannot run (Chain.daml:137-138, 151), as (HTTP status, error code, cause); None when it can."""
        if cid not in self.cids:
            known = "archived" if cid in self.consumed else "unknown"
            return 404, "CONTRACT_NOT_FOUND", f"Contract could not be found: the contract id is {known}: {cid}"
        parent, number = rlp_decode(header)[:2]
        if parent.hex() != self.head["headHash"]:
            return 409, "INTERPRETATION_ERROR", "the block's parent is not the chain's head"
        if int.from_bytes(number, "big") != int(self.head["headNumber"]) + 1:
            return 409, "INTERPRETATION_ERROR", "the block's number is not the head's plus one"
        return None

    def close(self):
        self.http.shutdown()
        self.http.server_close()

    def chain_args(self):
        return {"operator": "op", "confirmer": "co", "gateway": "gw", "builder": BUILDER, "reader": "rd", "chainId": "770101", "gatewayAddress": GATEWAY,
                "programVK": "11" * 32, "rootC": "22" * 32, "rulesHash": "33" * 32, "gasCap": str(self.gas_cap), **self.head}

    def _allocation_of(self, allocation):
        """Who the allocation is between and what it holds, by default: what the terms or the deposit request that point at it say."""
        for _, a in self.terms:
            if a["allocation"] == allocation:
                return {"sender": a["u"], "receiver": a["v"], "amount": "1.0", "instrument": {"admin": "a", "id": "T"}}
        for _, a in self.requests:
            if a["allocation"] == allocation:
                return {"sender": a["depositor"], "receiver": a["gateway"], "amount": "10.0", "instrument": {"admin": "adm", "id": "TKB"}}
        return {"sender": "?", "receiver": "?", "amount": "1.0", "instrument": {"admin": "a", "id": "T"}}

    def _views(self, allocation):
        """The token standard's AllocationView of an allocation: by default one that fits the terms or the request pointing at it
        (executor = the chain's operator, sender and receiver as they say, settle-before far away)."""
        over = self.views.get(allocation, {})
        if over is None:   # the participant shows no view of it
            return []
        base = self._allocation_of(allocation)
        view = {"allocation": {
            "settlement": {"executor": over.get("executor", "op"), "settlementRef": {"id": "s1", "cid": None},
                           "requestedAt": "2026-01-01T00:00:00Z", "allocateBefore": "2999-01-01T00:00:00Z",
                           "settleBefore": over.get("settleBefore", "2999-01-01T00:00:00Z"), "meta": {"values": {}}},
            "transferLegId": "leg-0",
            "transferLeg": {"sender": over.get("sender", base["sender"]), "receiver": over.get("receiver", base["receiver"]),
                            "amount": over.get("amount", base["amount"]), "instrumentId": over.get("instrument", base["instrument"]), "meta": {"values": {}}}},
            "holdingCids": [], "meta": {"values": {}}}
        return [{"interfaceId": "pkg:Splice.Api.Token.AllocationV1:Allocation", "viewStatus": {"code": 0}, "viewValue": view}]

    def _active(self, template):
        if template.endswith(":Allocation"):   # the token standard's Allocation interface
            ids = [a["allocation"] for _, a in [*self.terms, *self.requests]] if self.allocations is None else self.allocations
            return [{"contractEntry": {"JsActiveContract": {"createdEvent": {
                        "contractId": i, "templateId": "pkg:Some.Token:Allocation", "interfaceViews": self._views(i)}}}}
                    for i in ids]
        if template.endswith(":Holding"):   # the token standard's Holding interface
            return [{"contractEntry": {"JsActiveContract": {"createdEvent": {
                        "contractId": cid, "templateId": "pkg:Some.Token:Holding",
                        "interfaceViews": [{"interfaceId": "pkg:Splice.Api.Token.HoldingV1:Holding", "viewStatus": {"code": 0}, "viewValue": view}]}}}}
                    for cid, view in self.holdings]
        def entry(cid, name, args):
            return {"contractEntry": {"JsActiveContract": {"createdEvent": {
                "contractId": cid, "templateId": f"pkg:Zk.Chain:{name}", "createArgument": args}}}}
        if template.endswith(":ZkChain"):
            own = [entry(cid, "ZkChain", self.chain_args()) for cid in self.cids]
            return own + [entry(f"other-chain-cid-{i}", "ZkChain", {**self.chain_args(), **o}) for i, o in enumerate(self.other_chains)]
        for name, found in (("DepositRequest", self.requests), ("GatewayToken", self.tokens), ("WithdrawalAcceptance", self.acceptances), ("DvpTerms", self.terms)):
            if template.endswith(":" + name):
                return [entry(c, name, a) for c, a in found]
        return []

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
                ledger.gets.append(self.path)
                if self.path == "/traffic":
                    state = ledger.traffic.pop(0) if ledger.traffic else None   # one answer for each read
                    return self._reply(404, {}) if state is None else self._reply(200, state)
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
                if self.path.split("?")[0] == "/v2/commands/completions":
                    ledger.completion_queries.append((self.path, body))
                    time.sleep(ledger.completions_delay)
                    if ledger.completions_fail:
                        return self._reply(500, {"cause": "the participant is down"})
                    shown = [{"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 40}}}},
                             {"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 44, "synchronizerTimes": [{"synchronizerId": "sync::1", "recordTime": ledger.record_time}]}}}},
                             {"completionResponse": {"Completion": {"value": {"commandId": "someone-elses", "offset": 42, "paidTrafficCost": 1}}}}]
                    own = ledger.outcomes.get(ledger.submitted[-1]["commandId"]) if ledger.submitted and not ledger.no_completion else None
                    if own is not None:
                        shown.append({"completionResponse": {"Completion": {"value": {**own, **({"paidTrafficCost": ledger.paid} if ledger.paid is not None else {})}}}})
                    elif ledger.paid is not None and ledger.submitted:
                        shown.append({"completionResponse": {"Completion": {"value": {"commandId": ledger.submitted[-1]["commandId"], "offset": 43, "paidTrafficCost": ledger.paid}}}})
                    shown += [{"completionResponse": {"Completion": {"value": v}}} for v in [*ledger.earlier, *ledger.others]]
                    # as the participant does: only what is after beginExclusive, in offset order, at most `limit` of it
                    def offset(item):
                        return next(iter(item["completionResponse"].values()))["value"]["offset"]
                    shown = sorted((i for i in shown if offset(i) > body.get("beginExclusive", 0)), key=offset)
                    limit = dict(q.split("=") for q in self.path.partition("?")[2].split("&") if "=" in q).get("limit")
                    return self._reply(200, shown[:int(limit)] if limit else shown)
                if self.path == "/v2/commands/submit-and-wait":
                    ledger.submitted.append(body)
                    command_id = body["commandId"]
                    failed = {"commandId": command_id, "offset": 43, "status": {"code": 9, "message": "failed"}}
                    if ledger.refuse and not ledger.fail_but_commit:
                        ledger.outcomes[command_id] = failed
                        return self._reply(409, {"code": "INTERPRETATION_ERROR", "cause": ledger.refuse})
                    if ledger.reply_status:
                        return self._reply(ledger.reply_status, {"cause": "x"})
                    exercise = body["commands"][0]["ExerciseCommand"]
                    header = bytes.fromhex(exercise["choiceArgument"]["headerHex"])
                    no = ledger.refusal(header, exercise["contractId"])
                    if no:   # Canton's own checks: the command is decided at once and fails
                        ledger.outcomes[command_id] = failed
                        return self._reply(no[0], {"code": no[1], "cause": no[2]})
                    if ledger.late:
                        ledger.pending.append((command_id, header, exercise["contractId"]))
                        return self._reply(503, {"code": "REQUEST_TIME_OUT", "cause": "The server was not able to produce a timely response"})
                    if ledger.commit:
                        ledger.advance(header, exercise["contractId"])
                    ledger.outcomes[command_id] = {"commandId": command_id, "offset": 43, "updateId": "u1", "status": {}} if ledger.commit else failed
                    if ledger.garbage_reply:
                        self.close_connection = True
                        return self.wfile.write(b"this is not http\r\n\r\n")
                    if ledger.drop_but_commit:
                        self.close_connection = True
                        return self.connection.shutdown(socket.SHUT_RDWR)
                    if ledger.fail_but_commit:
                        return self._reply(503, {"cause": "timed out"})
                    ledger.answer_time = time.time()
                    return self._reply(200, {"updateId": "u1", "completionOffset": 43})
                self._reply(404, {})
        return H
