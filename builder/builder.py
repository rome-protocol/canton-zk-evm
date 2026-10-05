#!/usr/bin/env python3
"""The builder: makes one block, gets it proven and submits it to Canton. See README.md.

  builder.py once [--exclude <tx hash>]... [--read-as <party>]... [--disclosed <file>]

It builds a block, reads the Canton legs the block's transactions asked the gateway contract for, finds each leg's Canton
side, and builds the block again without any transaction whose leg has none. Only then does it prove the block and
submit it, with exactly the legs the block recorded.

Exit status: 0 if Canton committed the block, 2 if Canton refused it (reth is moved back to Canton's head) or if it is
not known whether it committed ("committed": null; reth is left where it is), 1 on any other failure (reth is moved
back too, where it had moved). One JSON line on stdout says which, whatever the failure.
"""
import argparse, base64, functools, hashlib, hmac, http.client, json, os, re, subprocess, sys, time, urllib.error, urllib.request, uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from websockets.sync.client import connect

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
        self.imported: list = []   # the raw transactions of the block the builder last made reth's head

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


def put_back(reth: Reth) -> None:
    """reth does not return an unwound block's transactions to its pool, so the builder sends them again. Errors are ignored: a
    transaction the pool already has, or one whose nonce is used, is not a problem."""
    raws, reth.imported = reth.imported, []
    for raw in raws:
        try:
            reth.call("eth_sendRawTransaction", [raw])
        except BuilderError:
            pass


def without(pairs: list, exclude: set) -> list:
    """The last build's (transaction, raw bytes), less the excluded ones and each such sender's later ones."""
    stopped, kept = set(), []
    for t, raw in pairs:
        if t["from"] in stopped or t["hash"] in exclude:
            stopped.add(t["from"])
            continue
        kept.append((t, raw))
    return kept


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

    def advance(self, chain: dict, argument: dict) -> None:
        command = {"ExerciseCommand": {"templateId": CHAIN, "contractId": chain["contractId"], "choice": "Advance", "choiceArgument": argument}}
        body = {"commands": [command], "commandId": str(uuid.uuid4()), "userId": self.cfg.ledger_user,
                "actAs": [self.cfg.party], "readAs": self.readers()}
        if self.cfg.disclosed:
            body["disclosedContracts"] = self.cfg.disclosed
        post_json(self.cfg.ledger_url + "/v2/commands/submit-and-wait", body, self.auth)


# ---- the legs a block records ----------------------------------------------------------------------------------

def run(cmd: str, *args: str) -> None:
    done = subprocess.run([*cmd.split(), *args], capture_output=True, text=True)
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
            try:
                put_back(reth)
            except Exception:   # the error that brought us here is the one to report
                pass
            raise


def build_and_import(cfg: Config, reth: Reth, chain: dict, head: str, exclude: set, previous: list | None = None) -> tuple:
    """Builds a block on Canton's head and makes it reth's head. The transactions come from reth's pending pool the first time, and
    afterwards from the last build's list (`previous`) less the excluded ones: reth no longer has them in its pool once a block that
    held them was its head. (payload, the (transaction, raw bytes) pairs in the block)."""
    n, cap = int(chain["headNumber"]) + 1, int(chain["gasCap"])
    parent = reth.call("eth_getBlockByHash", [head, False])
    if not parent or int(parent["number"], 16) != n - 1:
        raise BuilderError("reth does not have Canton's head block")
    if previous is None:
        pending = reth.call("txpool_content", [])["pending"]
        chosen = choose_txs(pending, min(cap, int(parent["gasLimit"], 16)), exclude)
        pairs = [(t, reth.call("eth_getRawTransactionByHash", [t["hash"]])) for t in chosen]
    else:
        pairs = without(previous, exclude)
    raws = [raw for _, raw in pairs]
    reth.imported = raws
    attributes = {"timestamp": hex(max(int(time.time()), int(parent["timestamp"], 16) + 1)), "prevRandao": ZERO32,
                  "suggestedFeeRecipient": cfg.fee_recipient, "withdrawals": [], "parentBeaconBlockRoot": ZERO32}
    built = reth.call("testing_buildBlockV1", [head, attributes, raws, None])   # always a list, never null
    payload = built["executionPayload"]
    if payload["transactions"] != raws or int(payload["gasLimit"], 16) > cap or int(payload["gasUsed"], 16) > cap:
        raise BuilderError("reth built a block other than the one asked for, or over the gas cap")
    status = reth.engine("engine_newPayloadV4", [payload, [], ZERO32, built["executionRequests"]])["status"]
    if status != "VALID":
        raise BuilderError(f"engine_newPayloadV4 answered {status}")
    reth.forkchoice(payload["blockHash"], head, head)
    return payload, pairs


def _build(cfg: Config, reth: Reth, chain: dict, head: str, exclude: set) -> dict:
    n = int(chain["headNumber"]) + 1
    if not re.fullmatch(r"[0-9a-f]{40}", str(chain.get("gatewayAddress"))):
        raise BuilderError("the chain record's gateway address is not 40 lowercase hex digits")
    left_out, pairs = [], None   # the transactions left out because a leg of theirs had no Canton side, each with the reason; the last build's transactions
    while True:
        # Build the block and see which legs it records. A transaction whose leg has no Canton side is not allowed in: reth goes back to
        # Canton's head and the block is built again without it (and without its sender's later transactions). Nothing is proven until
        # every leg of the block has its Canton side, and a block with no transaction left out is the one that goes on.
        payload, pairs = build_and_import(cfg, reth, chain, head, exclude, pairs)
        chosen = [t for t, _ in pairs]
        events = read_legs(reth, chain, payload["blockHash"])
        legs, missing = match_legs(Canton(Ledger(cfg), chain, utcnow()), events) if events else ([], [])
        if not missing:
            break
        for event, reason in missing:
            if event.tx not in exclude:
                exclude.add(event.tx)
                left_out.append({"transaction": event.tx, "reason": f"its {KINDS[event.kind]} leg has no Canton side: {reason}"})
        reth.forkchoice(head, head, head)
        put_back(reth)   # the left-out transactions wait in the pool again; the next build is made from the list in hand
    block_hash = payload["blockHash"]
    leg_txs = list(dict.fromkeys(e.tx for e in events))

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

    account_nodes, storage_nodes = gateway_proofs(reth, chain, payload["blockNumber"])
    argument = {"headerHex": header.hex(), "txsHex": "" if txs == EMPTY_LIST else txs.hex(), "proofHex": proof,
                "gatewayAccountNodes": account_nodes, "gatewayStorageNodes": storage_nodes, "legs": legs}
    (work / "advance.json").write_text(json.dumps(argument))   # kept: the argument of the Advance, as it was sent
    report = {"number": n, "blockHash": block_hash, "legTransactions": leg_txs, "leftOut": left_out}

    reason = None
    try:
        Ledger(cfg).advance(chain, argument)
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
            return {"committed": None, **report,
                    "reason": f"{reason}; and Canton's head could not be read afterwards ({e}), so it is not known whether the block committed",
                    "keptTransactions": [t["hash"] for t in chosen]}
        if now != block_hash[2:]:
            reth.forkchoice(head, head, head)
            put_back(reth)
            return {"committed": False, **report, "reason": reason, "keptTransactions": [t["hash"] for t in chosen]}
    reth.imported = []   # Canton committed them: never send them to the pool again
    reth.forkchoice(block_hash, block_hash, block_hash)
    return {"committed": True, **report, "transactions": [t["hash"] for t in chosen], "legs": len(legs)}


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
