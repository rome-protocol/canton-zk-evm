#!/usr/bin/env python3
"""Rebuilds reth from Canton: reads every block the chain committed, in order, and feeds each one to reth through the Engine API (newPayload,
then forkchoiceUpdated), the way the builder commits a block. Nothing is built or chosen: a block's header and its transactions are exactly what
Canton's BlockRecord holds (the Advance carried them), so reth must end on the block hash Canton recorded.

  check     --from N --to M: re-executes the recorded blocks N..M on a scratch reth and writes a report (JSON, --report) with, for every block, the
            hash, state root, receipts root, gas used and transaction count reth got against the ones the header Canton holds names. Used to re-check
            blocks that were proven under an older prover. The scratch reth is started like the rebuild's (launch.sh, discovery off, no peers) on its own
            data, at block N-1 or earlier: blocks before N are applied first without being reported. A reth already at or past N is refused, since
            reth does not execute a block it already has (this also keeps the check off the chain's own reth). It stops at the first block that does
            not match, with the same FAIL line; the report is written for every stop except a range that is not one (the failure is in the report).
  rebuild   reth must be running as network/reth/launch.sh starts it (discovery off, no peers), empty or behind Canton. Blocks reth has already are
            skipped, so a run that stopped can be started again and goes on from reth's head. It stops at the first block that does not match, with
            a report: the block's header does not hash to the hash its record names, Canton has no record of the next block, the block is not on
            reth's head, reth refuses the block, or reth's block hash differs from the recorded one. It ends when reth's head is Canton's head. Before it changes reth it reads the records once to see which chain Canton holds: only records of reth's chain id (and,
            where the party sees the ZkChain contract, of its operator, confirmer and builder) count, a block number that appears twice stops it, every block above
            reth's head must have a record, and the newest record must be the ZkChain contract's head. --after-offset N reads only the records created after the ledger
            offset N (the current chain's start, or the first offset a pruned participant holds). It takes the builder's work-folder lock (a running builder refuses it).
            A block whose header names execution requests (EIP-7002/7251) is refused: the record does not hold them.

This only reads Canton (a read token for the reader or the builder party) and never submits anything to it. It does not start reth.
Check prints: mode, from, to, checked, ok, report, reth_head.

Prints key=value lines (rebuild): mode, canton_head, canton_hash, reth_before, applied, reth_head, reth_hash. Exits 0 only when reth's head is Canton's head;
on a stop it prints FAIL lines (block, recorded, reth, why) to stderr and exits 1. Reads the environment the builder reads: CZE_STATE_DIR (the Engine
secret, jwt.hex), RETH_HTTP_PORT, RETH_ENGINE_PORT, CZE_LEDGER_URL, CZE_LEDGER_TOKEN or CZE_LEDGER_TOKEN_FILE, and the party to read as: --party, or
CZE_READER_PARTY, or CZE_BUILDER_PARTY."""
import argparse, base64, contextlib, hashlib, hmac, json, os, sys, time, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "builder"))
from keccak import keccak256

RECORD_SUFFIX = ":Zk.Chain:BlockRecord"
PAGE = 200            # updates asked of Canton at a time
ZERO32 = "0x" + "00" * 32
CHAIN = "#canton-zk-evm:Zk.Chain:ZkChain"
NO_REQUESTS = "0x" + hashlib.sha256(b"").hexdigest()   # the header's requests hash of a block with no execution requests


class ReplayError(Exception):
    """A stop. `number` is the block it stopped at (None when it is not about one block); recorded and found are the two hashes that disagree, when there are two."""
    def __init__(self, why: str, number: int | None = None, recorded: str | None = None, found: str | None = None):
        super().__init__(why)
        self.why, self.number, self.recorded, self.found = why, number, recorded, found

    def report(self) -> str:
        parts = [f"block={self.number}" if self.number is not None else "block=-"]
        if self.recorded:
            parts.append(f"recorded={self.recorded}")
        if self.found:
            parts.append(f"reth={self.found}")
        return "FAIL " + " ".join(parts) + f" why={self.why}"


# ---- RLP and the header -------------------------------------------------------------------------------------------

def rlp_decode(b: bytes, i: int = 0) -> tuple:
    """(item, end): an item is bytes (a string) or a list of items; for a list, `raw` below keeps its bytes."""
    if i >= len(b):
        raise ValueError("the RLP ends where an item should start")
    p = b[i]
    if p < 0x80:
        return b[i:i + 1], i + 1
    if p < 0xC0:
        start, n = (i + 1, p - 0x80) if p < 0xB8 else (i + 1 + p - 0xB7, int.from_bytes(b[i + 1:i + 1 + p - 0xB7], "big"))
        if start + n > len(b):
            raise ValueError("an RLP string runs past the end")
        return b[start:start + n], start + n
    start, n = (i + 1, p - 0xC0) if p < 0xF8 else (i + 1 + p - 0xF7, int.from_bytes(b[i + 1:i + 1 + p - 0xF7], "big"))
    end = start + n
    if end > len(b):
        raise ValueError("an RLP list runs past the end")
    items, at = [], start
    while at < end:
        item, at = rlp_decode(b, at)
        items.append(item)
    if at != end:
        raise ValueError("an RLP list does not end where it says")
    return items, end


def rlp_span(b: bytes, i: int) -> tuple:
    """(payload start, end, is a list) of the RLP item at i."""
    p = b[i]
    if p < 0x80:
        return i, i + 1, False
    base, is_list = (0x80, False) if p < 0xC0 else (0xC0, True)
    if p - base < 0x38:
        start, end = i + 1, i + 1 + p - base
    else:
        k = p - base - 0x37
        start = i + 1 + k
        end = start + int.from_bytes(b[i + 1:start], "big")
    if end > len(b):
        raise ValueError("an RLP item runs past the end")
    return start, end, is_list


def tx_list(txs_hex: str) -> list:
    """The raw transactions of a record's txsHex ("" is a block with none), each as it goes into the payload: a typed transaction is the bytes
    inside its RLP string, a legacy one is its whole RLP list."""
    if txs_hex == "":
        return []
    b = bytes.fromhex(txs_hex)
    start, end, is_list = rlp_span(b, 0)
    if not is_list or end != len(b):
        raise ValueError("the transactions are not one RLP list")
    out, at = [], start
    while at < end:
        s, e, item_is_list = rlp_span(b, at)
        out.append("0x" + (b[at:e] if item_is_list else b[s:e]).hex())
        at = e
    return out


def q(b: bytes) -> str:
    return hex(int.from_bytes(b, "big"))


def payload_of(header: bytes, txs_hex: str) -> tuple:
    """(the Engine API payload for this header and these transactions, the parent beacon block root). The header is the Prague form: 21 fields, up to
    the parent beacon block root and the requests hash."""
    fields, end = rlp_decode(header)
    if not isinstance(fields, list) or end != len(header) or len(fields) != 21 or any(not isinstance(f, bytes) for f in fields):
        raise ValueError(f"the header is not the 21-field form this tool reads (it has {len(fields) if isinstance(fields, list) else 'no'} fields)")
    x = lambda n: "0x" + fields[n].hex()
    payload = {"parentHash": x(0), "feeRecipient": x(2), "stateRoot": x(3), "receiptsRoot": x(5), "logsBloom": x(6), "prevRandao": x(13),
               "blockNumber": q(fields[8]), "gasLimit": q(fields[9]), "gasUsed": q(fields[10]), "timestamp": q(fields[11]), "extraData": x(12),
               "baseFeePerGas": q(fields[15]), "blockHash": "0x" + keccak256(header).hex(), "transactions": tx_list(txs_hex), "withdrawals": [],
               "blobGasUsed": q(fields[17]), "excessBlobGas": q(fields[18])}
    return payload, x(19)


# ---- Canton (read only) ------------------------------------------------------------------------------------------

def post(url: str, body: dict | None, headers: dict, timeout: float = 120):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data, {"content-type": "application/json", **headers})
    with urllib.request.urlopen(request, timeout=timeout) as r:
        return json.load(r)


class Canton:
    """The block records, read from the Ledger API as the reader (or builder) party: GET the ledger end, then POST /v2/updates in pages, each filtered to the BlockRecord template.
    The ZkChain contract (the chain's one state contract) is read from the active contracts when the party can see it, which the builder party can."""
    def __init__(self, url: str, party: str, token: str = "", token_file: str = "", page: int = PAGE):
        self.url, self.party, self.token, self.token_file, self.page = url.rstrip("/"), party, token, token_file, page

    @property
    def auth(self) -> dict:
        token = Path(self.token_file).read_text().strip() if self.token_file else self.token
        return {"authorization": "Bearer " + token} if token else {}

    def _post(self, path: str, body: dict | None):
        """One call to the Ledger API. A refusal or a failure is a stop that says what Canton answered, never a crash."""
        try:
            return post(self.url + path, body, self.auth)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except OSError:
                detail = ""
            finally:
                e.close()
            raise ReplayError(f"Canton answered HTTP {e.code} to {path.split('?')[0]}" + (f": {detail}" if detail else "")) from e
        except (OSError, ValueError) as e:
            raise ReplayError(f"Canton does not answer {path.split('?')[0]} as expected ({type(e).__name__}: {e})") from e

    def _end(self) -> int:
        try:
            return int(self._post("/v2/state/ledger-end", None)["offset"])
        except (KeyError, TypeError, ValueError) as e:
            raise ReplayError(f"Canton's ledger end cannot be read ({type(e).__name__}: {e})") from e

    def chains(self) -> list:
        """The create arguments of the active ZkChain contracts this party can see that it builds (the builder party sees its own; the reader party sees none)."""
        flt = {"identifierFilter": {"TemplateFilter": {"value": {"templateId": CHAIN, "includeCreatedEventBlob": False}}}}
        body = {"eventFormat": {"filtersByParty": {self.party: {"cumulative": [flt]}}, "verbose": False}, "activeAtOffset": self._end()}
        found = self._post("/v2/state/active-contracts", body)
        try:
            args = [e["contractEntry"]["JsActiveContract"]["createdEvent"]["createArgument"] for e in found if "JsActiveContract" in e["contractEntry"]]
            return [self.parse_chain(a) for a in args if a.get("builder") == self.party]
        except (KeyError, TypeError, ValueError, AttributeError) as e:
            raise ReplayError(f"a ZkChain contract cannot be read ({type(e).__name__}: {e})") from e

    def records(self, after_offset: int = 0):
        """Every block record after the ledger offset (default: from the start), in the order Canton committed them: dicts with chain id, parties, number, hash, parent,
        header (bytes), txs (hex). Pages are yielded as they are read."""
        end = self._end()
        flt = {"identifierFilter": {"TemplateFilter": {"value": {"templateId": "#canton-zk-evm:Zk.Chain:BlockRecord", "includeCreatedEventBlob": False}}}}
        begin = after_offset
        while begin < end:
            body = {"beginExclusive": begin, "endInclusive": end, "updateFormat": {"includeTransactions": {
                "eventFormat": {"filtersByParty": {self.party: {"cumulative": [flt]}}, "verbose": False}, "transactionShape": "TRANSACTION_SHAPE_ACS_DELTA"}}}
            items = self._post(f"/v2/updates?limit={self.page}", body)
            if not isinstance(items, list):
                raise ReplayError("Canton's answer to the updates read is not a list")
            if not items:
                break
            last = begin
            for item in items:
                try:
                    kind, wrapped = next(iter(item["update"].items()))
                    value = wrapped["value"]
                    last = max(last, int(value["offset"]))
                    events = value.get("events", []) if kind == "Transaction" else []
                    created = [e["CreatedEvent"] for e in events if "CreatedEvent" in e and e["CreatedEvent"]["templateId"].endswith(RECORD_SUFFIX)]
                except (KeyError, TypeError, ValueError, AttributeError, StopIteration) as e:
                    raise ReplayError(f"an update from Canton is not in the shape this tool reads ({type(e).__name__}: {e})") from e
                for c in created:
                    yield self.parse(c["createArgument"])
            if last <= begin:
                raise ReplayError("Canton's updates did not move forward")
            begin = last

    @staticmethod
    def parse(a: dict) -> dict:
        try:
            h = lambda s: "0x" + s.removeprefix("0x").lower()
            return {"chain_id": int(a["chainId"]), "operator": a["operator"], "confirmer": a["confirmer"], "builder": a["builder"],
                    "number": int(a["number"]), "hash": h(a["blockHash"]), "parent": h(a["parentHash"]),
                    "header": bytes.fromhex(a["headerHex"]), "txs": a["txsHex"]}
        except (KeyError, ValueError, TypeError, AttributeError) as e:
            raise ReplayError(f"a block record cannot be read ({type(e).__name__}: {e})") from e

    @staticmethod
    def parse_chain(a: dict) -> dict:
        return {"chain_id": int(a["chainId"]), "operator": a["operator"], "confirmer": a["confirmer"], "builder": a["builder"],
                "number": int(a["headNumber"]), "hash": "0x" + a["headHash"].removeprefix("0x").lower()}


# ---- reth -------------------------------------------------------------------------------------------------------

def jwt_token(secret: bytes, now: int | None = None) -> str:
    enc = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=")
    signing = enc(b'{"alg":"HS256","typ":"JWT"}') + b"." + enc(json.dumps({"iat": int(now or time.time())}).encode())
    return (signing + b"." + enc(hmac.new(secret, signing, hashlib.sha256).digest())).decode()


class Reth:
    """reth's HTTP JSON-RPC (reads) and Engine API (newPayload, forkchoiceUpdated, signed with the Engine secret)."""
    def __init__(self, http_url: str, engine_url: str, jwt_secret: bytes):
        self.http_url, self.engine_url, self.jwt_secret = http_url, engine_url, jwt_secret

    def _call(self, url: str, method: str, params: list, headers: dict):
        try:
            reply = post(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, headers, timeout=120)
        except OSError as e:
            raise ReplayError(f"{method}: reth does not answer ({e})") from e
        if "error" in reply:
            raise ReplayError(f"{method} failed: {reply['error']}")
        return reply["result"]

    def block(self, tag: str) -> dict:
        b = self._call(self.http_url, "eth_getBlockByNumber", [tag, False], {})
        return {"number": int(b["number"], 16), "hash": b["hash"]} if b else {"number": None, "hash": None}

    def head(self) -> dict:
        return self.block("latest")

    def chain_id(self) -> int:
        return int(self._call(self.http_url, "eth_chainId", [], {}), 16)

    def block_roots(self, number: int) -> dict:
        """What reth itself computed for a block: hash, state root, receipts root, gas used, and how many transactions it holds."""
        b = self._call(self.http_url, "eth_getBlockByNumber", [hex(number), False], {})
        if not b:
            return {}
        return {"hash": b["hash"], "state_root": b.get("stateRoot"), "receipts_root": b.get("receiptsRoot"), "gas_used": int(b["gasUsed"], 16) if b.get("gasUsed") else None,
                "tx_count": len(b["transactions"]) if b.get("transactions") is not None else None}

    def engine(self, method: str, params: list):
        return self._call(self.engine_url, method, params, {"authorization": "Bearer " + jwt_token(self.jwt_secret)})

    def new_payload(self, payload: dict, beacon_root: str) -> dict:
        return self.engine("engine_newPayloadV4", [payload, [], beacon_root, []])

    def forkchoice(self, head: str) -> dict:
        state = {"headBlockHash": head, "safeBlockHash": head, "finalizedBlockHash": head}   # Canton committed the block: it is final
        return self.engine("engine_forkchoiceUpdatedV3", [state, None])["payloadStatus"]


# ---- one chain, checked before reth is touched -------------------------------------------------------------------

def scope_of(canton, chain_id: int) -> tuple:
    """(the fields every record of this chain carries, the head the ZkChain contract names or None). The records are those with reth's chain id; when the party sees the
    ZkChain contract (the builder party does), its operator, confirmer and builder narrow them to the one chain instance, and its head is what the replay must end on."""
    scope, head = {}, None
    chains = canton.chains()
    if len(chains) > 1:
        raise ReplayError(f"this party sees {len(chains)} ZkChain contracts it builds: it cannot tell which chain to rebuild")
    if chains:
        c = chains[0]
        if c["chain_id"] != chain_id:
            raise ReplayError(f"reth's chain id is {chain_id}, the ZkChain contract's is {c['chain_id']}: reth was started for another chain")
        scope = {k: c[k] for k in ("operator", "confirmer", "builder")}
        head = {"number": c["number"], "hash": c["hash"]}
    return scope, head


def survey(records, chain_id: int, scope: dict) -> dict:
    """number -> hash of the records of this chain, from one read of the whole stream. A number that appears twice stops it: the party sees more than one chain of this id
    (a network that was reset starts a new chain from the same genesis, chain id and pins), and the blocks of the older one must not reach reth."""
    found = {}
    for rec in records:
        if rec["chain_id"] != chain_id or any(rec[k] != v for k, v in scope.items()):
            continue
        n = rec["number"]
        if n in found:
            raise ReplayError(f"Canton holds two records for block {n}: more than one chain is visible to this party. Read from the current chain's first block with "
                              f"--after-offset (the ledger offset before its first block), or read as the builder party", n, found[n])
        found[n] = rec["hash"]
    return found


def require_run(known: dict, first: int, last: int) -> None:
    """Every block first..last has a record."""
    for k in range(first, last + 1):
        if k not in known:
            raise ReplayError(f"Canton has no record of block {k}" + (f": it holds blocks up to {max(known)}" if known and k > max(known) else ""), k)


def replayable(records, chain_id: int, scope: dict, first: int, last: int):
    """The records first..last of this chain, in order, as the second read of the stream gives them."""
    for rec in records:
        if rec["chain_id"] != chain_id or any(rec[k] != v for k, v in scope.items()) or rec["number"] < first:
            continue
        if rec["number"] > last:
            break
        yield rec


# ---- rebuild ---------------------------------------------------------------------------------------------------

def apply_block(reth, rec: dict, head: dict) -> None:
    """Feeds one record to reth and checks reth's block is the recorded one. Raises ReplayError at the first thing that is wrong."""
    n, want = rec["number"], rec["hash"]
    if "0x" + keccak256(rec["header"]).hex() != want:
        raise ReplayError("the header Canton holds does not hash to the block hash its record names", n, want, "0x" + keccak256(rec["header"]).hex())
    try:
        payload, beacon_root = payload_of(rec["header"], rec["txs"])
    except ValueError as e:
        raise ReplayError(f"the record cannot be turned into a payload: {e}", n, want) from e
    if "0x" + rlp_decode(rec["header"])[0][20].hex() != NO_REQUESTS:
        raise ReplayError("the block carries execution requests (its header's requests hash is not the empty one), which the record does not hold: this tool cannot replay it", n, want)
    if int(payload["blockNumber"], 16) != n or payload["parentHash"] != rec["parent"]:
        raise ReplayError("the record's number or parent hash is not the header's", n, want)
    if rec["parent"] != head["hash"] or n != head["number"] + 1:
        raise ReplayError(f"the block does not follow reth's head (reth's head is block {head['number']} {head['hash']}, the block's parent is {rec['parent']}). "
                          "If this is block 1, reth's genesis is not the chain's: start reth with the genesis the chain was started with", n, want, head["hash"])
    status = reth.new_payload(payload, beacon_root)
    if status.get("status") != "VALID":
        raise ReplayError(f"reth did not accept the block: newPayload answered {status.get('status')}"
                          + (f" ({status['validationError']})" if status.get("validationError") else ""), n, want, status.get("latestValidHash"))
    fc = reth.forkchoice(want)
    if fc.get("status") != "VALID":
        raise ReplayError(f"reth did not move to the block: forkchoiceUpdated answered {fc.get('status')}", n, want)
    got = reth.block(hex(n))
    if got["hash"] != want:
        raise ReplayError("reth's block hash is not the recorded one", n, want, got["hash"])
    now = reth.head()
    if now["hash"] != want:
        raise ReplayError("reth's head is not the block after the update", n, want, now["hash"])


def rebuild(canton, reth, log=lambda s: None, after_offset: int = 0) -> dict:
    """Makes reth's head Canton's head by replaying the records after reth's head. Resumable: it starts from reth's own head, and reth's head must be on
    Canton's chain (the first record after it names it as its parent). The whole stream is read once before reth is touched, to see which chain it holds: records of
    another chain id are left out, a block number that appears twice stops the run, there must be a record for every block above reth's head, and where the party
    sees the ZkChain contract its head must be the newest record."""
    chain_id = reth.chain_id()
    scope, zk_head = scope_of(canton, chain_id)
    before = reth.head()
    known = survey(canton.records(after_offset), chain_id, scope)
    top = max(known, default=0)
    if not known and before["number"] != 0:
        raise ReplayError(f"Canton has no block records, and reth is at block {before['number']}", before["number"])
    if known and zk_head and (top, known[top]) != (zk_head["number"], zk_head["hash"]):
        raise ReplayError(f"the newest block record (block {top}) is not the head of the ZkChain contract (block {zk_head['number']})", top, known[top], zk_head["hash"])
    if not known and zk_head and zk_head["number"] != 0:
        raise ReplayError(f"Canton shows no block records, and the ZkChain contract's head is block {zk_head['number']}: the read starts too late (--after-offset)", zk_head["number"])
    if before["number"] > top:
        raise ReplayError(f"reth is ahead of Canton (reth's head is block {before['number']}, Canton's is {top}): use sync_reth.py", before["number"])
    if before["number"] in known and known[before["number"]] != before["hash"]:
        raise ReplayError("reth's head is not the block Canton recorded at its number", before["number"], known[before["number"]], before["hash"])
    require_run(known, before["number"] + 1, top)
    head, applied = dict(before), 0
    for rec in replayable(canton.records(after_offset), chain_id, scope, before["number"] + 1, top):
        apply_block(reth, rec, head)
        head, applied = {"number": rec["number"], "hash": rec["hash"]}, applied + 1
        log(f"block {rec['number']} {rec['hash']} applied")
    if head["number"] != top or (top and head["hash"] != known[top]):
        raise ReplayError(f"Canton's records changed between the two reads: reth ended on block {head['number']}, the first read saw blocks up to {top}", head["number"], known.get(head["number"]), head["hash"])
    return {"mode": "rebuild", "canton_head": top, "canton_hash": head["hash"], "reth_before": before["number"], "applied": applied,
            "reth_head": head["number"], "reth_hash": head["hash"]}


# ---- check ------------------------------------------------------------------------------------------------------

def header_roots(header: bytes, txs_hex: str) -> dict:
    """What the recorded header says reth must get for the block."""
    fields, _ = rlp_decode(header)
    return {"state_root": "0x" + fields[3].hex(), "receipts_root": "0x" + fields[5].hex(), "gas_used": int.from_bytes(fields[10], "big"), "tx_count": len(tx_list(txs_hex))}


def check(canton, reth, start: int, end: int, log=lambda s: None, after_offset: int = 0) -> dict:
    """Re-executes blocks start..end on reth (a scratch reth at block start-1 or earlier) and compares what reth got with the recorded header. Returns the report;
    report["ok"] is True only when every block in the range matched. Any stop after the range is accepted (a block that does not match, a missing block, a refusal
    before the range, reth that cannot be used) is in report["failure"] with its block number, so the caller can always write the report. Raises ReplayError only for a
    range that is not one."""
    if start < 1 or end < start:
        raise ReplayError(f"the range is {start}..{end}: it must be block 1 or later, and --to not before --from")
    report = {"mode": "check", "from": start, "to": end, "ok": False, "checked": 0, "blocks": [], "failure": None}
    try:
        chain_id = reth.chain_id()
        scope, _ = scope_of(canton, chain_id)
        before = reth.head()
        if before["number"] > start - 1:
            raise ReplayError(f"reth is at block {before['number']}, past block {start - 1}: reth does not execute a block it already has. Start a scratch reth on its own data "
                              f"(network/reth/launch.sh) at block {start - 1} or earlier", start)
        known = survey(canton.records(after_offset), chain_id, scope)
        if before["number"] in known and known[before["number"]] != before["hash"]:
            raise ReplayError("the scratch reth's head is not the block Canton recorded at its number", before["number"], known[before["number"]], before["hash"])
        require_run(known, before["number"] + 1, end)
        head = dict(before)
        for rec in replayable(canton.records(after_offset), chain_id, scope, before["number"] + 1, end):
            n = rec["number"]
            try:
                apply_block(reth, rec, head)
                entry = {"number": n, "recorded_hash": rec["hash"], "reth_hash": rec["hash"], "tx_count": None}
                if n >= start:
                    want, got = header_roots(rec["header"], rec["txs"]), reth.block_roots(n)
                    entry.update({"state_root": want["state_root"], "receipts_root": want["receipts_root"], "gas_used": want["gas_used"], "tx_count": want["tx_count"]})
                    for k in ("state_root", "receipts_root", "gas_used", "tx_count"):
                        if got.get(k) is not None and got[k] != want[k]:
                            raise ReplayError(f"reth's {k.replace('_', ' ')} is not the recorded one (recorded {want[k]}, reth {got[k]})", n, rec["hash"], got.get("hash"))
            except ReplayError as err:
                if n >= start:
                    report["blocks"].append({"number": n, "recorded_hash": rec["hash"], "reth_hash": err.found, "ok": False})
                raise
            head = {"number": n, "hash": rec["hash"]}
            if n >= start:
                entry["ok"] = True
                report["blocks"].append(entry)
                report["checked"] += 1
                log(f"block {n} {rec['hash']} matches")
        if head["number"] != end:
            raise ReplayError(f"Canton's records changed between the two reads: reth ended on block {head['number']}, the range ends at {end}", head["number"] + 1)
    except ReplayError as err:
        report["failure"] = {"number": err.number, "recorded": err.recorded, "reth": err.found, "why": err.why}
        return report
    report["ok"] = True
    report["reth_head"] = end
    return report


@contextlib.contextmanager
def work_lock(work_dir: str):
    """The same lock the builder holds on its work folder (builder/builder.py work_lock, without importing the builder and its dependencies)."""
    import fcntl
    Path(work_dir).mkdir(parents=True, exist_ok=True)
    with open(Path(work_dir) / "builder.lock", "w") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as err:
            raise ReplayError(f"the builder is running, or another rebuild or sync_reth (it holds {Path(work_dir) / 'builder.lock'}): stop it first, reth must not be moved under it") from err
        yield


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Rebuild reth from the blocks Canton recorded.")
    ap.add_argument("mode", choices=["rebuild", "check"])
    ap.add_argument("--from", dest="start", type=int, help="check: the first block to re-execute")
    ap.add_argument("--to", dest="end", type=int, help="check: the last block to re-execute")
    ap.add_argument("--report", help="check: where to write the report (JSON); default check-report-<from>-<to>.json in the current folder")
    ap.add_argument("--after-offset", type=int, default=0, help="read the block records created after this ledger offset (default 0, the start): the offset before the "
                    "current chain's first block, when the party sees records of an older chain too, or the first offset the participant still holds")
    ap.add_argument("--party", default=os.environ.get("CZE_READER_PARTY") or os.environ.get("CZE_BUILDER_PARTY", ""), help="the party to read Canton as (a read token)")
    args = ap.parse_args(argv)
    e = os.environ
    try:
        with contextlib.ExitStack() as stack:
            if args.mode == "check" and (args.start is None or args.end is None):
                raise ReplayError("check needs --from N and --to M")
            if not args.party:
                raise ReplayError("set --party, CZE_READER_PARTY or CZE_BUILDER_PARTY")
            state = Path(e.get("CZE_STATE_DIR", ROOT / "state"))
            try:
                secret = bytes.fromhex((state / "jwt.hex").read_text().strip())
            except (OSError, ValueError) as err:
                raise ReplayError(f"cannot read the Engine secret {state / 'jwt.hex'}: {err}") from err
            if args.mode == "rebuild":   # the builder's work-folder lock (builder.lock, as builder.work_lock and sync_reth.py take it): a running builder must not have its reth moved under it
                stack.enter_context(work_lock(e.get("CZE_WORK_DIR", str(state / "builder"))))
            canton = Canton(e.get("CZE_LEDGER_URL", "http://127.0.0.1:7575"), args.party, e.get("CZE_LEDGER_TOKEN", ""), e.get("CZE_LEDGER_TOKEN_FILE", ""))
            reth = Reth(f"http://127.0.0.1:{e.get('RETH_HTTP_PORT', 8545)}", f"http://127.0.0.1:{e.get('RETH_ENGINE_PORT', 8551)}", secret)
            log = lambda s: print(s, file=sys.stderr, flush=True)
            if args.mode == "check":
                rep = check(canton, reth, args.start, args.end, log, args.after_offset)
                path = Path(args.report or f"check-report-{args.start}-{args.end}.json")
                path.write_text(json.dumps(rep, indent=2) + "\n")
                if not rep["ok"]:
                    f = rep["failure"]
                    print(ReplayError(f["why"], f["number"], f["recorded"], f["reth"]).report() + f" report={path}", file=sys.stderr)
                    return 1
                result = {"mode": "check", "from": args.start, "to": args.end, "checked": rep["checked"], "ok": "true", "report": path, "reth_head": rep["reth_head"]}
            else:
                result = rebuild(canton, reth, log, args.after_offset)
    except ReplayError as err:
        print(err.report(), file=sys.stderr)
        return 1
    except (urllib.error.URLError, OSError) as err:
        print(f"FAIL block=- why=a service does not answer: {err}", file=sys.stderr)
        return 1
    for k, v in result.items():
        print(f"{k}={v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
