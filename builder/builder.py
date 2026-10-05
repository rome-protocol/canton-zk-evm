#!/usr/bin/env python3
"""The builder: makes one block, gets it proven and submits it to Canton. See README.md.

  builder.py once [--exclude <tx hash>]... [--read-as <party>]... [--disclosed <file>]

Exit status: 0 if Canton committed the block, 2 if Canton refused it (reth is moved back to Canton's head) or if it is
not known whether it committed ("committed": null; reth is left where it is), 1 on any other failure (reth is moved
back too, where it had moved). One JSON line on stdout says which, whatever the failure.
"""
import argparse, base64, hashlib, hmac, http.client, json, os, subprocess, sys, time, urllib.error, urllib.request, uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from websockets.sync.client import connect

from keccak import keccak256

ROOT = Path(__file__).resolve().parent.parent
ZERO32 = "0x" + "00" * 32
NO_CODE = "0x" + keccak256(b"").hex()   # the code hash of an account with no code, which is what reth answers for one that does not exist
EMPTY_LIST = b"\xc0"   # the RLP of a list with nothing in it; the transactions of an empty block
CHAIN = "#canton-zk-evm:Zk.Chain:ZkChain"
TERMS = "#canton-zk-evm:Zk.Chain:DvpTerms"
ALLOCATION = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation"


class BuilderError(Exception):
    pass


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
        return cls(
            ws_url=f"ws://127.0.0.1:{e.get('RETH_WS_PORT', 8546)}",
            engine_url=f"http://127.0.0.1:{e.get('RETH_ENGINE_PORT', 8551)}",
            jwt_secret=jwt_secret,
            ledger_url=e.get("CZE_LEDGER_URL", "http://127.0.0.1:7575"),
            ledger_user=need("CZE_LEDGER_USER"), ledger_token=e.get("CZE_LEDGER_TOKEN", ""),
            party=need("CZE_BUILDER_PARTY"), fee_recipient=need("CZE_FEE_RECIPIENT"),
            genesis=e.get("CZE_GENESIS", str(ROOT / "network" / "genesis.json")),
            work_dir=e.get("CZE_WORK_DIR", str(state / "builder")),
            make_input_cmd=e.get("CZE_MAKE_INPUT_CMD", str(ROOT / "prover" / "make-input.sh")),
            prove_cmd=e.get("CZE_PROVE_CMD", str(ROOT / "prover" / "prove-one.sh")))


# ---- reth ------------------------------------------------------------------------------------------------------

def jwt_token(secret: bytes, now: int | None = None) -> str:
    """The Engine API's token: HS256 over {"iat": now}, signed with the shared secret."""
    enc = lambda raw: base64.urlsafe_b64encode(raw).rstrip(b"=")
    signing = enc(b'{"alg":"HS256","typ":"JWT"}') + b"." + enc(json.dumps({"iat": int(now or time.time())}).encode())
    return (signing + b"." + enc(hmac.new(secret, signing, hashlib.sha256).digest())).decode()


def post_json(url: str, body: dict, headers: dict) -> object:
    request = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **headers})
    with urllib.request.urlopen(request, timeout=120) as r:
        return json.load(r)


class Reth:
    def __init__(self, cfg: Config, ws):
        self.cfg, self.ws, self.next_id = cfg, ws, 0

    def call(self, method: str, params: list):
        """A call on the builder-only WebSocket port."""
        self.next_id += 1
        self.ws.send(json.dumps({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params}))
        reply = json.loads(self.ws.recv())
        if "error" in reply:
            raise BuilderError(f"{method} failed: {reply['error']}")
        return reply["result"]

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


def price(t: dict) -> int:
    return int(t.get("maxFeePerGas") or t.get("gasPrice") or "0x0", 16)


def choose_txs(pending: dict, budget: int, exclude: set) -> list:
    """Takes transactions from reth's pending pool, best price first, each sender's in nonce order, until the gas
    budget is used. A transaction that does not fit, or is excluded, ends its sender's turn: its followers could not
    run without it."""
    queues = [[t for _, t in sorted(by_nonce.items(), key=lambda kv: int(kv[0]))] for by_nonce in pending.values()]
    chosen = []
    while queues:
        queues.sort(key=lambda q: price(q[0]), reverse=True)
        head = queues[0].pop(0)
        if head["hash"] in exclude or int(head["gas"], 16) > budget:
            queues.pop(0)
            continue
        chosen.append(head)
        budget -= int(head["gas"], 16)
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

class Ledger:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.auth = {"authorization": "Bearer " + cfg.ledger_token} if cfg.ledger_token else {}

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

    def active_allocations(self) -> dict:
        """The token standard's allocations that are active and that the builder can see: id -> the allocation's
        specification (executor, deadlines, the transfer leg), or None if the participant shows no view of it."""
        flt = {"InterfaceFilter": {"value": {"interfaceId": ALLOCATION, "includeInterfaceView": True, "includeCreatedEventBlob": False}}}
        found = {}
        for e in self._created(flt):
            views = [v["viewValue"] for v in e.get("interfaceViews") or [] if v.get("viewStatus", {}).get("code", 0) == 0 and v.get("viewValue")]
            found[e["contractId"]] = views[0]["allocation"] if views else None
        return found

    def head(self) -> dict:
        # Parties given with --read-as may let the builder see other builders' chains; only the ones it builds count.
        found = [c for c in self.active(CHAIN) if c.get("builder") == self.cfg.party]
        if len(found) != 1:   # the chain has exactly one state contract
            raise BuilderError(f"expected one active ZkChain contract built by {self.cfg.party}, found {len(found)}")
        return found[0]

    def advance(self, chain: dict, headerHex: str, txsHex: str, proofHex: str, legs: list) -> None:
        argument = {"headerHex": headerHex, "txsHex": txsHex, "proofHex": proofHex, "legs": legs}
        command = {"ExerciseCommand": {"templateId": CHAIN, "contractId": chain["contractId"], "choice": "Advance", "choiceArgument": argument}}
        body = {"commands": [command], "commandId": str(uuid.uuid4()), "userId": self.cfg.ledger_user,
                "actAs": [self.cfg.party], "readAs": self.readers()}
        if self.cfg.disclosed:
            body["disclosedContracts"] = self.cfg.disclosed
        post_json(self.cfg.ledger_url + "/v2/commands/submit-and-wait", body, self.auth)


# ---- one block -------------------------------------------------------------------------------------------------

def run(cmd: str, *args: str) -> None:
    done = subprocess.run([*cmd.split(), *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise BuilderError(f"{Path(cmd.split()[0]).name} failed: {(done.stderr or done.stdout).strip()[-400:]}")


def balance_key(holder: str, slot: int) -> str:
    """Where Solidity keeps holder's entry of the mapping at `slot`."""
    return "0x" + keccak256(bytes(12) + bytes.fromhex(holder) + slot.to_bytes(32, "big")).hex()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def allocation_problem(spec: dict | None, terms: dict, operator: str, now: datetime) -> str | None:
    """Why an allocation cannot settle these terms in this block, or None. The deadline is judged by the builder's clock."""
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
    if leg.get("sender") != terms["u"]:
        return "its allocation's sender is not the terms' u"
    if leg.get("receiver") != terms["v"]:
        return "its allocation's receiver is not the terms' v"
    return None


def stored(proof: dict) -> int:
    """The balance an eth_getProof answer shows."""
    return int(proof["storageProof"][0]["value"], 16)


def proof_nodes(proof: dict) -> tuple:
    """(account nodes, storage nodes) of an eth_getProof answer, in hex without 0x."""
    return [x[2:] for x in proof["accountProof"]], [x[2:] for x in proof["storageProof"][0]["proof"]]


def make_legs(cfg: Config, reth: Reth, chain: dict, number: str) -> tuple:
    """(legs, skipped). A leg is attached for terms of this chain (naming its operator and its confirmer) only if their allocation is still active and
    visible, its settle-before time has not passed, its executor is the chain's operator, it moves from u to v, the
    holder's balance rose in this block by exactly the amount the terms expect (reth's proof at this block minus its
    proof at the parent, Canton's head), no other terms of this block point at the same allocation, and no earlier terms
    in this block name the same token and holder (one payment settles one terms). Other terms are left out of this
    block, and each is reported with its reason; they can be attached to a later block."""
    ledger = Ledger(cfg)
    live = ledger.active_allocations()
    now = utcnow()
    parent = hex(int(chain["headNumber"]))
    candidates, skipped = [], []
    for terms in ledger.active(TERMS):
        if int(terms["chainId"]) != int(chain["chainId"]):
            continue
        if terms["operator"] != chain["operator"] or terms["confirmer"] != chain["confirmer"]:
            skipped.append({"terms": terms["contractId"], "reason": "its operator or confirmer is not the chain's"})
            continue
        if terms["allocation"] not in live:
            skipped.append({"terms": terms["contractId"], "reason": "its allocation is not active, or not visible to the builder"})
            continue
        problem = allocation_problem(live[terms["allocation"]], terms, chain["operator"], now)
        if problem:
            skipped.append({"terms": terms["contractId"], "reason": problem})
            continue
        args = ["0x" + terms["token"], [balance_key(terms["holder"], int(terms["slot"]))]]
        after, before = reth.call("eth_getProof", [*args, number]), reth.call("eth_getProof", [*args, parent])
        if before["codeHash"] == NO_CODE:   # the account is not in the parent's state; no balance can be proven there
            skipped.append({"terms": terms["contractId"], "reason": "the token did not exist in the parent block"})
            continue
        if stored(after) < stored(before):
            skipped.append({"terms": terms["contractId"], "reason": f"the balance fell in this block, from {stored(before):#x} to {stored(after):#x}"})
            continue
        if stored(after) - stored(before) != int(terms["expected"], 16):
            skipped.append({"terms": terms["contractId"], "reason": f"the balance rose by {stored(after) - stored(before):#x} in this block, not by the amount the terms expect"})
            continue
        candidates.append((terms, after, before))
    legs, taken = [], set()
    for terms, after, before in candidates:
        if sum(t["allocation"] == terms["allocation"] for t, _, _ in candidates) > 1:   # an allocation can be executed once
            skipped.append({"terms": terms["contractId"], "reason": "another terms contract in this block points at the same allocation"})
            continue
        if (terms["token"], terms["holder"]) in taken:   # one payment cannot satisfy two terms
            skipped.append({"terms": terms["contractId"], "reason": "other terms in this block name the same token and holder, and one payment settles one terms"})
            continue
        taken.add((terms["token"], terms["holder"]))
        (account, storage), (parent_account, parent_storage) = proof_nodes(after), proof_nodes(before)
        legs.append({"terms": terms["contractId"], "accountNodes": account, "storageNodes": storage,
                     "parentAccountNodes": parent_account, "parentStorageNodes": parent_storage})
    return legs, skipped


def build_block(cfg: Config, exclude: set = frozenset()) -> dict:
    with connect(cfg.ws_url, max_size=None) as ws:
        reth = Reth(cfg, ws)
        chain = Ledger(cfg).head()
        head = "0x" + chain["headHash"]
        # reth's head, safe and finalized are Canton's head before anything is built (also after a crash).
        reth.forkchoice(head, head, head)
        try:
            return _build(cfg, reth, chain, head, set(exclude))
        except BaseException:
            reth.forkchoice(head, head, head)
            raise


def _build(cfg: Config, reth: Reth, chain: dict, head: str, exclude: set) -> dict:
    n, cap = int(chain["headNumber"]) + 1, int(chain["gasCap"])
    parent = reth.call("eth_getBlockByHash", [head, False])
    if not parent or int(parent["number"], 16) != n - 1:
        raise BuilderError("reth does not have Canton's head block")
    pending = reth.call("txpool_content", [])["pending"]
    chosen = choose_txs(pending, min(cap, int(parent["gasLimit"], 16)), exclude)
    raws = [reth.call("eth_getRawTransactionByHash", [t["hash"]]) for t in chosen]
    attributes = {"timestamp": hex(max(int(time.time()), int(parent["timestamp"], 16) + 1)), "prevRandao": ZERO32,
                  "suggestedFeeRecipient": cfg.fee_recipient, "withdrawals": [], "parentBeaconBlockRoot": ZERO32}
    built = reth.call("testing_buildBlockV1", [head, attributes, raws, None])   # always a list, never null
    payload = built["executionPayload"]
    if payload["transactions"] != raws or int(payload["gasLimit"], 16) > cap or int(payload["gasUsed"], 16) > cap:
        raise BuilderError("reth built a block other than the one asked for, or over the gas cap")
    block_hash = payload["blockHash"]
    status = reth.engine("engine_newPayloadV4", [payload, [], ZERO32, built["executionRequests"]])["status"]
    if status != "VALID":
        raise BuilderError(f"engine_newPayloadV4 answered {status}")
    reth.forkchoice(block_hash, head, head)

    raw = bytes.fromhex(reth.call("debug_getRawBlock", [payload["blockNumber"]])[2:])
    header, txs = split_block(raw)
    if "0x" + keccak256(header).hex() != block_hash:
        raise BuilderError("the block's header does not hash to its block hash")
    work = Path(cfg.work_dir) / f"block-{n}"
    work.mkdir(parents=True, exist_ok=True)
    (work / "block.json").write_text(json.dumps(reth.call("eth_getBlockByNumber", [payload["blockNumber"], True])))
    (work / "witness.json").write_text(json.dumps(reth.call("debug_executionWitness", [payload["blockNumber"]])))
    run(cfg.make_input_cmd, str(work / "block.json"), str(work / "witness.json"), cfg.genesis, str(work / "input.bin"))
    proof_file = work / "out" / "wrapped-proof.hex"
    proof_file.unlink(missing_ok=True)   # a proof left by an earlier run of this block number is never this block's
    run(cfg.prove_cmd, str(work / "input.bin"), str(work / "out"))
    if not proof_file.is_file():
        raise BuilderError("the prover finished but left no wrapped-proof.hex")
    proof = proof_file.read_text().strip()
    if len(proof) != 2688 or proof.strip("0123456789abcdef"):
        raise BuilderError("the wrapped proof is not 1,344 bytes of lowercase hex")

    legs, skipped = make_legs(cfg, reth, chain, payload["blockNumber"])

    reason = None
    try:
        Ledger(cfg).advance(chain, header.hex(), "" if txs == EMPTY_LIST else txs.hex(), proof, legs)
    except urllib.error.HTTPError as e:
        with e:
            reason = e.read().decode(errors="replace")[:600]
    except (OSError, ValueError, http.client.HTTPException) as e:   # a dropped connection, a timeout, a reply that is not HTTP or not JSON: the reply is lost
        reason = f"no usable reply from Canton: {e}"
    if reason is not None:   # a lost reply can hide a commit, so Canton's head decides
        try:
            now = Ledger(cfg).head()["headHash"]
        except (OSError, ValueError, http.client.HTTPException, BuilderError) as e:
            # Neither a commit nor a refusal is known. reth stays where it is: moving it back could undo a block Canton
            # committed. The next run starts from Canton's head, whichever it is.
            return {"committed": None, "number": n, "blockHash": block_hash,
                    "reason": f"{reason}; and Canton's head could not be read afterwards ({e}), so it is not known whether the block committed",
                    "keptTransactions": [t["hash"] for t in chosen], "skippedTerms": skipped}
        if now != block_hash[2:]:
            reth.forkchoice(head, head, head)
            return {"committed": False, "number": n, "blockHash": block_hash, "reason": reason,
                    "keptTransactions": [t["hash"] for t in chosen], "skippedTerms": skipped}
    reth.forkchoice(block_hash, block_hash, block_hash)
    return {"committed": True, "number": n, "blockHash": block_hash, "transactions": [t["hash"] for t in chosen], "legs": len(legs), "skippedTerms": skipped}


def read_disclosed(path: str) -> list:
    try:
        found = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise BuilderError(f"cannot read the disclosed contracts {path}: {e}") from e
    if not isinstance(found, list) or not all(isinstance(c, dict) for c in found):
        raise BuilderError(f"the disclosed contracts {path} must be a JSON list of objects")
    return found


class Arguments(argparse.ArgumentParser):
    def error(self, message):
        raise BuilderError(f"bad arguments: {message}")


def main() -> int:
    """Every way this can fail prints one JSON line and exits 1; a block Canton refused exits 2."""
    try:
        ap = Arguments(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
        ap.add_argument("command", choices=["once"])
        ap.add_argument("--exclude", action="append", default=[], metavar="TX_HASH", help="leave this transaction (and its sender's later ones) out")
        ap.add_argument("--read-as", action="append", default=[], metavar="PARTY", help="also read the contracts this party sees (repeatable); the builder still acts only as itself")
        ap.add_argument("--disclosed", metavar="FILE", help="a JSON list of disclosed contracts, passed with Advance as they are")
        args = ap.parse_args()
        cfg = Config.from_env()
        cfg.read_as = tuple(dict.fromkeys(args.read_as))
        if args.disclosed:
            cfg.disclosed = read_disclosed(args.disclosed)
        result = build_block(cfg, {h.lower() for h in args.exclude})
    except BuilderError as e:
        print(json.dumps({"committed": False, "error": str(e)}))
        return 1
    except Exception as e:   # an unreachable service, a reply that is not JSON or not what was expected, and the like
        print(json.dumps({"committed": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    print(json.dumps(result))
    return 0 if result["committed"] else 2


if __name__ == "__main__":
    sys.exit(main())
