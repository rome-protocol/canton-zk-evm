#!/usr/bin/env python3
"""The builder: makes one block, gets it proven and submits it to Canton. See README.md.

  builder.py once [--exclude <tx hash>]... [--read-as <party>]... [--disclosed <file>] [--package-id <id>]
  builder.py run [--read-as <party>]... [--disclosed <file>] [--package-id <id>] [--idle-ms 500] [--strategy on_demand] [--gather-ms 0]
                 [--heartbeat-seconds 0] [--test] [--status-file <path>] [--exclude-cooldown-seconds 600]

It builds a block, reads the Canton legs the block's transactions asked the gateway contract for, finds each leg's Canton
side, and builds the block again without any transaction whose leg has none. Only then does it prove the block and
submit it, with exactly the legs the block recorded.

Exit status: 0 if Canton committed the block, 2 if Canton refused it or did not take it (reth is moved back to Canton's head) or if it is
not known whether it committed ("committed": null; reth is left where it is: an Advance with no answer is settled by its own command id,
README.md), 1 on any other failure (reth is moved
back too, where it had moved). One JSON line on stdout says which, whatever the failure.
"""
import argparse, base64, contextlib, fcntl, functools, hashlib, hmac, http.client, json, math, os, re, shutil, signal, subprocess, sys, threading, time, urllib.error, urllib.request, uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from websockets.sync.client import connect

from journal import Attempt, Journal, STRATEGIES, check_settings, completions_paused, iso, pause_completions, paid_traffic_cost, parse_traffic, read_traffic as journal_read_traffic, traffic_used
from keccak import keccak256

ROOT = Path(__file__).resolve().parent.parent
ZERO32 = "0x" + "00" * 32
UNIT = 10**10   # a Canton token has 10 decimals, and so has its wrapped form: one wrapped unit is 0.0000000001 on Canton
LEG_TOPIC = "0x" + keccak256(b"Leg(uint8,bytes32,address,address,uint256,string)").hex()   # the gateway contract's Leg event
DEPOSIT, WITHDRAWAL, PAYMENT = 1, 2, 3   # the kinds of leg, as the gateway contract numbers them
KINDS = {DEPOSIT: "deposit", WITHDRAWAL: "withdrawal", PAYMENT: "payment"}
EMPTY_LIST = b"\xc0"   # the RLP of a list with nothing in it; the transactions of an empty block
CHAIN = "#canton-zk-evm:Zk.Chain:ZkChain"
TERMS = "#canton-zk-evm:Zk.Chain:DvpTerms"
DEPOSIT_REQUEST = "#canton-zk-evm:Zk.Chain:DepositRequest"
GATEWAY_TOKEN = "#canton-zk-evm:Zk.Chain:GatewayToken"
ACCEPTANCE = "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"
ALLOCATION = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation"
HOLDING = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding"


class BuilderError(Exception):
    pass


class ProvingError(BuilderError):
    """The input tool or the prover failed, or gave back a proof that is not this block's. `kept` is the hashes of the block's
    transactions: the loop uses them to find a transaction that cannot be proven."""
    def __init__(self, message: str, kept: list):
        super().__init__(message)
        self.kept = kept


@dataclass
class Config:
    ws_url: str            # reth's builder-only WebSocket port: testing, debug, txpool and eth
    engine_url: str        # reth's Engine API port
    jwt_secret: bytes      # the per-run Engine secret
    ledger_url: str        # Canton's JSON Ledger API
    ledger_user: str
    ledger_token: str      # bearer token for the Ledger API; empty if the participant needs none
    party: str             # the builder party
    fee_recipient: str
    genesis: str
    work_dir: str
    make_input_cmd: str    # <block.json> <witness.json> <genesis.json> <out.bin>
    prove_cmd: str         # <input.bin> <out-folder>; leaves <out-folder>/wrapped-proof.hex
    read_as: tuple = ()    # more parties whose contracts the builder may read (--read-as); the builder never acts as them
    disclosed: list = field(default_factory=list)   # contracts passed with Advance as they are (--disclosed)
    package_id: str = ""   # the Daml package version Advance runs under (--package-id): sent as packageIdSelectionPreference; empty: Canton picks by package name
    resolve_seconds: float = 300.0   # how long an Advance with no answer may still commit: after it, with no completion seen, Canton's head decides
    ledger_token_file: str = ""   # a file holding the bearer token, read again on every Ledger call; it replaces ledger_token
    traffic_url: str = ""         # where the builder's participant reports its traffic (CZE_TRAFFIC_URL); empty: the traffic is not read
    max_block_tx_bytes: int = 65536   # the most raw transaction bytes a block is offered (--max-block-tx-bytes): our participant's Daml work grows with the Advance argument, about 23 ms per KB in each of two passes

    @classmethod
    def from_env(cls) -> "Config":
        e = os.environ
        state = Path(e.get("CZE_STATE_DIR", ROOT / "state"))
        def need(k):
            if not e.get(k):
                raise BuilderError(f"set {k}")
            return e[k]
        try:
            jwt_secret = bytes.fromhex((state / "jwt.hex").read_text().strip())
        except (OSError, ValueError) as err:
            raise BuilderError(f"cannot read the Engine secret {state / 'jwt.hex'} (hex, as launch.sh makes it): {err}") from err
        try:
            resolve_seconds = float(e.get("CZE_RESOLVE_SECONDS", 300))
        except ValueError as err:
            raise BuilderError(f"CZE_RESOLVE_SECONDS is not a number: {err}") from err
        if not resolve_seconds >= MIN_RESOLVE_SECONDS:   # the window is judged on Canton's time and the builder's clock: a short one is a few seconds of skew away from a wrong answer
            raise BuilderError(f"CZE_RESOLVE_SECONDS must be at least {MIN_RESOLVE_SECONDS:g} (the window starts on the builder's clock and Canton's time decides it), not {resolve_seconds:g}")
        return cls(
            ws_url=f"ws://127.0.0.1:{e.get('RETH_WS_PORT', 8546)}",
            engine_url=f"http://127.0.0.1:{e.get('RETH_ENGINE_PORT', 8551)}",
            jwt_secret=jwt_secret,
            ledger_url=e.get("CZE_LEDGER_URL", "http://127.0.0.1:7575"),
            traffic_url=e.get("CZE_TRAFFIC_URL", ""),
            ledger_user=need("CZE_LEDGER_USER"), ledger_token=e.get("CZE_LEDGER_TOKEN", ""), ledger_token_file=e.get("CZE_LEDGER_TOKEN_FILE", ""),
            party=need("CZE_BUILDER_PARTY"), fee_recipient=need("CZE_FEE_RECIPIENT"),
            genesis=e.get("CZE_GENESIS", str(ROOT / "network" / "genesis.json")),
            work_dir=e.get("CZE_WORK_DIR", str(state / "builder")),
            make_input_cmd=e.get("CZE_MAKE_INPUT_CMD", str(ROOT / "prover" / "make-input.sh")),
            prove_cmd=e.get("CZE_PROVE_CMD", str(ROOT / "prover" / "prove-one.sh")),
            resolve_seconds=resolve_seconds)


# ---- reth ------------------------------------------------------------------------------------------------------

def jwt_token(secret: bytes, now: int | None = None) -> str:
    """The Engine API's token: HS256 over {"iat": now}, signed with the shared secret."""
    enc = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=")
    signing = enc(b'{"alg":"HS256","typ":"JWT"}') + b"." + enc(json.dumps({"iat": int(now or time.time())}).encode())
    return (signing + b"." + enc(hmac.new(secret, signing, hashlib.sha256).digest())).decode()


def post_json(url: str, body: dict, headers: dict, timeout: float = 120) -> object:
    request = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers})
    with urllib.request.urlopen(request, timeout=timeout) as r:
        return json.load(r)


class Reth:
    def __init__(self, cfg: Config, ws):
        self.cfg, self.ws, self.next_id = cfg, ws, 0
        self.imported: list = []   # the (hash, raw transaction) pairs of the block the builder last made reth's head
        self.packed: dict = {}     # how the last build's transactions were chosen: `packed` (gas_used or gas_limits), and `offered`; `pack_reason` when gas_limits is a fallback

    def call(self, method: str, params: list):
        """A call on the builder-only WebSocket port."""
        self.next_id += 1
        self.ws.send(json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}))
        reply = json.loads(self.ws.recv())
        if "error" in reply:
            raise BuilderError(f"{method} failed: {reply['error']}")
        return reply["result"]

    def call_many(self, method: str, params_list: list, limit: int | None = None) -> list:
        """The same method for each of the params, as JSON-RPC batches on the WebSocket port: one batch, split only when its request would be
        over `limit` bytes (reth refuses a WebSocket request over 15 MB). The results are in the order of params_list."""
        limit = WS_REQUEST_BYTES if limit is None else limit
        out: list = []
        batch, size = [], 2
        for params in params_list:
            self.next_id += 1
            req = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}
            n = len(json.dumps(req)) + 1
            if batch and size + n > limit:
                out.extend(self._send_batch(method, batch))
                batch, size = [], 2
            batch.append(req)
            size += n
        if batch:
            out.extend(self._send_batch(method, batch))
        return out

    def _send_batch(self, method: str, batch: list) -> list:
        self.ws.send(json.dumps(batch))
        replies = json.loads(self.ws.recv())
        if not isinstance(replies, list):   # a single answer to the whole batch is an error
            raise BuilderError(f"{method} batch failed: {replies.get('error') if isinstance(replies, dict) else replies}")
        by_id = {r.get("id"): r for r in replies}
        out = []
        for req in batch:
            reply = by_id.get(req["id"])
            if reply is None or "error" in reply:
                raise BuilderError(f"{method} failed: {reply['error'] if reply else 'no answer in the batch'}")
            out.append(reply["result"])
        return out

    def engine(self, method: str, params: list):
        auth = {"authorization": "Bearer " + jwt_token(self.cfg.jwt_secret)}
        try:
            reply = post_json(self.cfg.engine_url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, auth)
        except urllib.error.URLError as e:
            raise BuilderError(f"{method} failed: {e}") from e
        if "error" in reply:
            raise BuilderError(f"{method} failed: {reply['error']}")
        return reply["result"]

    def forkchoice(self, head: str, safe: str, finalized: str):
        state = {"headBlockHash": head, "safeBlockHash": safe, "finalizedBlockHash": finalized}
        status = self.engine("engine_forkchoiceUpdatedV3", [state, None])["payloadStatus"]["status"]
        if status != "VALID":
            raise BuilderError(f"engine_forkchoiceUpdatedV3 answered {status}")


SAVED_FILE = "kept-transactions.json"   # in the work folder: the transactions of the block being made, until Canton has it or reth has them back


def saved_path(cfg: Config) -> Path:
    return Path(cfg.work_dir) / SAVED_FILE


def save_kept(cfg: Config, pairs: list, attempt: "Attempt | None" = None) -> None:
    """Writes the (hash, raw transaction) pairs of the block about to be made, atomically and to disk, before reth takes them out of its
    pool: reth does not give an unwound block's transactions back, so after a crash this file is all that is left of them. With a journal,
    each entry also names the run and attempt, so that the next run can close that attempt's record (`Producer.restore`)."""
    if not pairs:
        return
    path = saved_path(cfg)
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w") as f:
            ref = {"run": attempt.journal.run_id, "attempt": attempt.seq} if attempt is not None and attempt.journal is not None else {}
            f.write(json.dumps([{"hash": h, "raw": raw, **ref} for h, raw in pairs]))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except OSError as e:
        raise BuilderError(f"cannot save the block's transactions to {path}: {e}") from e


def clear_saved(cfg: Config) -> None:
    """Called once Canton has the block or the transactions are back in reth's pool. A file that cannot be removed is harmless: sent
    again, its transactions are `already known` or have a used nonce."""
    try:
        saved_path(cfg).unlink(missing_ok=True)
    except OSError:
        pass


UNRESOLVED_FILE = "unresolved.json"   # in the work folder: the Advance whose answer did not arrive, until it is settled


class Unresolved(BuilderError):
    """The command of an Advance with no answer has no completion yet and its window is not over: nothing may be decided."""


def unresolved_path(cfg: Config) -> Path:
    return Path(cfg.work_dir) / UNRESOLVED_FILE


def save_unresolved(cfg: Config, resolve: dict) -> None:
    """Written to disk before the unknown outcome is reported, so that a restart settles the command before it moves reth anywhere."""
    path = unresolved_path(cfg)
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w") as f:
            f.write(json.dumps(resolve))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        fd = os.open(path.parent, os.O_RDONLY)   # the new name has to survive a crash too, as the journal's does
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as e:
        raise BuilderError(f"cannot save the unresolved command to {path}: {e}") from e


def load_unresolved(cfg: Config) -> dict | None:
    try:
        found = json.loads(unresolved_path(cfg).read_text())
        if isinstance(found.get("commandId"), str) and isinstance(found.get("hash"), str) and type(found.get("begin")) is int \
                and type(found.get("submittedAt")) in (int, float) and math.isfinite(found["submittedAt"]) and found["submittedAt"] > 0:   # the window starts there: a record with no time (or NaN, infinity, zero, a negative one) is not one to settle by it
            return found
    except FileNotFoundError:
        return None
    except (OSError, ValueError, AttributeError) as e:
        raise BuilderError(f"cannot read {unresolved_path(cfg)}: {e}") from e
    raise BuilderError(f"{unresolved_path(cfg)} is not an unresolved command")


def clear_unresolved(cfg: Config) -> None:
    try:
        unresolved_path(cfg).unlink(missing_ok=True)
    except OSError:
        pass


def genesis_hash(reth: Reth) -> str:
    """The hash of the chain's block 0 on this reth."""
    found = reth.call("eth_getBlockByNumber", ["0x0", False])
    if not isinstance(found, dict) or not isinstance(found.get("hash"), str):
        raise BuilderError("reth did not answer with its genesis block")
    return found["hash"]


def check_chain(reth: Reth, u: dict) -> None:
    """The in-doubt record names the chain it was made on (the genesis hash). A record from another chain, left behind when that chain was
    taken down and a new one was started, is not this chain's command: it is refused, and the person who runs the builder removes it."""
    if isinstance(u.get("genesis"), str) and u["genesis"] != genesis_hash(reth):
        raise BuilderError(f"the in-doubt command {u['commandId']} in {unresolved_path(reth.cfg)} was made on another chain (genesis {u['genesis']}, "
                           f"this reth's is {genesis_hash(reth)}): if that chain is gone, remove that file and {saved_path(reth.cfg)}")


def put_back(reth: Reth) -> list:
    """reth does not return an unwound block's transactions to its pool, so the builder sends them again. A transaction the pool already
    has, or one whose nonce is used, is not a problem. Returns [{transaction, error}] for the ones reth refused for another reason: they
    are not in the pool, and the caller reports them. The saved copy is cleared when the transactions have been sent; when sending raises, nothing is forgotten
    (the list and the saved copy stay), so a second put_back or the next start's recover_saved sends them all again."""
    lost = resend(reth, reth.imported)
    reth.imported = []   # only after the resend returned: if it dies midway, the failure handler's put_back sends everything again
    clear_saved(reth.cfg)
    return lost


RESENT_ALREADY = ("already known", "known transaction", "nonce too low", "already imported")   # reth's answers that mean the transaction is not lost


def resend(reth: Reth, pairs: list) -> list:
    """Sends (hash, raw transaction) pairs to reth's pool again. Returns [{transaction, error}] for the ones reth refused for a reason
    other than already having them or the nonce being used: those are not in the pool."""
    lost = []
    for hash_, raw in pairs:
        try:
            reth.call("eth_sendRawTransaction", [raw])
        except BuilderError as e:
            if not any(m in str(e).lower() for m in RESENT_ALREADY):
                lost.append({"transaction": hash_, "error": str(e)})
    return lost


def price(t: dict) -> int:
    return int(t.get("maxFeePerGas") or t.get("gasPrice") or "0x0", 16)


MIN_TX_GAS = 21000   # the least gas any transaction uses
WS_REQUEST_BYTES = 10_000_000   # the most a request to reth's WebSocket port may hold: reth refuses one over 15 MB (a batch of fetches is split by this; the offered raw hex stays under it)


def choose_txs(pending: dict, budget: int, exclude: set, used_each: int | None = None) -> list:
    """Takes transactions from reth's pending pool, best price first, each sender's in nonce order, until the gas
    budget is used. A transaction whose gas limit is more than the budget left, or that is excluded, ends its sender's turn: its
    followers could not run without it. What a chosen transaction takes off the budget is its gas limit, or `used_each` when that is given."""
    queues = [[t for _, t in sorted(by_nonce.items(), key=lambda kv: int(kv[0]))] for by_nonce in pending.values()]
    chosen = []
    while queues:
        queues.sort(key=lambda q: price(q[0]), reverse=True)
        head = queues[0].pop(0)
        limit = int(head["gas"], 16)
        if head["hash"] in exclude or limit > budget:
            queues.pop(0)
            continue
        chosen.append(head)
        budget -= limit if used_each is None else used_each
        queues = [q for q in queues if q]
    return chosen


def rlp_item(b: bytes, i: int) -> tuple:
    """(start, end, payload start) of the RLP item at i."""
    p = b[i]
    if p < 0x80:
        return i, i + 1, i
    if p < 0xB8:
        return i, i + 1 + p - 0x80, i + 1
    if p < 0xC0 or p >= 0xF8:
        n = p - (0xB7 if p < 0xC0 else 0xF7)
        return i, i + 1 + n + int.from_bytes(b[i + 1:i + 1 + n], "big"), i + 1 + n
    return i, i + 1 + p - 0xC0, i + 1


def split_block(raw: bytes) -> tuple:
    """The header and the transaction list of a block's RLP, each as it sits there."""
    _, end, at = rlp_item(raw, 0)
    h0, h1, _ = rlp_item(raw, at)
    t0, t1, _ = rlp_item(raw, h1)
    if end != len(raw):
        raise BuilderError("the raw block is not one RLP list")
    return raw[h0:h1], raw[t0:t1]


# ---- Canton ----------------------------------------------------------------------------------------------------

COMPLETION_IDLE_MS = 1000   # how long the completions stream waits for another completion before it ends
COMPLETION_TIMEOUT = 5.0    # seconds a completions read waits in all
COMPLETION_LIMIT = 500      # completions a read of the command's own outcome takes at most; a full page is followed by the next
MIN_RESOLVE_SECONDS = 120.0   # the least CZE_RESOLVE_SECONDS: the window starts on the builder's clock, so it must be long beside the skew the clocks may have
SKEW_SECONDS = 30.0           # Canton's time further than this ahead of the builder's clock is a skew, not a window that has passed
COMPLETION_READS = 20       # pages one look for a command's completion reads at most


def record_seconds(text) -> float | None:
    """Canton's record time (an ISO 8601 UTC string, up to nanoseconds, as in "2026-10-23T10:00:00.123456789Z") as epoch seconds, or None
    when it is not one."""
    match = re.fullmatch(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z", text) if isinstance(text, str) else None
    if not match:
        return None
    whole = datetime.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    return whole + float("0." + match.group(2)) if match.group(2) else whole


def completion_in(items: list, command_id: str) -> tuple:
    """(the command's outcome in a completions read, the last offset the read reached, Canton's time the read reached). The outcome is None
    when the read shows no completion of the command, else {"committed": True, "updateId", "completionOffset"} (status code 0 or no status)
    or {"committed": False, "reason"} (any other status code). Canton's time is the latest OffsetCheckpoint record time in the read (epoch
    seconds; with several synchronizers in one checkpoint, the earliest of them), None when the read has no checkpoint with one."""
    found, last, reached = None, None, None
    for item in items:
        response = item.get("completionResponse", {}) if isinstance(item, dict) else {}
        for kind in ("Completion", "OffsetCheckpoint"):
            value = response.get(kind, {}).get("value") if isinstance(response.get(kind), dict) else None
            if isinstance(value, dict) and type(value.get("offset")) is int:
                last = value["offset"] if last is None else max(last, value["offset"])
        checkpoint = response.get("OffsetCheckpoint", {}).get("value") if isinstance(response.get("OffsetCheckpoint"), dict) else None
        times = checkpoint.get("synchronizerTimes") if isinstance(checkpoint, dict) else None
        stamps = [record_seconds(t.get("recordTime")) for t in times if isinstance(t, dict)] if isinstance(times, list) else []
        if stamps and None not in stamps:
            reached = min(stamps) if reached is None else max(reached, min(stamps))
        done = response.get("Completion", {}).get("value") if isinstance(response.get("Completion"), dict) else None
        if not isinstance(done, dict) or done.get("commandId") != command_id:
            continue
        status = done.get("status") if isinstance(done.get("status"), dict) else {}
        code = status.get("code", 0)
        if code in (0, None):
            update_id, offset = done.get("updateId"), done.get("offset")
            found = {"committed": True, "updateId": update_id if isinstance(update_id, str) else None,
                     "completionOffset": offset if type(offset) is int else None}
        else:
            found = {"committed": False, "reason": f"Canton failed the command (status {code}): {str(status.get('message', ''))[:500]}"}
        break
    return found, last, reached


class Ledger:
    def __init__(self, cfg: Config):
        self.cfg = cfg

    @property
    def auth(self) -> dict:
        """The bearer header. A token file is read on every call, so a token that is rotated needs no restart."""
        token = Path(self.cfg.ledger_token_file).read_text().strip() if self.cfg.ledger_token_file else self.cfg.ledger_token
        return {"authorization": "Bearer " + token} if token else {}

    def end(self) -> int:
        """The ledger end: the offset after everything the participant has recorded so far."""
        request = urllib.request.Request(self.cfg.ledger_url + "/v2/state/ledger-end", headers=self.auth)
        with urllib.request.urlopen(request, timeout=60) as r:
            return int(json.load(r)["offset"])

    def completion(self, command_id: str, begin: int) -> dict | None:
        """What the builder user's completions after offset `begin` say about the command: {"committed": True, "updateId", "completionOffset"}
        or {"committed": False, "reason"}, or None while there is no completion of it (it may still be in progress). Raises when the
        completions cannot be read."""
        return self.completion_and_time(command_id, begin)[0]

    def completion_and_time(self, command_id: str, begin: int) -> tuple:
        """(`completion`, Canton's time the read reached: the latest OffsetCheckpoint record time in the completions after `begin`, epoch
        seconds, None when there is none). A command that has no completion once this time is past the last moment it could commit never
        will have one. Raises when the completions cannot be read."""
        reached = None
        for _ in range(COMPLETION_READS):
            body = {"userId": self.cfg.ledger_user, "parties": [self.cfg.party], "beginExclusive": begin}
            try:
                items = post_json(f"{self.cfg.ledger_url}/v2/commands/completions?limit={COMPLETION_LIMIT}&stream_idle_timeout_ms={COMPLETION_IDLE_MS}",
                                  body, self.auth, timeout=COMPLETION_TIMEOUT)
            except urllib.error.HTTPError as e:
                e.close()
                raise
            if not isinstance(items, list):
                raise ValueError("the completions are not a list")
            found, last, seen = completion_in(items, command_id)
            if seen is not None:
                reached = seen if reached is None else max(reached, seen)
            if found or len(items) < COMPLETION_LIMIT or last is None or last <= begin:
                return found, reached
            begin = last   # a full page without the command: read on from where it ended
        return None, reached

    def readers(self) -> list:
        """The builder, then the parties given with --read-as."""
        return [self.cfg.party, *(p for p in self.cfg.read_as if p != self.cfg.party)]

    def _created(self, identifier_filter: dict) -> list:
        """The created events of the active contracts the builder can see that match the filter."""
        request = urllib.request.Request(self.cfg.ledger_url + "/v2/state/ledger-end", headers=self.auth)
        with urllib.request.urlopen(request, timeout=60) as r:
            offset = json.load(r)["offset"]
        filters = {p: {"cumulative": [{"identifierFilter": identifier_filter}]} for p in self.readers()}
        body = {"eventFormat": {"filtersByParty": filters, "verbose": False}, "activeAtOffset": offset}
        found = post_json(self.cfg.ledger_url + "/v2/state/active-contracts", body, self.auth)
        return [e["contractEntry"]["JsActiveContract"]["createdEvent"] for e in found if "JsActiveContract" in e["contractEntry"]]

    def active(self, template: str) -> list:
        """The create arguments (with contract ids) of the active contracts of a template the builder can see."""
        flt = {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": False}}}
        return [{"contractId": e["contractId"], **e["createArgument"]} for e in self._created(flt)]

    def interface_views(self, interface: str) -> list:
        """(contract id, view) of the active contracts of a token standard interface that the builder can see; the view is
        None if the participant shows none."""
        flt = {"InterfaceFilter": {"value": {"interfaceId": interface, "includeInterfaceView": True, "includeCreatedEventBlob": False}}}
        found = []
        for e in self._created(flt):
            views = [v["viewValue"] for v in e.get("interfaceViews") or [] if v.get("viewStatus", {}).get("code", 0) == 0 and v.get("viewValue")]
            found.append((e["contractId"], views[0] if views else None))
        return found

    def active_allocations(self) -> dict:
        """The token standard's allocations that are active and that the builder can see: id -> the allocation's
        specification (executor, deadlines, the transfer leg), or None if the participant shows no view of it."""
        return {cid: view["allocation"] if view else None for cid, view in self.interface_views(ALLOCATION)}

    def active_holdings(self) -> list:
        """The token standard's holdings that the builder can see: each one's contract id and view (owner, instrument, amount, lock)."""
        return [{"contractId": cid, **view} for cid, view in self.interface_views(HOLDING) if view]

    def head(self) -> dict:
        # Parties given with --read-as may let the builder see other builders' chains; only the ones it builds count.
        found = [c for c in self.active(CHAIN) if c.get("builder") == self.cfg.party]
        if len(found) != 1:   # the chain has exactly one state contract
            raise BuilderError(f"expected one active ZkChain contract built by {self.cfg.party}, found {len(found)}")
        return found[0]

    def advance(self, chain: dict, argument: dict, command_id: str | None = None) -> dict:
        """Submits the Advance and waits. Returns what the participant answered: {"updateId", "completionOffset"} (None for what it did not say)."""
        command = {"ExerciseCommand": {"templateId": CHAIN, "contractId": chain["contractId"], "choice": "Advance", "choiceArgument": argument}}
        body = {"commands": [command], "commandId": command_id or str(uuid.uuid4()), "userId": self.cfg.ledger_user,
                "actAs": [self.cfg.party], "readAs": self.readers()}
        if self.cfg.disclosed:
            body["disclosedContracts"] = self.cfg.disclosed
        if self.cfg.package_id:   # without it Canton picks the highest version every hosting participant has vetted, so vetting a new one would switch it
            body["packageIdSelectionPreference"] = [self.cfg.package_id]
        answer = post_json(self.cfg.ledger_url + "/v2/commands/submit-and-wait", body, self.auth)
        answer = answer if isinstance(answer, dict) else {}
        update_id, offset = answer.get("updateId"), answer.get("completionOffset")
        return {"updateId": update_id if isinstance(update_id, str) else None, "completionOffset": offset if type(offset) is int else None}

    def paid_traffic(self, command_id: str, offset: int) -> int | None:
        """The traffic the participant paid for the command's confirmation request (`paidTrafficCost` of its completion, in bytes), or None.
        Reads the one completion at `offset` (the answer of submit-and-wait) and waits for it only a few seconds. This never raises: a block
        Canton committed stays committed whatever this read does."""
        if completions_paused():   # a read that timed out leaves the participant alone for a minute, as the traffic read does
            return None
        body = {"userId": self.cfg.ledger_user, "parties": [self.cfg.party], "beginExclusive": max(0, offset - 1)}
        try:
            items = post_json(f"{self.cfg.ledger_url}/v2/commands/completions?limit=5&stream_idle_timeout_ms={COMPLETION_IDLE_MS}", body, self.auth,
                              timeout=COMPLETION_TIMEOUT)
            return paid_traffic_cost(items, command_id)
        except urllib.error.HTTPError as e:
            e.close()
            return None
        except Exception as e:   # no answer, an error answer, nonsense, or a token file that cannot be read
            if isinstance(e, TimeoutError) or isinstance(getattr(e, "reason", None), TimeoutError):
                pause_completions()
            return None


# ---- the legs a block records ----------------------------------------------------------------------------------

def run(cmd: str, *args: str) -> None:
    # Its own session: a Ctrl-C or a service manager's signal to the builder's group must not cut a proof short.
    done = subprocess.run([*cmd.split(), *args], capture_output=True, text=True, start_new_session=True)
    if done.returncode != 0:
        raise BuilderError(f"{Path(cmd.split()[0]).name} failed: {(done.stderr or done.stdout).strip()[-400:]}")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def canton_amount(base: int) -> str:
    """A wrapped token amount in base units as the Canton amount it stands for, exactly: 40000000000 -> "4.0"."""
    whole, fraction = divmod(base, UNIT)
    return f"{whole}.{str(fraction).rjust(10, '0').rstrip('0') or '0'}"


def base_units(amount) -> int | None:
    """A Canton amount (digits, then a point and one to ten digits, or just digits) in base units; None for anything else."""
    found = re.fullmatch(r"(\d+)(?:\.(\d{1,10}))?", amount) if isinstance(amount, str) else None
    return int(found[1]) * UNIT + int((found[2] or "").ljust(10, "0")) if found else None


@dataclass
class LegEvent:
    """One Leg event of the gateway contract: what a transaction of the block asked of Canton."""
    kind: int
    id: str        # 64 lowercase hex digits
    token: str     # 40
    account: str   # 40: the recipient of a deposit, the holder who burnt, or the payee
    amount: int    # in base units
    party: str     # a withdrawal's receiver, as the text the holder sent; empty otherwise
    tx: str        # the hash of the transaction that made the event


def decode_leg(log: dict) -> LegEvent:
    """A Leg log of the gateway: the event's six non-indexed fields, ABI encoded. Anything else is an error."""
    try:
        data = bytes.fromhex(log["data"][2:])
        words = [data[i:i + 32] for i in range(0, 192, 32)]
        kind, amount, offset = int.from_bytes(words[0], "big"), int.from_bytes(words[4], "big"), int.from_bytes(words[5], "big")
        size = int.from_bytes(data[192:224], "big")
        padded = 224 + -(-size // 32) * 32
        well_formed = (kind in (DEPOSIT, WITHDRAWAL, PAYMENT) and offset == 0xC0 and len(data) == padded and not any(words[2][:12] + words[3][:12])
                       and not any(data[224 + size:]))
        if not well_formed:
            raise ValueError("not the gateway's Leg event")
        return LegEvent(kind, words[1].hex(), words[2][12:].hex(), words[3][12:].hex(), amount,
                        data[224:224 + size].decode(errors="replace"), log["transactionHash"])
    except (KeyError, ValueError, TypeError, IndexError) as e:
        raise BuilderError(f"cannot read a Leg event of the gateway: {e}") from e


def read_legs(reth: Reth, chain: dict, block_hash: str) -> list:
    """The block's Leg events, in log order, which is the order of the gateway's running hash. This is reth's own view and nothing
    depends on it being honest: the hash in the proven state decides, and Daml compares the legs sent with it."""
    logs = reth.call("eth_getLogs", [{"blockHash": block_hash, "address": "0x" + chain["gatewayAddress"], "topics": [LEG_TOPIC]}])
    return [decode_leg(log) for log in logs]


def gateway_proofs(reth: Reth, chain: dict, number: str) -> tuple:
    """(account nodes, storage nodes) of the gateway's account and its `legs[number]` slot at the block, in hex without 0x."""
    slot = "0x" + keccak256(int(number, 16).to_bytes(32, "big") + bytes(32)).hex()   # Solidity's key for a mapping at slot 0
    proof = reth.call("eth_getProof", ["0x" + chain["gatewayAddress"], [slot], number])
    return [x[2:] for x in proof["accountProof"]], [x[2:] for x in proof["storageProof"][0]["proof"]]


class NoCantonSide(Exception):
    """A leg that has no Canton side now; the message says why."""


def allocation_problem(spec: dict | None, operator: str, now: datetime, sender: str, receiver: str, sender_is: str, receiver_is: str) -> str | None:
    """Why an allocation cannot settle in this block, or None. The deadline is judged by the builder's clock."""
    if spec is None:
        return "the participant shows no view of its allocation"
    try:
        settle_before = datetime.fromisoformat(spec["settlement"]["settleBefore"])
        if settle_before.tzinfo is None:
            raise ValueError("no time zone")
    except (KeyError, TypeError, ValueError):
        return "its allocation's settle-before time cannot be read"
    if now >= settle_before:
        return f"its allocation's settle-before time ({spec['settlement']['settleBefore']}) has passed"
    if spec["settlement"].get("executor") != operator:
        return "its allocation's executor is not the chain's operator"
    leg = spec.get("transferLeg") or {}
    if leg.get("sender") != sender:
        return f"its allocation's sender is not {sender_is}"
    if leg.get("receiver") != receiver:
        return f"its allocation's receiver is not {receiver_is}"
    return None


def names_chain(contract: dict, chain: dict, *roles: str) -> bool:
    """Whether a contract names this chain's id, operator and confirmer, and the chain's party for each of `roles` besides. Daml checks the
    same before it settles a leg: the builder is a controller of Advance, so a contract that names it in one of those roles would otherwise pass."""
    return int(contract["chainId"]) == int(chain["chainId"]) and all(contract[r] == chain[r] for r in ("operator", "confirmer", *roles))


class Canton:
    """What the builder can see on Canton for the legs of one block. Each kind of contract is read once, when a leg first needs it."""

    def __init__(self, ledger: Ledger, chain: dict, now: datetime):
        self.ledger, self.chain, self.now = ledger, chain, now

    @functools.cached_property
    def requests(self): return self.ledger.active(DEPOSIT_REQUEST)

    @functools.cached_property
    def tokens(self): return self.ledger.active(GATEWAY_TOKEN)

    @functools.cached_property
    def acceptances(self): return self.ledger.active(ACCEPTANCE)

    @functools.cached_property
    def terms(self): return self.ledger.active(TERMS)

    @functools.cached_property
    def allocations(self): return self.ledger.active_allocations()

    @functools.cached_property
    def holdings(self): return self.ledger.active_holdings()

    def token(self, leg: LegEvent) -> dict:
        found = [t for t in self.tokens if t["evmToken"] == leg.token and names_chain(t, self.chain, "gateway")]
        if not found:
            raise NoCantonSide("the EVM token is not registered with the gateway on Canton")
        return found[0]


def first_fit(candidates: list, problem_of, none_found: str):
    """The first candidate without a problem. If there is none, the first candidate's problem, or `none_found` if there are no candidates."""
    problems = []
    for candidate in candidates:
        problem = problem_of(candidate)
        if problem is None:
            return candidate
        problems.append(problem)
    raise NoCantonSide(problems[0] if problems else none_found)


def allocation_in_use(cid: str, taken: set | None) -> str | None:
    """An allocation can be executed once, so one leg of a block can use it. `taken` is None while only a leg's own faults are looked for."""
    return "an earlier leg of this block uses the same allocation" if taken is not None and cid in taken else None


def deposit_leg(leg: LegEvent, canton: Canton, claimed: dict | None) -> dict:
    """A deposit needs an active request with its id and recipient, whose allocation goes from the depositor to the gateway in the registered
    instrument, for the amount claimed, and is live."""
    chain, taken = canton.chain, None if claimed is None else claimed["allocations"]
    requests = [r for r in canton.requests if r["depositId"] == leg.id and r["recipient"] == leg.account and names_chain(r, chain, "gateway")]
    if not requests:
        raise NoCantonSide("no deposit request of this chain for this id and recipient")
    token = canton.token(leg)

    def problem(r):
        if r["allocation"] not in canton.allocations:
            return "its allocation is not active, or not visible to the builder"
        spec = canton.allocations[r["allocation"]]
        found = allocation_problem(spec, chain["operator"], canton.now, r["depositor"], chain["gateway"], "the depositor", "the gateway")
        if found:
            return found
        transfer = spec["transferLeg"]
        if transfer.get("instrumentId") != token["instrumentId"]:
            return "its allocation is of another instrument than the token's"
        if base_units(transfer.get("amount")) != leg.amount:
            return "its allocation's amount is not the amount claimed"
        return allocation_in_use(r["allocation"], taken)

    request = first_fit(requests, problem, "")
    if claimed is not None:
        claimed["allocations"].add(request["allocation"])
    return {"tag": "DepositLeg", "value": {"request": request["contractId"], "token": token["contractId"]}}


def withdrawal_leg(leg: LegEvent, canton: Canton, claimed: dict | None) -> dict:
    """A withdrawal needs the registered token, the named party's standing acceptance and unlocked gateway holdings of the instrument that
    cover the amount. A holding made earlier in the same transaction cannot be named in advance, so one withdrawal of an instrument goes in a block."""
    chain = canton.chain
    token = canton.token(leg)
    instrument = (token["instrumentId"]["admin"], token["instrumentId"]["id"])
    if claimed is not None and instrument in claimed["instruments"]:
        raise NoCantonSide("another withdrawal of the same token is already in this block")
    acceptances = [a for a in canton.acceptances if a["party"] == leg.party and names_chain(a, chain, "gateway")]
    if not acceptances:
        raise NoCantonSide("the receiver has no standing acceptance of withdrawals")
    usable = [h for h in canton.holdings if h["owner"] == chain["gateway"] and h["instrumentId"] == token["instrumentId"] and not h.get("lock")]
    usable = [h for h in usable if base_units(h["amount"]) is not None]   # whole base units: a sum is never rounded
    usable.sort(key=lambda h: (-base_units(h["amount"]), h["contractId"]))
    needed, inputs, total = leg.amount, [], 0
    for h in usable:
        if total >= needed:
            break
        inputs.append(h["contractId"])
        total += base_units(h["amount"])
    if total < needed:
        raise NoCantonSide("the gateway's holdings of the token do not cover the amount")
    if claimed is not None:
        claimed["instruments"].add(instrument)
    return {"tag": "WithdrawalLeg", "value": {"id": leg.id, "token": token["contractId"], "from": leg.account, "amount": canton_amount(leg.amount),
                                              "acceptance": acceptances[0]["contractId"], "inputs": inputs}}


def payment_leg(leg: LegEvent, canton: Canton, claimed: dict | None) -> dict:
    """A payment needs active terms with its id, token, payee and amount, whose allocation goes from u to v and is live."""
    chain, taken = canton.chain, None if claimed is None else claimed["allocations"]
    named = [t for t in canton.terms if t["dvpId"] == leg.id and names_chain(t, chain)]

    def problem(t):
        if t["token"] != leg.token:
            return "the terms name another token"
        if t["payee"] != leg.account:
            return "the terms name another payee"
        if t["amount"] != f"{leg.amount:064x}":
            return "the terms name another amount"
        if t["allocation"] not in canton.allocations:
            return "its allocation is not active, or not visible to the builder"
        found = allocation_problem(canton.allocations[t["allocation"]], chain["operator"], canton.now, t["u"], t["v"], "the terms' u", "the terms' v")
        return found or allocation_in_use(t["allocation"], taken)

    terms = first_fit(named, problem, "no terms of this chain for this payment id")
    if claimed is not None:
        claimed["allocations"].add(terms["allocation"])
    return {"tag": "PaymentLeg", "value": {"terms": terms["contractId"]}}


def match_legs(canton: Canton, events: list) -> tuple:
    """(legs, missing). Each event's Canton side is found, in the order of the events; `missing` is the events with none, each with its reason.
    A leg's own faults are looked for first. Only when every leg is fine on its own is it asked whether two legs want the same allocation or the
    same instrument's holdings, so a leg that is going to be left out never takes the place of another."""
    finders = {DEPOSIT: deposit_leg, WITHDRAWAL: withdrawal_leg, PAYMENT: payment_leg}
    for claimed in (None, {"allocations": set(), "instruments": set()}):
        legs, missing = [], []
        for event in events:
            try:
                legs.append(finders[event.kind](event, canton, claimed))
            except NoCantonSide as e:
                missing.append((event, str(e)))
        if missing:
            return legs, missing
    return legs, []


# ---- one block -------------------------------------------------------------------------------------------------

def build_block(cfg: Config, exclude: set = frozenset(), prove_empty: bool = True, unknown_pairs: list | None = None,
                journal: "Attempt | None" = None) -> dict:
    """One block, as README.md says. With prove_empty False a block that would hold no transaction is not proven or submitted:
    reth goes back to Canton's head and the answer is {"skipped": true, ...}. If the outcome is not known, the block's
    (hash, raw transaction) pairs are appended to unknown_pairs, so that a loop can find out what became of them. `journal` is the attempt
    whose lines the block's steps are written to (README.md, "The journal")."""
    attempt = journal or Attempt(None, 1)
    with connect(cfg.ws_url, max_size=None) as ws:
        reth = Reth(cfg, ws)
        chain = Ledger(cfg).head()
        head = "0x" + chain["headHash"]
        attempt.cut(int(chain["headNumber"]) + 1)
        # reth's head, safe and finalized are Canton's head before anything is built (also after a crash).
        reth.forkchoice(head, head, head)
        lost_so_far: list = []   # the transactions _build's left-out rebuilds could not put back: they must reach the report even when a later step fails
        try:
            return _build(cfg, reth, chain, head, set(exclude), prove_empty, unknown_pairs, lost_so_far, attempt)
        except BaseException as e:
            if unresolved_path(cfg).exists():
                # An Advance was sent and is not settled: the command may still commit, so reth is not moved and nothing is put back.
                # The record (and the saved copy of the transactions) make the next start settle it by its command id first.
                raise
            try:
                reth.forkchoice(head, head, head)
            except Exception as rewind:   # the error that brought us here is the one to report; the failed move back rides along as rewindError
                e.rewind_error = str(rewind) if isinstance(rewind, BuilderError) else f"{type(rewind).__name__}: {rewind}"
            # what _build's left-out rebuilds could not put back, what the error already carries, and what the last put-back loses
            e.lost_transactions = [*lost_so_far, *getattr(e, "lost_transactions", [])]
            # When the move back failed, reth's head is still the failed block and answers "nonce too low" for every one of its
            # transactions: sending them would look like success and clear the saved copy. The copy stays; the next start's
            # recover_saved moves reth back first and sends them then.
            if not getattr(e, "rewind_error", None):
                try:
                    e.lost_transactions += put_back(reth)   # the loop reports them with the failure
                    e.lost_transactions = list({x["transaction"]: x for x in reversed(e.lost_transactions)}.values())[::-1]   # each once
                except Exception:   # the error that brought us here is the one to report; the saved copy stays for the next start
                    pass
            if not e.lost_transactions:
                del e.lost_transactions
            raise


def check_built(built: dict, asked: list, cap: int, may_leave_out: bool) -> None:
    """The block reth built is the list asked for, or (may_leave_out) that list less some transactions, in the same order; and its gas limit and
    gas used are no more than the cap. Anything else is an error."""
    payload = built["executionPayload"]
    ran = payload["transactions"]
    rest = iter(asked)
    same = all(raw in rest for raw in ran) if may_leave_out else ran == asked
    if not same or int(payload["gasLimit"], 16) > cap or int(payload["gasUsed"], 16) > cap:
        raise BuilderError("reth built a block other than the one asked for, or over the gas cap")


def build_exactly(reth: Reth, head: str, attributes: dict, raws: list, cap: int) -> dict:
    """Asks reth to build a block of exactly these transactions."""
    built = reth.call("testing_buildBlockV1", [head, attributes, raws, None])   # always a list, never null
    check_built(built, raws, cap, may_leave_out=False)
    return built


def build_and_import(cfg: Config, reth: Reth, chain: dict, head: str, exclude: set, attempt: "Attempt | None" = None, known: list | None = None) -> tuple:
    """Builds a block on Canton's head and makes it reth's head. The transactions are chosen from reth's pending pool, best price first, less
    the excluded ones (and each such sender's later ones), every time: after a transaction was left out for its leg, put_back has sent the
    block's transactions to the pool again, so the choice is made again with the larger exclude set and the gas and bytes the left-out ones
    held go to others. `known` is the (transaction, raw) pairs of the block just unwound: one of them that the pool did not take back
    (put_back reports it as lost) is still a candidate, with the raw bytes in hand; if it does not make the rebuilt block it is reported in
    lostTransactions. (payload, the (transaction, raw bytes) pairs in the block, as reth built it)."""
    n, cap = int(chain["headNumber"]) + 1, int(chain["gasCap"])
    parent = reth.call("eth_getBlockByHash", [head, False])
    if not parent or int(parent["number"], 16) != n - 1:
        raise BuilderError("reth does not have Canton's head block")
    attributes = {"timestamp": hex(max(int(time.time()), int(parent["timestamp"], 16) + 1)), "prevRandao": ZERO32,
                  "suggestedFeeRecipient": cfg.fee_recipient, "withdrawals": [], "parentBeaconBlockRoot": ZERO32}

    def keep(pairs: list) -> None:
        kept = [(t["hash"], raw) for t, raw in pairs]
        if not kept:   # a block with no transaction: nothing leaves reth's pool, and an earlier copy (the list before reth emptied it) is of transactions that are in the pool
            clear_saved(cfg)
        save_kept(cfg, kept, attempt)   # before reth drops them from its pool
        reth.imported = kept

    def build_listed(offered: list) -> tuple:
        """reth builds the offered (transaction, raw) pairs in order and leaves out any it cannot run, with its sender's later ones (it was started
        with --testing.skip-invalid-transactions). check_built requires what it built to be the offered list in order less some, under the cap.
        Returns (the block reth built, the pairs in it)."""
        raws = [raw for _, raw in offered]
        built = reth.call("testing_buildBlockV1", [head, attributes, raws, None])   # always a list, never null
        check_built(built, raws, cap, may_leave_out=True)
        by_raw = {raw: (t, raw) for t, raw in offered}
        return built, [by_raw[raw] for raw in built["executionPayload"]["transactions"]]

    pending = reth.call("txpool_content", [])["pending"]
    budget = min(cap, int(parent["gasLimit"], 16))
    raws: dict = {}   # hash -> raw transaction, each fetched once
    stopped: set = set()
    for t, raw in known or []:   # in the pool already, or not taken back: either way the raw bytes are in hand
        if t["hash"] in exclude or t["from"] in stopped:   # an excluded transaction ends its sender's turn: the later ones could not run without it
            stopped.add(t["from"])
            continue
        pending.setdefault(t["from"], {}).setdefault(str(int(t["nonce"], 16)), t)
        raws[t["hash"]] = raw

    def fetch(chosen: list) -> list:
        """The (transaction, raw) pairs of the chosen ones, the raw ones in one batch. A transaction whose raw is null (replaced or evicted
        since txpool_content), one that would take the block's raw bytes over cfg.max_block_tx_bytes, or one that would take the raw hex
        over WS_REQUEST_BYTES (reth refuses a bigger request) is not offered, and nor are its sender's later ones: every sender's
        transactions stay in nonce order. The first transaction is always offered, so one bigger than the cap does not wait for ever."""
        missing = [t["hash"] for t in chosen if t["hash"] not in raws]
        raws.update(zip(missing, reth.call_many("eth_getRawTransactionByHash", [[h] for h in missing])))
        out, stopped, tx_bytes, hex_chars = [], set(), 0, 0
        for t in chosen:
            raw = raws[t["hash"]]
            if t["from"] in stopped:
                continue
            size = (len(raw) - 2) // 2 if raw else 0
            if not raw or (out and (tx_bytes + size > cfg.max_block_tx_bytes or hex_chars + len(raw) > WS_REQUEST_BYTES)):
                stopped.add(t["from"])
                continue
            out.append((t, raw))
            tx_bytes += size
            hex_chars += len(raw)
        return out

    # Offer reth every transaction that could fit if each one before it used the least gas a transaction can. reth runs them in this order and
    # leaves out any it cannot run (a gas limit over what the block has left, a wrong nonce, too little balance, a fee under the base fee) with
    # its sender's later ones: the block is full by gas used.
    offered = fetch(choose_txs(pending, budget, exclude, used_each=MIN_TX_GAS))
    try:
        built, pairs = build_listed(offered)
        reth.packed = {"packed": "gas_used", "offered": len(offered)}
    except BuilderError as e:
        # Not what was asked for, or reth cannot build it (it was started without --testing.skip-invalid-transactions): this block is
        # packed by gas limits, as it was before, and never over the cap.
        pairs = fetch(choose_txs(pending, budget, exclude))
        built = build_exactly(reth, head, attributes, [raw for _, raw in pairs], cap)
        reth.packed = {"packed": "gas_limits", "offered": len(offered), "pack_reason": str(e)[:300]}
    keep(pairs)
    payload = built["executionPayload"]
    how = {"gas_used": "gas used", "gas_limits": "gas limits"}[reth.packed["packed"]]
    try:  # a closed pipe to a log collector must not stop the chain, as in Producer.emit
        print(f"block {n}: {len(pairs)} transactions, gas used {int(payload['gasUsed'], 16)} of {cap}, packed by {how}"
              + (f" ({reth.packed['pack_reason']})" if "pack_reason" in reth.packed else ""), file=sys.stderr, flush=True)
    except OSError:
        pass
    status = reth.engine("engine_newPayloadV4", [payload, [], ZERO32, built["executionRequests"]])["status"]
    if status != "VALID":
        raise BuilderError(f"engine_newPayloadV4 answered {status}")
    reth.forkchoice(payload["blockHash"], head, head)
    return payload, pairs


@dataclass
class Built:
    """What the build stage hands on: the block reth built, its legs, the gateway's proofs, and the input folder the prover reads."""
    n: int
    chain: dict
    head: str
    payload: dict
    block_hash: str
    header: bytes
    txs: bytes
    legs: list
    leg_txs: list
    left_out: list
    chosen: list
    pairs: list
    lost: list
    work: Path
    account_nodes: list
    storage_nodes: list


@dataclass
class Proven:
    """What the prove stage hands on: the wrapped proof, as lowercase hex, and how long the prover took."""
    proof: str
    seconds: float


def build(cfg: Config, reth: Reth, chain: dict, head: str, exclude: set, prove_empty: bool = True, unknown_pairs: list | None = None,
          lost: list | None = None, attempt: "Attempt | None" = None):
    """Stage one. Cuts the block: chooses its transactions, has reth build it on Canton's head (again without any transaction whose leg has no
    Canton side), reads the gateway's proofs while the block is reth's tip, and writes the prover's input files. Returns a Built, or, for a
    block with nothing to settle when prove_empty is False, the answer {"skipped": true, ...} that ends the block."""
    attempt = attempt or Attempt(None, 1)
    n = int(chain["headNumber"]) + 1
    if not re.fullmatch(r"[0-9a-f]{40}", str(chain.get("gatewayAddress"))):
        raise BuilderError("the chain record's gateway address is not 40 lowercase hex digits")
    rebuilds = 0
    packing: dict = {}   # how the last build of this block chose its transactions
    left_out, pairs = [], None   # the transactions left out because a leg of theirs had no Canton side, each with the reason; the last build's transactions
    lost = [] if lost is None else lost   # the ones reth would not take back (the caller's list, so that a failure keeps them)
    while True:
        # Build the block and see which legs it records. A transaction whose leg has no Canton side is not allowed in: reth goes back to
        # Canton's head and the block is built again without it (and without its sender's later transactions). Nothing is proven until
        # every leg of the block has its Canton side, and a block with no transaction left out is the one that goes on.
        payload, pairs = build_and_import(cfg, reth, chain, head, exclude, attempt, known=pairs)
        packing = reth.packed   # how this build chose its transactions: the last one is the block's
        chosen = [t for t, _ in pairs]
        events = read_legs(reth, chain, payload["blockHash"])
        legs, missing = match_legs(Canton(Ledger(cfg), chain, utcnow()), events) if events else ([], [])
        if not missing:
            break
        for event, reason in missing:
            if event.tx not in exclude:
                exclude.add(event.tx)
                left_out.append({"transaction": event.tx, "reason": f"its {KINDS[event.kind]} leg has no Canton side: {reason}"})
        rebuilds += 1
        reth.forkchoice(head, head, head)
        lost.extend(put_back(reth))   # the block's transactions are in the pool again: the next build chooses from it with the larger exclude set (each round adds an exclusion, so it ends)
    if not chosen and not prove_empty:   # nothing to settle: no proof and no commit is spent on it
        attempt.event("skipped", left_out=left_out, rebuilds=rebuilds)
        reth.forkchoice(head, head, head)
        return {"skipped": True, "number": n, "leftOut": left_out, **({"lostTransactions": lost} if lost else {})}
    block_hash = payload["blockHash"]
    leg_txs = list(dict.fromkeys(e.tx for e in events))
    attempt.event("built", block_hash=block_hash, parent_hash=head, tx_hashes=[t["hash"] for t in chosen], gas_used=int(payload["gasUsed"], 16),
                  legs=len(legs), rebuilds=rebuilds, left_out=left_out, tx_bytes=sum((len(r) - 2) // 2 for _, r in pairs),
                  max_tx_bytes=cfg.max_block_tx_bytes, **pinned(cfg), **packing)

    raw = bytes.fromhex(reth.call("debug_getRawBlock", [payload["blockNumber"]])[2:])
    header, txs = split_block(raw)
    if "0x" + keccak256(header).hex() != block_hash:
        raise BuilderError("the block's header does not hash to its block hash")
    work = Path(cfg.work_dir) / f"block-{n}"
    work.mkdir(parents=True, exist_ok=True)
    (work / "block.json").write_text(json.dumps(reth.call("eth_getBlockByNumber", [payload["blockNumber"], True])))
    (work / "witness.json").write_text(json.dumps(reth.call("debug_executionWitness", [payload["blockNumber"]])))
    # The gateway's proofs are read while this block is reth's tip, before the prover runs.
    account_nodes, storage_nodes = gateway_proofs(reth, chain, payload["blockNumber"])
    return Built(n=n, chain=chain, head=head, payload=payload, block_hash=block_hash, header=header, txs=txs, legs=legs, leg_txs=leg_txs,
                 left_out=left_out, chosen=chosen, pairs=pairs, lost=lost, work=work,
                 account_nodes=account_nodes, storage_nodes=storage_nodes)


def prove(cfg: Config, built: Built, attempt: "Attempt | None" = None) -> Proven:
    """Stage two. Runs the prover on the block's input and checks that the proof commits to this block. A failure is a ProvingError that
    names the transactions to keep."""
    attempt = attempt or Attempt(None, 1)
    work, block_hash = built.work, built.block_hash
    prover = Path(cfg.prove_cmd).name
    attempt.event("proof_queued", prover=prover)
    proving = time.monotonic()
    outcome = "failed"
    kept = [t["hash"] for t in built.chosen]
    # Each attempt has its own output folder: a prover left behind by a killed builder writes into the old one, never into this one.
    for old in work.glob("out*"):
        shutil.rmtree(old, ignore_errors=True)
    out = work / f"out-{os.getpid()}-{time.time_ns()}"
    try:
        attempt.event("proof_started", prover=prover)
        run(cfg.make_input_cmd, str(work / "block.json"), str(work / "witness.json"), cfg.genesis, str(work / "input.bin"))
        run(cfg.prove_cmd, str(work / "input.bin"), str(out))
        proof_file = out / "wrapped-proof.hex"
        if not proof_file.is_file():
            raise BuilderError("the prover finished but left no wrapped-proof.hex")
        proof = proof_file.read_text().strip()
        if len(proof) != 2688 or proof.strip("0123456789abcdef"):
            raise BuilderError("the wrapped proof is not 1,344 bytes of lowercase hex")
        committed = committed_hash(proof)
        if committed != block_hash:   # never submit a proof of another block
            outcome = "wrong_block"
            raise BuilderError(f"the proof commits to block hash {committed or 'none'}, not this block's {block_hash}")
    except BuilderError as e:
        attempt.event("proof_ended", prover=prover, outcome=outcome, seconds=round(time.monotonic() - proving, 3), reason=str(e)[:300])
        raise ProvingError(str(e), kept) from e
    os.replace(out, work / "out")   # the accepted attempt's folder is the block's `out`, where the demo and the operator look
    prove_seconds = round(time.monotonic() - proving, 3)
    attempt.event("proof_ended", prover=prover, outcome="ok", seconds=prove_seconds)
    return Proven(proof, prove_seconds)


def submit(cfg: Config, reth: Reth, built: Built, proven: Proven, unknown_pairs: list | None = None, attempt: "Attempt | None" = None) -> dict:
    """Stage three. Sends the Advance with the proof and the gateway's proofs, and settles the answer: commit (reth's head moves to the block), refusal or
    not taken (reth goes back to Canton's head and the transactions return to the pool), or unknown (nothing moves)."""
    attempt = attempt or Attempt(None, 1)
    n, chain, head, block_hash, header, txs, legs = built.n, built.chain, built.head, built.block_hash, built.header, built.txs, built.legs
    chosen, left_out, leg_txs, lost, work = built.chosen, built.left_out, built.leg_txs, built.lost, built.work
    account_nodes, storage_nodes = built.account_nodes, built.storage_nodes
    proof, prove_seconds = proven.proof, proven.seconds
    argument = {"headerHex": header.hex(), "txsHex": "" if txs == EMPTY_LIST else txs.hex(), "proofHex": proof,
                "gatewayAccountNodes": account_nodes, "gatewayStorageNodes": storage_nodes, "legs": legs}
    argument_text = json.dumps(argument)
    (work / "advance.json").write_text(argument_text)   # kept: the argument of the Advance, as it was sent
    command_id = f"ostia-{int(chain['chainId'])}-{n}-{block_hash[2:18]}-{attempt.seq}"   # the same block hash and attempt give the same id
    report = {"number": n, "blockHash": block_hash, "legTransactions": leg_txs, "leftOut": left_out, "proveSeconds": prove_seconds,
              "commandId": command_id}
    if lost:
        report["lostTransactions"] = lost

    reason, rejected, not_taken, answer = None, False, False, {}
    # The ledger end before the submit: the command's own completion, whenever it comes, is after it.
    begin = Ledger(cfg).end()
    # The command is on disk before it is sent: a process killed during the submit, an interrupt or a failing disk then leave the record
    # that makes the next start wait for the command instead of rewinding a block that may commit. Only a definite answer clears it.
    resolve = {"number": n, "hash": block_hash, "commandId": command_id, "begin": begin, "submittedAt": time.time(), "genesis": genesis_hash(reth)}
    ref = {"run": attempt.journal.run_id, "attempt": attempt.seq} if attempt.journal is not None else {}   # as save_kept: an empty block has no kept file to say whose it is
    save_unresolved(cfg, {**resolve, **ref})
    attempt.event("submitted", command_id=command_id, argument_bytes=len(argument_text.encode()), **pinned(cfg))
    # The participant's traffic is read around the Advance only for a block that is alone in flight: with another one, whose bytes are whose is not known.
    watch = attempt.journal is not None and attempt.in_flight == 0
    traffic_before = read_traffic(cfg) if watch else None
    advancing = time.monotonic()
    try:
        answer = Ledger(cfg).advance(chain, argument, command_id)
    except urllib.error.HTTPError as e:
        with e:
            text = e.read().decode(errors="replace")
        reason, rejected, not_taken = text[:600], definite_rejection(e.code, text), e.code in NEVER_TAKEN_CODES
    except (OSError, ValueError, http.client.HTTPException) as e:   # a dropped connection, a timeout, a reply that is not HTTP or not JSON: the reply is lost
        reason = f"no usable reply from Canton: {e}"
        not_taken = isinstance(e, ConnectionRefusedError) or isinstance(getattr(e, "reason", None), ConnectionRefusedError)
    report["advanceSeconds"] = round(time.monotonic() - advancing, 3)
    answered_at = attempt.now()   # when Canton answered: the reads below take time that is not part of the answer
    traffic_after = read_traffic(cfg) if watch else None
    traffic = traffic_used(traffic_before, traffic_after)

    def answered(outcome: str, **more) -> None:
        attempt.event("answered", at=answered_at, outcome=outcome, seconds=report["advanceSeconds"], traffic_bytes=traffic, traffic_before=traffic_before, traffic_after=traffic_after, **more)

    if reason is not None and not rejected and not not_taken:
        # No answer: the command may still commit, so neither Canton's head nor reth's own head says anything yet. Its own completion
        # does, and until that shows (or the window it can commit in has passed) nothing is built and reth stays where it is.
        try:
            found = Ledger(cfg).completion(command_id, begin)
        except (OSError, ValueError, http.client.HTTPException) as e:
            found, reason = None, f"{reason}; and the completion of the command could not be read ({e})"
        if found is None:
            if unknown_pairs is not None:
                unknown_pairs.extend(reth.imported)
            answered("unknown", reason=reason[:600])
            return {"committed": None, **report, "resolve": resolve,
                    "reason": f"{reason}; the command has no completion yet, so it is not known whether the block committed",
                    "keptTransactions": [t["hash"] for t in chosen]}
        if found["committed"]:
            answer, reason = found, None   # it committed: the rest is as after a normal answer
        else:
            reason = f"{reason}; {found['reason']}"
    if reason is not None:   # Canton refused the command (its own answer, or its failed completion), or it never reached the service: not committed
        clear_unresolved(cfg)    # a definite answer: the command cannot commit any more
        rewind_error = None
        try:
            reth.forkchoice(head, head, head)
        except Exception as rewind:   # Canton's answer is the one to report; the failed move back rides along as rewindError
            rewind_error = str(rewind) if isinstance(rewind, BuilderError) else f"{type(rewind).__name__}: {rewind}"
        put_back_lost = []
        if not rewind_error:   # after a failed move back reth's head is still this block, which would "have" every transaction (nonce too low):
            try:              # they stay in reth.imported and in the saved copy for the next start's recover_saved, which moves reth back first
                put_back_lost = put_back(reth)
            except Exception as again:
                rewind_error = str(again) if isinstance(again, BuilderError) else f"{type(again).__name__}: {again}"
        if put_back_lost:
            report["lostTransactions"] = [*report.get("lostTransactions", []), *put_back_lost]
        if rewind_error:
            report["rewindError"] = rewind_error
        answered("refused" if rejected else "not_taken", reason=reason[:600])
        return {"committed": False, "rejected": rejected, **report, "reason": reason, "keptTransactions": [t["hash"] for t in chosen]}
    # Committed. After a lost reply the update id and offset are not known: null.
    report.update(updateId=answer.get("updateId"), completionOffset=answer.get("completionOffset"))
    if traffic is None and not cfg.traffic_url and command_id and type(report["completionOffset"]) is int:   # no traffic state is configured to measure from (a participant on the Canton Network has none): what the completion says it paid. With a state configured and this block's delta unknown, traffic stays null: one run does not mix two measures
        traffic = Ledger(cfg).paid_traffic(command_id, report["completionOffset"])
    if traffic is not None:
        report["trafficBytes"] = traffic
    answered("committed", update_id=report["updateId"], completion_offset=report["completionOffset"])
    reth.imported = []   # Canton committed them: never send them to the pool again
    reth.forkchoice(block_hash, block_hash, block_hash)
    attempt.event("final_seen", number=n)
    clear_saved(cfg)
    clear_unresolved(cfg)   # last: should reth's move above fail, the record stays and the next start settles the block as committed
    return {"committed": True, **report, "transactions": [t["hash"] for t in chosen], "legs": len(legs)}


def _build(cfg: Config, reth: Reth, chain: dict, head: str, exclude: set, prove_empty: bool = True, unknown_pairs: list | None = None,
           lost: list | None = None, attempt: "Attempt | None" = None) -> dict:
    """One block through the three stages: build, prove, submit."""
    attempt = attempt or Attempt(None, 1)
    built = build(cfg, reth, chain, head, exclude, prove_empty, unknown_pairs, lost, attempt)
    if isinstance(built, dict):   # skipped: nothing to prove or submit
        return built
    return submit(cfg, reth, built, prove(cfg, built, attempt), unknown_pairs, attempt)

PUBLIC_AT = 832   # the proof (768), the program key (32) and the release root (32) come before the public values


def committed_hash(proof: str) -> str | None:
    """The block hash a wrapped proof's public values commit to (the layout the sidecar accepts: 64 slots of 8 bytes, each a 4-byte word and
    four zero bytes; the words together are 0x20, the 32-byte hash and zeros), or None when they do not have that layout."""
    public = bytes.fromhex(proof)[PUBLIC_AT:]
    words = bytearray()
    for slot in range(64):
        chunk = public[slot * 8:slot * 8 + 8]
        if len(chunk) != 8 or any(chunk[4:]):
            return None
        words += chunk[:4]
    if words[0] != 0x20 or any(words[33:]):
        return None
    return "0x" + bytes(words[1:33]).hex()


NEVER_TAKEN_CODES = (401, 403, 429)   # the token, or back-pressure, refused the call before the participant took the command: no completion will ever come


def definite_rejection(code: int, body: str) -> bool:
    """Whether an HTTP error from submit-and-wait is Canton rejecting the command (a 4xx that carries an error code). A 5xx, a 408
    or an answer with no error code is the service failing: the block may be fine and its completion says. A 429 (back-pressure), a 401 or 403
    (token) is no rejection of the command either, but the command was not taken (see NEVER_TAKEN_CODES). A command id
    that Canton already knows (DUPLICATE_COMMAND: committed or in progress; SUBMISSION_ALREADY_IN_FLIGHT) is no refusal either: the same
    command is, or may be, committed, and its own completion says which."""
    if not 400 <= code < 500 or code in (401, 403, 408, 429):
        return False
    try:
        error = json.loads(body).get("code")
    except (ValueError, AttributeError):
        return False
    return isinstance(error, str) and error not in ("DUPLICATE_COMMAND", "SUBMISSION_ALREADY_IN_FLIGHT")


def read_saved(cfg: Config) -> list | None:
    """The (hash, raw transaction) pairs saved for the block being made, or None when nothing was saved. Raises when the file is unreadable."""
    path = saved_path(cfg)
    try:
        text = path.read_text()
    except FileNotFoundError:
        return None
    except OSError as e:
        raise BuilderError(f"cannot read {path}: {e}") from e
    try:
        entries = json.loads(text)
        pairs = [(e["hash"], e["raw"]) for e in entries]
        if not all(isinstance(h, str) and isinstance(r, str) for h, r in pairs):
            raise TypeError("not strings")
    except (ValueError, KeyError, TypeError) as e:
        path.replace(path.with_name(path.name + ".unreadable"))   # kept for a look, and out of the way
        raise BuilderError(f"{path} could not be read ({e}); it was moved to {path.name}.unreadable") from e
    return pairs


def builder_now() -> float:
    """The builder's clock, epoch seconds; the window of an unknown outcome starts on it."""
    return time.time()


def resolve_unknown(cfg: Config, u: dict, pairs: list) -> tuple:
    """Settles an Advance whose answer did not arrive, by its own command id. Reads the builder user's completions from the ledger end
    recorded before the submit. A completion that succeeded: the block committed, reth's head is made final. One that failed: it did not
    commit, reth goes back to Canton's head and the block's transactions are sent to its pool again. No completion: Canton's head says
    committed when it is this block's hash (it cannot be anything else then). Otherwise the command may still commit, and `Unresolved` is
    raised, until the read has reached an OffsetCheckpoint whose record time is at or past `u["since"]` + cfg.resolve_seconds: that is
    Canton's own time, so a participant that lags or reconnects after it confirmed the command cannot commit it later by our clock being
    ahead. Then it is settled as not committed and the head is where reth goes, unless Canton's time is more than 30 s ahead of the builder's
    clock: that is a skew, the window cannot be judged, and `Unresolved` names it. Raises too while the head cannot be read. Returns
    (committed, the transactions reth refused, how it was settled, {"updateId", "completionOffset"} when known)."""
    bound = u["since"] + cfg.resolve_seconds
    with connect(cfg.ws_url, max_size=None) as ws:
        reth = Reth(cfg, ws)
        check_chain(reth, u)
        try:
            found, reached = Ledger(cfg).completion_and_time(u["commandId"], u["begin"])
        except (OSError, ValueError, http.client.HTTPException) as e:
            found, reached, unread = None, None, e   # the head can still show the block
        else:
            unread = None
        if found is not None and found["committed"]:
            committed, how = True, "completion"
        else:
            head = "0x" + Ledger(cfg).head()["headHash"]
            committed = head == u["hash"]
            how = "completion" if found else "head" if committed else "window"
            if found is None and not committed and (reached is None or reached < bound):
                if unread is not None:
                    raise Unresolved(f"the completion of command {u['commandId']} cannot be read yet: {unread}")
                raise Unresolved(f"command {u['commandId']} has no completion yet and Canton's time has not passed the last moment it can commit")
            if found is None and not committed and reached > builder_now() + SKEW_SECONDS:
                raise Unresolved(f"command {u['commandId']} has no completion, and Canton's clock is ahead of the builder's by {reached - builder_now():.0f} s "
                                 f"(more than {SKEW_SECONDS:g}): the window cannot be judged until the clocks agree, so it is not settled as not committed")
        if committed:
            reth.forkchoice(u["hash"], u["hash"], u["hash"])
            clear_saved(cfg)
            clear_unresolved(cfg)
            return True, [], how, {"updateId": found and found["updateId"], "completionOffset": found and found["completionOffset"]}
        reth.forkchoice(head, head, head)
        lost = resend(reth, pairs)
        clear_saved(cfg)
        clear_unresolved(cfg)
        return False, lost, how, {}


def recover_saved(cfg: Config, wait=None) -> dict | None:
    """After a crash or a restart in the middle of a block: reth goes to Canton's head, and the transactions that block was made from
    (saved before the block was) are sent to reth's pool again. Whether Canton took the block does not matter: a transaction of a
    committed block has a used nonce, and reth says so. An Advance with no answer comes first: it is settled by its command id (and
    raises `Unresolved` while it cannot be), because Canton's head says nothing until the command can no longer commit. Returns
    None when nothing was saved and nothing settled, else {"recovered": how many, "lostTransactions": [{transaction, error}]} for the
    ones reth refused for another reason, and "settled": {"number", "blockHash", "commandId", "committed", "resolved", ...} when an earlier
    block's command was settled here."""
    u = load_unresolved(cfg)
    settled = None
    while u:   # with `wait` (the `once` command) this waits for the command; without it (the loop) it raises and the loop tries again
        try:
            try:
                pairs = read_saved(cfg) or []
            except BuilderError:   # the kept transactions are damaged (moved aside): the command is settled all the same
                pairs = []
            committed, lost, how, info = resolve_unknown(cfg, {**u, "since": u["submittedAt"]}, pairs)
            settled = {"number": u.get("number"), "blockHash": u["hash"], "commandId": u["commandId"], "committed": committed, "resolved": how, **info}
            settled["lostTransactions"] = lost
            break
        except Unresolved:
            if wait is None:
                raise
            wait(2)
    pairs = read_saved(cfg)
    if pairs is None:
        return {"recovered": 0, "lostTransactions": settled.pop("lostTransactions", []), "settled": settled} if settled else None
    entries = json.loads(saved_path(cfg).read_text())
    with connect(cfg.ws_url, max_size=None) as ws:
        reth = Reth(cfg, ws)
        head = "0x" + Ledger(cfg).head()["headHash"]
        reth.forkchoice(head, head, head)
        lost = resend(reth, pairs)
    clear_saved(cfg)
    found = {"recovered": len(pairs), "lostTransactions": lost}
    ref = next(({"run": e["run"], "attempt": e["attempt"]} for e in entries if isinstance(e.get("run"), str) and type(e.get("attempt")) is int), None)
    return {**found, "attempt": ref} if ref else found


@contextlib.contextmanager
def work_lock(work_dir: str):
    """One builder per work folder: two would both move the same reth and race with their blocks."""
    Path(work_dir).mkdir(parents=True, exist_ok=True)
    with open(Path(work_dir) / "builder.lock", "w") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            raise BuilderError(f"another builder is running with the work folder {work_dir} (it holds builder.lock); only one may drive a reth") from e
        yield


def pinned(cfg: Config) -> dict:
    """The journal field that names the package version Advance is pinned to; nothing when it is not pinned."""
    return {"package_id": cfg.package_id} if cfg.package_id else {}


def check_package_id(value: str) -> str:
    """A package id is the SHA-256 of its package, in 64 hex digits."""
    if not re.fullmatch(r"[0-9a-f]{64}", value):
        raise BuilderError("bad arguments: --package-id must be a package id: 64 lowercase hex digits")
    return value


def read_disclosed(path: str) -> list:
    try:
        found = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise BuilderError(f"cannot read the disclosed contracts {path}: {e}") from e
    if not isinstance(found, list) or not all(isinstance(c, dict) for c in found):
        raise BuilderError(f"the disclosed contracts {path} must be a JSON list of objects")
    return found


# ---- the loop --------------------------------------------------------------------------------------------------

STATUS_TICK_SECONDS = 5.0   # how often the status file is rewritten while a block is in flight
STATUS_STALL_SECONDS = 300.0   # the ticker stops refreshing when the loop itself has written nothing for this long: a stuck step must show
BACKOFF_CAP = 30.0    # the longest pause after a failed or refused block, in seconds
RECHECK_BASE = 2.0    # how soon a pool that held nothing includable is looked at again, and the least between two looks
KEEP_BLOCKS = 10      # the work folders of this many of the newest committed blocks are kept
MIN_IDLE_MS = 50


def pool_pending(cfg: Config) -> int:
    """How many transactions reth's pool holds that could go into the next block (`txpool_status`'s pending count)."""
    with connect(cfg.ws_url, max_size=None) as ws:
        return int(Reth(cfg, ws).call("txpool_status", [])["pending"], 16)


def prune_work(work_dir: str, number: int, keep: int = KEEP_BLOCKS) -> None:
    """Removes the work folders of committed blocks more than `keep` behind `number`. A folder of a block that was not committed has a
    higher number and is made again by the next try."""
    try:
        names = os.listdir(work_dir)
    except OSError:
        return
    for name in names:
        found = re.fullmatch(r"block-(\d+)", name)
        if found and int(found[1]) <= number - keep:
            shutil.rmtree(Path(work_dir) / name, ignore_errors=True)


def failure_report(e: Exception) -> dict:
    report = {"committed": False, "error": str(e) if isinstance(e, BuilderError) else f"{type(e).__name__}: {e}"}
    if getattr(e, "lost_transactions", None):
        report["lostTransactions"] = e.lost_transactions
    if getattr(e, "rewind_error", None):   # moving reth back after the failure failed too: the original stays in "error"
        report["rewindError"] = e.rewind_error
    return report


def read_traffic(cfg: Config) -> dict | None:
    """The builder's participant's traffic state, or None (see journal.read_traffic). The headers are looked up inside its guard."""
    return journal_read_traffic(cfg.traffic_url, lambda: Ledger(cfg).auth)


def check_strategy(*args, **kw) -> None:
    """Refuses a setting that cannot keep up or that this producer cannot do, and says why (journal.check_settings)."""
    try:
        check_settings(*args, **kw)
    except ValueError as e:
        raise BuilderError(str(e)) from e


class Producer:
    """Makes a block whenever the pool has transactions that can go in (and, if asked, every so often when it has none), one block at a
    time, each by `build_block`, the code `once` runs. See README.md, "Running it all the time"."""

    def __init__(self, cfg: Config, stop: threading.Event, idle: float = 0.5, empty_every: float = 0, status_file: str | None = None,
                 cooldown: float = 600, emit=None, clock=time.time, build=build_block, pending=pool_pending,
                 resolve=resolve_unknown, recover=recover_saved, wait=None, gather_ms: float = 0, journal: Journal | None = None, test: bool = False,
                 source_commit: str = "unknown", status_tick: float = STATUS_TICK_SECONDS,
                 status_stall: float = STATUS_STALL_SECONDS):
        self.cfg, self.stop, self.idle, self.empty_every, self.cooldown = cfg, stop, idle, empty_every, cooldown
        self.gather_ms = gather_ms
        self.journal = journal or Journal(Path(cfg.work_dir) / "journal", clock=clock)
        self.source_commit = source_commit
        self.settings = {"strategy": "on_demand", "gather_ms": gather_ms, "heartbeat_seconds": empty_every, "max_in_flight": 1,
                         "idle_ms": round(idle * 1000), "exclude_cooldown_seconds": cooldown, "test": test, "traffic_read": bool(cfg.traffic_url)}
        self.status_tick, self.status_stall = status_tick, status_stall
        self.status_lock = threading.Lock()   # the loop's and the ticker's writes of the status file never interleave
        self.status_last = None               # what the loop last wrote: the ticker repeats it with a fresh updatedAt
        self.status_final = False             # the last write was made: the ticker writes no more
        self.status_warned = False            # the "cannot write" line is printed once
        self.ticker_warned = False            # so is the line for any other failure of the ticker
        self.attempt_seq = 0
        self.attempt = None               # the Attempt whose lines the block now being made writes
        self.pool_sampled = None          # (the time, the count) of the last `pool` line
        self.waiting_since = None         # when the pool first held a transaction that no block has been cut for
        self.pause = 0.0                  # how long the loop waits at most before it looks again: the end of a gather
        self.last_trigger = None
        self.status_file = status_file or str(Path(cfg.work_dir) / "status.json")
        self._emit = emit or (lambda report: print(json.dumps(report), flush=True))
        self.clock, self.build, self.pending, self.resolve, self.recover, self.wait = clock, build, pending, resolve, recover, wait or stop.wait
        self.excluded: dict = {}          # transaction hash -> the time its cool-down ends
        self.previous_kept: set = set()   # the transactions of the last block Canton refused, when it was the one before
        self.suspects: list = []          # transactions that were in two refused blocks together: tried one block each before any is left out
        self.probe = None                 # the suspect the next block may hold
        self.held = None                  # the pool holds nothing that can go in: {"count", "last", "next", "delay"}
        self.pool_was_empty = True        # the last look at the pool found it empty (or there has been none): a gather starts only then
        self.snapshot = 0                 # how many transactions the pool held when the block now being made was decided on
        self.proof_kept: set = set()      # the transactions of the last block the input tool or the prover failed on, when it was the one before
        self.hunt = None                  # looking for the transaction that cannot be proven: {"live", "probe", "parked"}
        self.excluded_why: dict = {}      # transaction hash -> why it is held back, for the ones held back because they could not be proven
        self.convictions: dict = {}       # transaction hash -> how many times it was held back as unprovable: each time the cool-down doubles
        self.passes = 0                   # blocks that passed the input tool and the prover: the proof that the service works
        self.mark = 0                     # `passes` when the failures now being counted began
        self.control = None               # a conviction waiting for a block without the candidates to pass the prover: {"tx", "why"}
        self.reported_left = set()        # the left-out transactions the last "skipped" line named
        self.unresolved = None            # the block whose outcome was not known: {"number", "hash", "pairs"}
        self.lost: list = []              # transactions that could not be put back in reth's pool after such a block
        self.started = self.last_block_at = self.last_written = self.clock()
        self.committed = self.refused = self.unknown = self.failures = self.refusals_in_row = 0
        self.last_committed = self.last_error = None
        self.timed, self.prove_total, self.advance_total = 0, 0.0, 0.0

    def emit(self, report: dict) -> None:
        try:
            self._emit(report)
        except Exception:   # a closed pipe to a log collector must not stop the chain
            pass

    # -- the loop
    def run(self) -> None:
        state = "crashed"   # what the status says if anything but a stop ends this
        ticker_stop = threading.Event()   # set when the run ends (not when `stop` is set: the block in progress still needs a fresh status)
        ticker = threading.Thread(target=self.tick_status, args=(ticker_stop,), name="status-ticker", daemon=True)
        try:
            self.journal.event("run_started", strategy="on_demand", settings=self.settings, source_commit=self.source_commit)
            self.load_unresolved()
            self.write_status()
            ticker.start()
            while not self.stop.is_set():
                try:
                    self.step()
                except Exception as e:   # a fault of the loop's own: the chain goes on
                    self.fail(failure_report(e))
            state = "stopped"
        finally:
            ticker_stop.set()
            if ticker.is_alive():
                ticker.join(timeout=10)
            self.journal.event("run_stopped", state=state)
            self.write_status(state, final=True)

    def load_unresolved(self) -> None:
        """An Advance with no answer from before a restart is settled by its command id first, as in the run that submitted it."""
        try:
            u = load_unresolved(self.cfg)
            if not u:
                return
            try:
                pairs = read_saved(self.cfg) or []
                ref = next(({"attempt_run": e["run"], "attempt": e["attempt"]} for e in json.loads(saved_path(self.cfg).read_text())
                            if isinstance(e.get("run"), str) and type(e.get("attempt")) is int), {}) if pairs else {}
            except BuilderError as e:   # the kept transactions are damaged: the command is still in doubt, and it is still waited for
                print(f"cannot read the kept transactions of the unresolved command: {e}", file=sys.stderr)
                pairs, ref = [], {}
            if isinstance(u.get("run"), str) and type(u.get("attempt")) is int:   # the record names its attempt, also for a block with no transactions
                ref = {"attempt_run": u["run"], "attempt": u["attempt"]}
            self.unresolved = {"pairs": pairs, **u, "since": u["submittedAt"], "number": u.get("number"), **ref}
        except Exception as e:   # the record cannot be read: step() builds nothing while it exists, and reads it again
            print(f"cannot read the unresolved command: {e}", file=sys.stderr)

    def due(self, now: float) -> str | None:
        """Only reth's count of waiting transactions is read here (the block's own build reads the transactions). While the pool holds
        only what was left out last time, the count is not read for RECHECK_BASE after the last look, and afterwards the pool is built
        from only when the count has changed or the pause, which grows up to BACKOFF_CAP, is over."""
        h = self.held
        if h is None or now >= h["last"] + RECHECK_BASE:   # within RECHECK_BASE of the last look the pool is not even counted
            n = self.pending(self.cfg)
            self.sample_pool(n, now)
            self.snapshot = n   # before the block is made: whatever arrives while it is made is seen as a change; 0 for an empty pool
            if n == 0:
                self.held, self.reported_left, self.waiting_since = None, set(), None
                self.pool_was_empty = True
            else:
                if self.waiting_since is None:
                    self.waiting_since = now
                if h is None or now >= h["next"] or n != h["count"]:
                    left = self.waiting_since + self.gather_ms / 1000 - now
                    gathering = self.pool_was_empty   # only a transaction that reached an empty pool waits: a busy pool batches by itself
                    if gathering and left > 0:   # an idle pool got its first transaction: wait a little for more to batch with it
                        self.pause = left
                    else:
                        self.pool_was_empty = False
                        return "gather" if gathering and self.gather_ms > 0 else "pool"
        if self.empty_every > 0 and now - self.last_block_at >= self.empty_every:
            return "heartbeat"
        return None

    def sample_pool(self, n: int, now: float) -> None:
        """A `pool` line when reth's count of waiting transactions has changed, at most once a second."""
        last = self.pool_sampled
        if last is None or (n != last[1] and now - last[0] >= 1):
            self.pool_sampled = (now, n)
            self.journal.event("pool", waiting=n)

    def cut_reason(self, trigger: str, now: float) -> tuple:
        """(why this block is cut, how long it waited with nothing in flight): the journal's `cut_reason` and `idle_before_cut_ms`."""
        if trigger == "heartbeat":
            reason, since = ("probe" if self.control else "heartbeat"), self.last_block_at
        else:
            reason, since = ("probe" if self.probe is not None else "retry" if self.failures or self.refusals_in_row else trigger), self.waiting_since
        return reason, round(max(0.0, now - since) * 1000) if since is not None else 0

    def step(self) -> None:
        now = self.clock()
        attempt = None
        for h in [h for h, until in self.excluded.items() if until <= now]:
            del self.excluded[h]
            self.excluded_why.pop(h, None)
            if self.held:
                self.held["next"] = 0   # a transaction that was held back may go in now
        try:
            if self.unresolved is None and unresolved_path(self.cfg).exists():   # a command in doubt that this process does not know yet
                self.load_unresolved()                                           # (cut short in this process, or its record was unreadable)
                if self.unresolved is None:   # not readable: nothing is built while it exists
                    self.write_status()
                    self.wait(max(self.idle, 1.0))
                    return
            if self.unresolved:
                return self.settle_unknown()
            if saved_path(self.cfg).exists():   # a block cut short by a restart or a fault: its transactions go back to reth first
                self.restore()
            self.pause = 0.0
            trigger = "heartbeat" if self.control else self.due(now)   # a waiting conviction needs its control block whatever the pool holds
            if trigger is None:
                if now - self.last_written >= 5:   # tells a monitor the loop is alive
                    self.write_status()
                self.wait(min(self.idle, self.pause) if self.pause > 0 else self.idle)
                return
            exclude = set(self.excluded) | {h for h in self.suspects if h != self.probe} | self.hunt_out()
            if self.control:   # the control block: without the candidates, and made even when it holds nothing, to see the prover work
                exclude |= {self.control["tx"]}
            pairs: list = []
            reason, idle_ms = self.cut_reason(trigger, now)
            self.attempt_seq += 1
            attempt = self.attempt = Attempt(self.journal, self.attempt_seq, {
                "strategy": "on_demand", "cut_reason": reason, "pool_waiting": self.snapshot, "idle_before_cut_ms": idle_ms, "in_flight_at_cut": 0})
            self.waiting_since = None
            result = self.build(self.cfg, exclude, prove_empty=trigger == "heartbeat", unknown_pairs=pairs, journal=attempt)
        except Exception as e:   # not a block Canton answered: reth, the ledger, the prover or the pending check failed
            if attempt:
                attempt.failed(failure_report(e)["error"])
            if isinstance(e, ProvingError):
                if self.control:   # the prover failed without the candidates too: the service is not shown to work, so nobody is blamed
                    self.control, self.hunt, self.proof_kept = None, None, set()
                else:
                    self.proving_failed(e, now)
            self.fail(failure_report(e))
            return
        failing = not result.get("skipped") and result["committed"] is False and not result.get("rejected")
        if not failing:
            self.note_lost(result.get("lostTransactions"), now)   # `fail` notes its own
        if "proveSeconds" in result:
            self.proof_passed([h.lower() for h in result.get("transactions", result.get("keptTransactions", []))], now)
        if result.get("skipped"):
            self.skipped(result, now)
        elif failing:
            self.fail(result)   # Canton did not take it, but did not refuse it either: the service failed, the block may be fine
        else:
            self.record(result, pairs)

    def fail(self, report: dict) -> None:
        self.note_lost(report.get("lostTransactions"), self.clock())
        self.failures += 1
        self.previous_kept = set()
        self.last_error = {"time": iso(self.clock()), "error": report.get("error") or report.get("reason", "")}
        if report.get("rewindError"):
            self.last_error["rewindError"] = report["rewindError"]
        self.emit(report)
        self.write_status()
        self.wait(min(BACKOFF_CAP, 2.0 ** min(self.failures - 1, 5)))   # the exponent is capped: it never overflows

    def skipped(self, result: dict, now: float) -> None:
        """The pool holds transactions but none can go in (each is held back, does not fit, or has a leg with no Canton side). No block is
        made. The pool is looked at again when it changes, and otherwise with a growing pause."""
        self.failures = 0
        self.suspects, self.probe = [], None
        self.proof_kept, self.hunt = set(), None   # a hunt that finds nothing of its transactions in the pool is over
        h = self.held
        delay = min(BACKOFF_CAP, h["delay"] * 2) if h and self.snapshot == h["count"] else RECHECK_BASE
        self.held = {"count": self.snapshot, "last": now, "next": now + delay, "delay": delay}
        left = {x["transaction"] for x in result["leftOut"]}
        if left != getattr(self, "reported_left", set()):   # said once for each change, not at every look
            self.reported_left = left
            self.emit({"skipped": True, "number": result["number"], "leftOut": result["leftOut"],
                       **({"lostTransactions": result["lostTransactions"]} if result.get("lostTransactions") else {})})
        self.write_status()
        self.wait(self.idle)

    def note_lost(self, lost: list | None, now: float) -> None:
        """Transactions reth would not take back are kept in the status (the newest 100)."""
        if lost:
            self.lost = (self.lost + [{**x, "time": iso(now)} for x in lost])[-100:]
            self.journal.event("lost", transactions=lost)

    def hold(self, tx: str, now: float, why: str) -> None:
        """Leaves a transaction out of the blocks for the cool-down."""
        self.excluded[tx] = now + self.cooldown
        self.journal.event("excluded", transaction=tx, until=iso(now + self.cooldown), reason=why)

    def restore(self) -> None:
        """Sends the transactions a cut-short block was made from back to reth (see `recover_saved`). Raises while reth or Canton cannot be
        reached: the file stays and the loop backs off."""
        found = self.recover(self.cfg)
        if found:
            ref = found.pop("attempt", None)   # the attempt of an earlier run that never got its last line: this run closes it
            if ref:
                self.journal.event("resolved", attempt=ref["attempt"], attempt_run=ref["run"], outcome="restarted")
            self.emit(found)
            self.note_lost(found["lostTransactions"], self.clock())
            self.held = None
            self.write_status()

    # -- a transaction the prover cannot finish
    def hunt_out(self) -> set:
        """The transactions the next block must not hold while the hunt is on: the parked ones and the half of the candidates not under test."""
        h = self.hunt
        return set(h["parked"]) | (set(h["live"]) - set(h["probe"])) if h else set()

    def proving_failed(self, e: ProvingError, now: float) -> None:
        """The input tool or the prover failed on a block. Once is a failure of the service. Twice with a transaction in common, the
        culprit is one of the common ones: one alone is held back for the cool-down; several are narrowed down by half, each half in a
        block of its own, so that an honest transaction beside a bad one is not held back with it."""
        kept = list(dict.fromkeys(e.kept))
        if not self.proof_kept and not self.hunt:
            self.mark = self.passes   # the failures begin here: a pass after this is the proof that the service works
        h = self.hunt
        if h:
            under_test = [x for x in h["probe"] if x in kept]
            if under_test:   # the block held part of the half under test and failed: the culprit is among those
                if len(under_test) == 1:
                    return self.unprovable(under_test[0], now, str(e))
                h["parked"] = [*h["parked"], *(x for x in h["live"] if x not in under_test)]
                h["live"] = under_test
                return self.narrow()
            self.hunt = None   # the failure has other transactions in it: say nothing of the candidates, count afresh
        again = [x for x in kept if x in self.proof_kept]
        self.proof_kept = set(kept) - set(again)
        if len(again) == 1:
            self.unprovable(again[0], now, str(e))
        elif again:
            self.hunt = {"live": again, "probe": [], "parked": []}
            self.narrow()

    def narrow(self) -> None:
        h = self.hunt
        h["probe"] = h["live"] if len(h["live"]) == 1 else h["live"][:len(h["live"]) // 2]   # a lone candidate is tried alone, to be sure

    def hunt_passed(self, held: list) -> None:
        """A block went past the input tool and the prover. The candidates it held are cleared."""
        h = self.hunt
        if not h:
            return
        cleared = [x for x in h["probe"] if x in held]
        h["live"] = [x for x in h["live"] if x not in cleared]
        if not cleared or not h["live"]:
            self.hunt = None   # none of the half under test was in the block, or all are cleared: the failure was the service's, nobody is to blame
            return
        self.narrow()

    def proof_passed(self, held: list, now: float) -> None:
        """A block went past the input tool and the prover: the service works, and what the block held is cleared of blame. A conviction
        that waited for this is made now."""
        self.passes += 1
        self.proof_kept -= set(held)
        if self.control:
            tx, why = self.control["tx"], self.control["why"]
            self.control = None
            self.unprovable(tx, now, why, shown=True)

    def unprovable(self, tx: str, now: float, why: str, shown: bool = False) -> None:
        """Holds a transaction back. Not before a block has passed the prover since the failures began: a service that is down fails every
        block, and the transactions waiting would be blamed. Until one has, a block without the candidates is made first. A transaction
        convicted again is held back twice as long as the last time (up to a day)."""
        if not shown and self.passes <= self.mark:
            self.control = {"tx": tx, "why": why}
            return
        remaining = [x for x in (self.hunt["live"] + self.hunt["parked"] if self.hunt else []) if x != tx]
        self.hunt, self.proof_kept = None, set(remaining)   # the others the failures named stay counted: one more failure and the hunt goes on
        self.convictions[tx] = self.convictions.get(tx, 0) + 1
        cooldown = min(self.cooldown * 2 ** (self.convictions[tx] - 1), max(self.cooldown, 86400))
        self.excluded[tx] = now + cooldown
        self.excluded_why[tx] = f"it could not be proven: {why[:200]}"
        self.journal.event("excluded", transaction=tx, until=iso(now + cooldown), reason=self.excluded_why[tx])
        self.emit({"excluded": tx, "until": iso(now + cooldown), "reason": self.excluded_why[tx]})

    def settle_unknown(self) -> None:
        """After a block whose Advance had no answer: find out by the command's own completion. If it committed, it counts as committed.
        If it failed, reth goes back to Canton's head and gets the block's transactions again. While there is no completion (and the
        window the command can still commit in is not over), nothing is built, reth is not moved and the status says the block is waiting."""
        u = self.unresolved
        try:
            committed, lost, how, info = self.resolve(self.cfg, u, u["pairs"])   # raises while it cannot be read: backoff
        except Unresolved as why:
            u["why"] = str(why)   # the status says what it waits for (no completion yet, a clock skew, ...)
            self.write_status()
            self.wait(max(self.idle, 1.0))
            return
        now = self.clock()
        self.failures = 0
        self.unresolved = None
        report = {"resolved": "committed" if committed else "not committed", "number": u["number"], "blockHash": u["hash"]}
        if committed:
            report.update(updateId=info.get("updateId"), completionOffset=info.get("completionOffset"))
            self.committed += 1
            self.last_block_at = now
            self.last_committed = {"number": u["number"], "hash": u["hash"], "time": iso(now)}
        extra = {"attempt_run": u["attempt_run"]} if u.get("attempt_run") else {}
        known = {"update_id": info.get("updateId"), "completion_offset": info.get("completionOffset")} if committed else {}
        self.journal.event("resolved", attempt=u.get("attempt"), outcome=report["resolved"], via=how, **known, **extra)
        if committed:
            self.journal.event("final_seen", attempt=u.get("attempt"), number=u["number"], **extra)
        if lost:
            report["lostTransactions"] = lost
            self.note_lost(lost, now)
        self.held = None
        self.emit(report)
        self.write_status()

    def record(self, result: dict, pairs: list) -> None:
        now = self.clock()
        self.failures = 0
        if "proveSeconds" in result:
            self.timed += 1
            self.prove_total += result["proveSeconds"]
            self.advance_total += result.get("advanceSeconds", 0)
        self.hunt_passed([h.lower() for h in result.get("transactions", result.get("keptTransactions", []))])
        if result["committed"]:
            self.committed += 1
            self.refusals_in_row = 0
            self.previous_kept = set()
            self.proof_kept = set()
            self.held = None
            self.last_block_at = now
            self.last_committed = {"number": result["number"], "hash": result["blockHash"], "time": iso(now)}
            if self.probe is not None:   # the suspect had its block (or was not in the pool): next one
                self.suspects.remove(self.probe)
                self.probe = self.suspects[0] if self.suspects else None
            prune_work(self.cfg.work_dir, result["number"])
        else:
            self.last_error = {"time": iso(now), "error": result.get("reason", "")}
            if result.get("rewindError"):
                self.last_error["rewindError"] = result["rewindError"]
            if result["committed"] is False:
                self.refused += 1
                self.refusals_in_row += 1
                self.refusal(result, now)
            else:
                self.unknown += 1
                self.previous_kept = set()
                self.unresolved = {"number": result["number"], "hash": result["blockHash"], "pairs": pairs, **(result.get("resolve") or {}),
                                   "since": (result.get("resolve") or {}).get("submittedAt", now), "attempt": self.attempt.seq if self.attempt else None}   # the next step finds out
        self.emit(result)
        self.write_status()
        if result["committed"] is False:
            self.wait(max(self.idle, min(BACKOFF_CAP, 2.0 ** min(self.refusals_in_row - 1, 5))))

    def refusal(self, result: dict, now: float) -> None:
        """Canton refused the block. A transaction in two refused blocks in a row is suspected. A lone suspect is held back for the
        cool-down. Several are tried one block each (the others kept out of it) before any is held back, so an honest transaction that
        was only next to a bad one is not held back with it."""
        kept = {h.lower() for h in result.get("keptTransactions", [])}
        if self.probe is not None:   # the block held this suspect and no other: it is the one
            if self.probe in kept:
                self.hold(self.probe, now, "it was alone in a block Canton refused")
            self.suspects.remove(self.probe)
            self.probe = self.suspects[0] if self.suspects else None
            self.previous_kept = set()
            return
        again = kept & self.previous_kept
        if len(again) == 1:
            self.hold(next(iter(again)), now, "it was in two blocks in a row that Canton refused")
        elif again:
            self.suspects = sorted(again)
            self.probe = self.suspects[0]
        self.previous_kept = kept - again

    # -- the status file
    def status(self, state: str = "running") -> dict:
        avg = lambda total: round(total / self.timed, 3) if self.timed else None
        return {"state": state, "runId": self.journal.run_id, "journalError": self.journal.error, "startedAt": iso(self.started), "updatedAt": iso(self.clock()),
                "lastCommitted": self.last_committed, "blocksCommitted": self.committed, "blocksRefused": self.refused,
                "blocksUnknown": self.unknown, "consecutiveFailures": self.failures, "lastError": self.last_error,
                "excluded": [{"transaction": h, "until": iso(u), **({"reason": self.excluded_why[h]} if h in self.excluded_why else {})}
                             for h, u in sorted(self.excluded.items())],
                "searchingForUnprovable": self.hunt and {"candidates": self.hunt["live"]},
                "waitingToBeResolved": self.unresolved and {"number": self.unresolved["number"], "hash": self.unresolved["hash"],
                                                            "commandId": self.unresolved.get("commandId"), "why": self.unresolved.get("why")},
                "lostTransactions": self.lost,
                "averageProveSeconds": avg(self.prove_total), "averageAdvanceSeconds": avg(self.advance_total)}

    def write_status(self, state: str = "running", final: bool = False) -> None:
        """Atomic: a reader sees the old file or the new one. A file that cannot be written never stops the chain."""
        with self.status_lock:
            self.last_written = self.clock()
            self.status_last = json.loads(json.dumps(self.status(state)))   # a copy: it shares nothing with the loop's objects
            self.status_final = final
            self.put_status(self.status_last)

    def tick_status(self, done: threading.Event) -> None:
        """Runs beside the loop: every `status_tick` seconds it writes the loop's last status again with a fresh `updatedAt`, so a block that
        takes long (a proof, an Advance) does not make a monitor think the producer is dead. Nothing else in the file changes. It stops
        refreshing once the loop itself has written nothing for `status_stall` seconds, so a step that never returns shows as a stale file."""
        while not done.wait(self.status_tick):
            try:
                with self.status_lock:
                    if self.status_final or self.status_last is None:
                        return
                    now = self.clock()
                    if now - self.last_written > self.status_stall:
                        continue
                    self.put_status({**self.status_last, "updatedAt": iso(now)})
            except Exception as e:   # the ticker must not die while the run goes on
                if not self.ticker_warned:
                    self.ticker_warned = True
                    try:
                        print(f"the status ticker failed, it keeps running: {e!r}", file=sys.stderr)
                    except OSError:
                        pass

    def put_status(self, status: dict) -> None:
        tmp = self.status_file + ".tmp"
        try:
            Path(self.status_file).parent.mkdir(parents=True, exist_ok=True)
            Path(tmp).write_text(json.dumps(status, indent=1) + "\n")
            os.replace(tmp, self.status_file)
            self.status_warned = False
        except OSError as e:
            if self.status_warned:
                return
            self.status_warned = True
            try:
                print(f"cannot write the status file {self.status_file}: {e}", file=sys.stderr)
            except OSError:
                pass


def settle_once(cfg: Config, result: dict, sleep=time.sleep) -> dict:
    """`once` after a block whose Advance had no answer: waits, in this process, for the command's own outcome (its completion, or the end of
    the window it can commit in, then Canton's head) and returns the result as if Canton had answered: committed, or not committed
    (the block's transactions are back in reth's pool and reth is on Canton's head). If it cannot be settled, the result stays unknown."""
    u = {**result["resolve"], "since": result["resolve"]["submittedAt"]}
    pairs = read_saved(cfg) or []
    while True:
        try:
            committed, lost, how, info = resolve_unknown(cfg, u, pairs)
        except Unresolved:
            sleep(2)
            continue
        except Exception as e:   # Canton's head or reth cannot be reached: still not known, and reth is left where it is
            return {**result, "reason": f"{result['reason']}; and it could not be settled ({e})"}
        break
    settled = {k: v for k, v in result.items() if k not in ("resolve", "reason")}
    if lost:
        settled["lostTransactions"] = [*result.get("lostTransactions", []), *lost]
    if committed:
        return {**settled, "committed": True, "resolved": how, **info, "transactions": result["keptTransactions"]}
    return {**settled, "committed": False, "rejected": False, "resolved": how,
            "reason": f"{result['reason']}; settled as not committed ({how})"}


def produce(cfg: Config, args) -> int:
    stop = threading.Event()
    def on_signal(signum, frame):   # the block in progress finishes; a second signal acts as usual
        stop.set()
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
        signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    Producer(cfg, stop, args.idle_ms / 1000, args.heartbeat_seconds, args.status_file, args.exclude_cooldown_seconds,
             gather_ms=args.gather_ms, test=args.test, source_commit=source_commit()).run()
    return 0


def source_commit() -> str:
    """The commit this code was started from, for the journal's `run_started` line: CZE_SOURCE_COMMIT, else git's, else "unknown"."""
    if os.environ.get("CZE_SOURCE_COMMIT"):
        return os.environ["CZE_SOURCE_COMMIT"]
    try:
        done = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "HEAD"], capture_output=True, text=True, timeout=5)
        return done.stdout.strip() or "unknown" if done.returncode == 0 else "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        raise BuilderError(f"bad arguments: {message}")


def parser() -> argparse.ArgumentParser:
    ap = Arguments(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["once", "run"])
    ap.add_argument("--exclude", action="append", default=[], metavar="TX_HASH", help="once only: leave this transaction (and its sender's later ones) out")
    ap.add_argument("--read-as", action="append", default=[], metavar="PARTY", help="also read the contracts this party sees (repeatable); the builder still acts only as itself")
    ap.add_argument("--disclosed", metavar="FILE", help="a JSON list of disclosed contracts, passed with Advance as they are")
    ap.add_argument("--max-block-tx-bytes", type=int, default=65536, help="the most raw transaction bytes a block is offered (default 65536: about 130 KB of Advance argument, about 6 s of our participant's work; raise it when the participant's per-KB cost falls)")
    ap.add_argument("--idle-ms", type=int, default=500, help=f"run: how long to wait between looks at an empty pool (at least {MIN_IDLE_MS})")
    ap.add_argument("--strategy", default=os.environ.get("CZE_BLOCK_STRATEGY", "on_demand"), help=f"run: when a block is cut: {', '.join(STRATEGIES)} (default; also CZE_BLOCK_STRATEGY)")
    ap.add_argument("--gather-ms", type=float, default=0, help="run: after a transaction reaches an idle pool, wait this long for more before cutting (0: cut at once)")
    ap.add_argument("--heartbeat-seconds", "--empty-every-seconds", dest="heartbeat_seconds", type=float, default=0,
                    help="run: make an empty block when none was made for this long (0: never; --empty-every-seconds is the old name)")
    ap.add_argument("--package-id", metavar="ID", help="submit every Advance with packageIdSelectionPreference [ID], so that it runs under that Daml package version whatever else is vetted (default: Canton picks by package name)")
    ap.add_argument("--test", action="store_true", help="run: mark this run in the journal as a flood or another test, so that the explorer's statistics can leave it out")
    ap.add_argument("--status-file", metavar="PATH", help="run: where to write the status (default: status.json in the work folder)")
    ap.add_argument("--exclude-cooldown-seconds", type=float, default=600, help="run: how long a transaction in two refused blocks in a row is left out")
    return ap


def main() -> int:
    """Every way this can fail prints one JSON line and exits 1; a block Canton refused exits 2."""
    try:
        args = parser().parse_args()
        if args.command == "run" and args.exclude:
            raise BuilderError("bad arguments: --exclude is for once; run leaves out the transactions Canton keeps refusing by itself")
        if args.exclude_cooldown_seconds < 0:
            raise BuilderError("bad arguments: --exclude-cooldown-seconds cannot be negative")
        if args.command == "run":
            check_strategy(args.strategy, args.gather_ms, args.heartbeat_seconds)
        if args.idle_ms < MIN_IDLE_MS:
            raise BuilderError(f"bad arguments: --idle-ms must be at least {MIN_IDLE_MS}: a shorter wait would only keep reth busy")
        if args.max_block_tx_bytes < 1:
            raise BuilderError("bad arguments: --max-block-tx-bytes must be at least 1")
        cfg = Config.from_env()
        cfg.max_block_tx_bytes = args.max_block_tx_bytes
        cfg.read_as = tuple(dict.fromkeys(args.read_as))
        if args.disclosed:
            cfg.disclosed = read_disclosed(args.disclosed)
        if args.package_id is not None:
            cfg.package_id = check_package_id(args.package_id)
        with work_lock(cfg.work_dir):
            if args.command == "run":
                return produce(cfg, args)
            recovered = recover_saved(cfg, wait=time.sleep)   # a block cut short earlier: its transactions go back to reth first
            before = recovered["lostTransactions"] if recovered else []
            earlier = recovered.get("settled") if recovered else None   # what became of an earlier block whose Advance had no answer
            try:
                result = build_block(cfg, {h.lower() for h in args.exclude})
            except Exception as e:   # the failure names the transactions lost on the way, and the ones the recovery could not resend
                e.lost_transactions = [*before, *getattr(e, "lost_transactions", [])]
                raise
            if result["committed"] is None and "resolve" in result:   # no answer: its own completion settles it before anything else
                result = settle_once(cfg, result)
            if before:
                result["lostTransactions"] = [*before, *result.get("lostTransactions", [])]
            if earlier:
                result["settledEarlier"] = earlier
    except Exception as e:   # a BuilderError, an unreachable service, a reply that is not JSON or not what was expected, and the like
        print(json.dumps(failure_report(e)))
        return 1
    print(json.dumps(result))
    return 0 if result["committed"] else 2


if __name__ == "__main__":
    sys.exit(main())
