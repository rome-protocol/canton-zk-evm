"""The in-relayer (flow C): coin sent to an inbox of the Canton router on Ostia, taken on to Canton or, when Canton cannot pay, held and sent back.

In order: finish the transaction that is out; learn the open inboxes from the router's InboxOpened events and the sends to them from the source chain's bridge events (final blocks only); then send the
first of: an openInbox that the page asked for; for each inbox that holds a balance, in order of its refund clock, forward (Canton can pay, or the balance is only the fee), mark (starts the clock) or
refund (the clock has ended); and the claim of a send (claimAndWithdraw when Canton can pay it now and no older inbox waits for the same coin, claimToInbox otherwise). One transaction at a time, as the out-relayer does. The bridge service is
not trusted: its leaf must be the one the event described. Anyone may do each of these steps, so the relayer is a convenience, never a trust point.
"""
import http.server, json, re, sys, threading, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

from eth_abi import decode
from eth_utils import keccak

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "demo"))
import canton
import chain
import relay_out
from records import over_caps

CLAIM_ARGS = "(bytes32[32],bytes32[32],uint256,bytes32,bytes32,uint32,address,uint32,address,uint256,bytes)"
CLAIM_PAY = f"claimAndWithdraw({CLAIM_ARGS},string,uint32,address)"
CLAIM_HOLD = f"claimToInbox({CLAIM_ARGS},string,uint32,address)"
OPEN = "openInbox(string,uint32,address)"
SWEEP = "{}(string,uint32,address,address)"   # forward, mark, refund
INBOX_OF, REFUND_AT = "inboxOf(string,uint32,address)", "refundAt(address,address)"
UNIT_OF, IN_OPEN, CHECK_IN, ASSETS = "unitOf(uint32)", "inOpen()", "checkIn(address)", "assets(address)"
INBOX_OPENED = "0x" + keccak(text="InboxOpened(address,bytes32,address,string,uint32)").hex()
BRIDGE_EVENT = "0x" + keccak(text="BridgeEvent(uint8,uint32,address,uint32,address,uint256,bytes,uint32)").hex()
BRIDGE_TYPES = ["uint8", "uint32", "address", "uint32", "address", "uint256", "bytes", "uint32"]
PARTY, ADDRESS = re.compile(r"[A-Za-z0-9:_.\-]{1,255}"), re.compile(r"0x[0-9a-fA-F]{40}")
MARGIN, MAX_TRIES, MAX_BODY = timedelta(seconds=5), 3, 2048   # the builder's clock is not Canton's: a pause or a tally counts a few seconds longer


class Wait(Exception):
    """Not now: the reason is logged once and the step is looked at again on the next pass."""
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class InRouter:
    """The router's, the book's and the coins' answers that the in-relayer asks before it sends."""
    def __init__(self, rpc: chain.Rpc, address: str):
        self.rpc, self.address = rpc, address
        self.book = self.view(address, "book()", [], [], "address")
        self.bridge = self.view(address, "bridge()", [], [], "address")
        self.network = self.view(self.bridge, "networkID()", [], [], "uint32")

    def view(self, to, signature, types, values, out):
        return self.rpc.view(to, signature, types, values, [out])[0]

    def inbox_of(self, party, net, refund) -> str:
        return self.view(self.address, INBOX_OF, ["string", "uint32", "address"], [party, net, refund], "address").lower()

    def unit(self, net) -> int:
        return self.view(self.book, UNIT_OF, ["uint32"], [net], "uint256")

    def in_open(self) -> bool:
        return self.view(self.book, IN_OPEN, [], [], "bool")

    def fee_in(self, coin) -> "int | None":
        """The fee of a forward, or None when the book refuses flow C for this coin now (a revert; any other failure is raised)."""
        try:
            return self.view(self.book, CHECK_IN, ["address"], [coin], relay_out.ASSET)[3]
        except chain.Refused:
            return None

    def listed(self, coin) -> bool:
        return self.view(self.book, ASSETS, ["address"], [coin], relay_out.ASSET)[0] != 0

    def balance(self, coin, who) -> int:
        return self.view(coin, "balanceOf(address)", ["address"], [who], "uint256")

    def refund_at(self, inbox, coin) -> int:
        return self.view(self.address, REFUND_AT, ["address", "address"], [inbox, coin], "uint256")

    def claimed(self, count, source_network) -> bool:
        return self.view(self.bridge, "isClaimed(uint32,uint32)", ["uint32", "uint32"], [count, source_network], "bool")


class Canton:
    """What the operator sees on Canton, read only: the chain record, the parties with a standing acceptance of withdrawals, and the instrument of each wrapped coin."""
    def __init__(self, net: canton.Network):
        self.net = net

    def snapshot(self) -> SimpleNamespace:
        net, record = self.net, canton.chain_record(self.net)
        names = lambda a: all(a.get(k) == record.get(k) for k in ("operator", "confirmer", "gateway")) and int(a.get("chainId") or 0) == int(record["chainId"])   # as the builder's names_chain: another party in a role is no acceptance
        accepted = {e["createArgument"]["party"] for e in net.template("operator", "operator", canton.ACCEPTANCE) if names(e["createArgument"])}
        coins = (e["createArgument"] for e in net.template("operator", "operator", canton.CHAIN + "GatewayToken"))
        return SimpleNamespace(chain=record, accepted=accepted, instrument={"0x" + a["evmToken"].lower(): f"{a['instrumentId']['admin']}/{a['instrumentId']['id']}" for a in coins})


def canton_reason(snap, party: str, coin: str, amount: int, at: datetime) -> "str | None":
    """Why Canton cannot pay `amount` base units of the coin to the party now, or None: the same three things that leave a withdrawal out of a block (an acceptance, the pause, the quota)."""
    if party not in snap.accepted:
        return "the party has not accepted withdrawals"
    c = snap.chain
    if c.get("pausedUntil") and at < datetime.fromisoformat(c["pausedUntil"]) + MARGIN:
        return "payouts are paused"
    if c.get("withdrawalQuota") is None or c.get("quotaWindow") is None:
        return None
    name, cap = snap.instrument.get(coin.lower()), relay_out.units(c["withdrawalQuota"])
    if name is None:
        return "this asset has no instrument"
    live = [(relay_out.units(t.get("tallyAmount")), t.get("countedUntil")) for t in c.get("withdrawn") or [] if t.get("tallyToken") == name]
    if cap is None or any(a is None for a, _ in live):
        return "the withdrawal quota cannot be read"
    if sum(a for a, until in live if datetime.fromisoformat(until) + MARGIN > at) + amount > cap:
        return "the withdrawal quota is used up for now"
    return None


# ---- the page's intake -----------------------------------------------------------------------------------------------------------------------------

def intake(raw: bytes, ctx, records, now: float) -> tuple:
    """(HTTP status, answer) for a request to open an inbox: {party, refundNetwork, refundAddress}. It only queues; the pass sends. The answer's address is for the person's information:
    the page works it out itself and trusts only the InboxOpened event."""
    try:
        q = json.loads(raw)
        party, net, refund = q["party"], q["refundNetwork"], q["refundAddress"]
        ok = (isinstance(party, str) and PARTY.fullmatch(party) and type(net) is int and 0 <= net < 2**32 and isinstance(refund, str) and ADDRESS.fullmatch(refund) and int(refund, 16) != 0)
    except (ValueError, KeyError, TypeError):
        ok = False
    if not ok:
        return 400, {"error": "the request is not in the expected form"}
    refund, r = refund.lower(), ctx.router
    try:
        if net == r.network or r.unit(net) == 0:
            return 422, {"error": "a coin cannot be sent back to that network"}
        if not r.in_open():
            return 503, {"error": "sending to Canton is not available right now"}
        if party not in ctx.canton.snapshot().accepted:
            return 422, {"error": "this Canton account has not accepted withdrawals"}
        inbox = r.inbox_of(party, net, refund)
    except (chain.ChainError, canton.Fail, OSError, KeyError, ValueError):
        return 502, {"error": "this cannot be checked right now"}
    with records.lock:
        if records.get("inbox:" + inbox):
            return 200, {"inbox": inbox, "status": "open"}
        if records.get("open:" + inbox).get("state") in ("queued", "sent"):
            return 200, {"inbox": inbox, "status": "queued"}
        if sum(1 for v in list(records.data["items"].values()) if v.get("kind") == "open" and now - v["asked"] < 3600) >= ctx.cfg["open_per_hour"]:
            return 429, {"error": "too many inboxes asked for; try again later"}
        records.put("open:" + inbox, kind="open", state="queued", party=party, net=net, refund=refund, asked=now)
    return 202, {"inbox": inbox, "status": "queued"}


def serve(port: int, handle) -> http.server.ThreadingHTTPServer:
    """POST /open on this machine only (the explorer's same-origin route passes the page's request here); the body is at most 2 KiB."""
    class Handler(http.server.BaseHTTPRequestHandler):
        timeout = 10

        def do_POST(self):
            try:
                size = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(min(size, 65536))   # read (and drop) what was sent, so the answer is not lost to a reset
                status, answer = (404, {}) if self.path != "/open" else (413, {}) if size > MAX_BODY else handle(body)
            except Exception:
                status, answer = 400, {}
            out = json.dumps(answer).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


# ---- what is on the chains ------------------------------------------------------------------------------------------------------------------------

def logs(rpc: chain.Rpc, address: str, topic: str, cursor_name: str, first: int, chunk: int, records):
    """The matching events in the final blocks after the cursor, a chunk of blocks at a time; the cursor moves only when a chunk has been handled."""
    cursors, head = records.data.setdefault("cursors", {}), rpc.finalized()
    start = cursors[cursor_name] + 1 if cursor_name in cursors else first
    while start <= head:
        end = min(start + chunk - 1, head)
        yield from rpc.call("eth_getLogs", [{"address": address, "topics": [topic], "fromBlock": hex(start), "toBlock": hex(end)}])
        with records.lock:
            cursors[cursor_name] = end
            records.save()
        start = end + 1


def scan(ctx, records) -> None:
    """Open inboxes from the router's events (the address must be the one the router works out for the event's party), then the sends to them from the source bridge's events."""
    cfg, r = ctx.cfg, ctx.router
    for e in logs(ctx.rpc, r.address, INBOX_OPENED, "ostia", cfg["ostia_from"], cfg["chunk"], records):
        party, net = decode(["string", "uint32"], bytes.fromhex(e["data"][2:]))
        inbox, refund = "0x" + e["topics"][1][-40:], "0x" + e["topics"][3][-40:]
        if r.inbox_of(party, net, refund) == inbox:
            records.put("inbox:" + inbox, kind="inbox", party=party, net=net, refund=refund)
    for e in logs(ctx.source, ctx.source_bridge, BRIDGE_EVENT, "source", cfg["from_block"], cfg["chunk"], records):
        kind, origin, coin, network, dest, amount, _, count = decode(BRIDGE_TYPES, bytes.fromhex(e["data"][2:]))
        if kind == 0 and network == r.network and records.get("inbox:" + dest) and not records.get(f"leaf:{count}"):
            records.put(f"leaf:{count}", kind="leaf", state="pending", count=count, inbox=dest, coin=coin, origin=origin, amount=str(amount), tries=0)


# ---- what to send -----------------------------------------------------------------------------------------------------------------------------------

def job(name: str, signature: str, types: list, values: list, recipient: str, back: str, **extra) -> dict:
    return {"job": name, "data": chain.call_data(signature, types, values), "recipient": recipient, "back": back, "extra": extra}


def plan_open(ctx, records, key: str, item: dict) -> dict:
    inbox = key.removeprefix("open:")
    if not ctx.router.in_open():
        raise Wait("flow C is closed")
    if records.get("inbox:" + inbox):
        records.put(key, state="done")
        raise Wait("the inbox is open already")
    return job("open", OPEN, ["string", "uint32", "address"], [item["party"], item["net"], item["refund"]], inbox, "queued")


def plan_leaf(ctx, records, snap, waiting: set, key: str, item: dict, now: float) -> dict:
    r, cfg, inbox, coin, count, src = ctx.router, ctx.cfg, item["inbox"], item["coin"], item["count"], ctx.cfg["src_net"]
    where = records.get("inbox:" + inbox)
    if item["origin"] != r.network:
        records.put(key, state="skipped")
        raise Wait("the router takes only what was born on this chain")
    if not r.listed(coin):
        raise Wait("the router does not list this coin")
    if r.claimed(count, src):
        records.put(key, state="claimed")
        raise Wait("it is claimed already")
    if int(item["amount"]) < cfg["floor"]:
        raise Wait("the amount is under the floor: the user claims")
    leaf = ctx.aggkit.leaf(src, count)
    if leaf is None:
        raise Wait("the bridge service has not indexed it")
    if (leaf["leaf_type"], leaf["origin_network"], leaf["origin_address"].lower(), leaf["destination_network"], leaf["destination_address"].lower(), int(leaf["amount"])) != (0, item["origin"], coin, r.network, inbox, int(item["amount"])):
        records.put(key, state="mismatch")   # the service's leaf is not what the event described: never claimed
        raise Wait("the bridge service's leaf is not the one the event described")
    index = ctx.aggkit.number("l1-info-tree-index", {"network_id": src, "deposit_count": count})
    taken = None if index is None else ctx.aggkit.number("injected-l1-info-leaf", {"network_id": r.network, "leaf_index": index}, "l1_info_tree_index")   # Ostia has taken the root
    proof = None if taken is None else ctx.aggkit.proof(src, taken, count)
    if proof is None:
        raise Wait("it is not ready on Ostia yet")
    pay, fee = False, r.fee_in(coin)
    if fee is not None and not item.get("hold") and not any(i != inbox and c == coin for i, c in waiting):   # coin of an older inbox is waiting for Canton: it has the quota first
        total = r.balance(coin, inbox) + int(item["amount"])
        pay = canton_reason(snap(), where["party"], coin, total - min(fee, total), datetime.fromtimestamp(now, timezone.utc)) is None
    h = lambda xs: [bytes.fromhex(x[2:]) for x in xs]
    claim = (h(proof["local"]), h(proof["rollup"]), int(leaf["global_index"]), bytes.fromhex(proof["mainnet"][2:]), bytes.fromhex(proof["rollupRoot"][2:]), item["origin"], coin, r.network, inbox,
             int(item["amount"]), bytes.fromhex(leaf["metadata"][2:]))
    return job("claim", CLAIM_PAY if pay else CLAIM_HOLD, [CLAIM_ARGS, "string", "uint32", "address"], [claim, where["party"], where["net"], where["refund"]], inbox, "pending", pay=pay)


def held(ctx, records, log, now: float) -> list:
    """(refund clock or now, inbox, coin, balance) of each open inbox that holds a listed coin, oldest clock first."""
    out = []
    for key, rec in list(records.data["items"].items()):
        if not key.startswith("inbox:"):
            continue
        inbox = key.removeprefix("inbox:")
        for coin in ctx.cfg["coins"]:
            try:
                bal = ctx.router.balance(coin, inbox)
                if bal > 0:
                    out.append((ctx.router.refund_at(inbox, coin) or now, inbox, coin, bal))
            except chain.ChainError as e:
                log(f"relay-in: {inbox[:10]} cannot be read: {e}")
    return sorted(out)


def plan_sweep(ctx, records, snap, entry: tuple, now: float) -> dict:
    clock, inbox, coin, bal = entry
    r, rec = ctx.router, records.get("inbox:" + entry[1])
    cool, fee = records.get(f"cool:{inbox}:{coin}"), r.fee_in(coin)
    cooling = cool.get("until", 0) > now
    if cooling and cool.get("job") != "forward":
        raise Wait("a left-out step is cooling")
    started = r.refund_at(inbox, coin) != 0
    if fee is not None and bal <= fee:
        name = "forward"   # all of it is the fee: no Canton leg
    elif fee is not None and not cooling and canton_reason(snap(), rec["party"], coin, bal - fee, datetime.fromtimestamp(now, timezone.utc)) is None:
        name = "forward"
    elif not started:
        name = "mark"
    elif now >= clock:
        name = "refund"
    else:
        raise Wait("the refund clock is running")
    return job(name, SWEEP.format(name), ["string", "uint32", "address", "address"], [rec["party"], rec["net"], rec["refund"], coin], inbox, "skipped", pair=f"{inbox}:{coin}")


# ---- the pass ---------------------------------------------------------------------------------------------------------------------------------------

def resolve(ctx, records, log, now: float) -> bool:
    """The one transaction that is out: done in a final block, failed, waiting, or replaced (its nonce goes to a transfer of nothing). True when one was replaced: the nonce is busy this pass."""
    replaced = False
    for key, sent in records.where("sent"):
        try:
            state, _ = chain.settle(ctx.rpc, ctx.signer, sent, ctx.cfg["limits"], ctx.cfg["wait"], final=True)
        except chain.ChainError as e:
            log(f"relay-in: {e}")
            continue
        if state == "waiting":
            continue
        replaced |= state == "replaced"
        if sent["job"] == "claim":
            tries = sent["tries"] + 1   # a claim that did not land goes back in the queue, into the inbox only, up to three times
            records.put(key, state="claimed" if state == "done" else "failed" if tries >= MAX_TRIES else "pending", tries=tries, hold=bool(sent.get("hold") or sent.get("pay")))
        elif sent["job"] == "open":
            records.put(key, state="queued" if state == "replaced" else state)
        else:
            records.put(key, state=state)
            if state != "done":
                records.put(f"cool:{sent['pair']}", until=now + ctx.cfg["cooldown"], job=sent["job"])
        log(f"relay-in: {key[:14]} {sent['job']} {state}")
    return replaced


def send(ctx, records, key: str, j: dict, now: float) -> None:
    cfg = ctx.cfg
    capped = over_caps(records, j["recipient"], cfg["caps"], now)
    if capped or ctx.rpc.number("eth_getBalance", [ctx.signer.address, "latest"]) < cfg["min_balance"]:
        raise Wait(capped or "the relayer's balance is under its floor")
    note = lambda sent: records.put(key, state="sent", job=j["job"], recipient=j["recipient"], **j["extra"], **sent) if sent else records.put(key, state=j["back"], at=None, tx=None)   # refused: it never was out
    chain.send(ctx.rpc, ctx.signer, ctx.router.address, j["data"], cfg["limits"], record=note)


def run_once(ctx, records, log=print, now: float = None) -> None:
    now = time.time() if now is None else now
    if resolve(ctx, records, log, now):
        return
    scan(ctx, records)
    if records.where("sent"):
        return   # one at a time: a transaction the builder leaves out would hold the next ones
    cache = {}
    snap = lambda: cache.setdefault("s", ctx.canton.snapshot())   # Canton is read once a pass, and only when a step needs it
    coins = held(ctx, records, log, now)
    waiting = {(e[1], e[2]) for e in coins}
    plans = [(k, k, lambda k=k, v=v: plan_open(ctx, records, k, v)) for k, v in sorted(records.where("queued"), key=lambda kv: kv[1]["asked"])]
    plans += [(f"{e[1][:10]}:{e[2][-4:]}", None, lambda e=e: plan_sweep(ctx, records, snap, e, now)) for e in coins]   # held coin first (oldest clock first), then the new sends
    plans += [(k, k, lambda k=k, v=v: plan_leaf(ctx, records, snap, waiting, k, v, now)) for k, v in sorted(records.where("pending"), key=lambda kv: kv[1]["count"])]
    seen = records.data.setdefault("why", {})
    for label, key, plan in plans:
        try:
            j = plan()
            send(ctx, records, key or f"act:{j['job']}:{int(now * 1000)}:{j['recipient'][-6:]}", j, now)
        except Exception as e:   # one step, whatever is wrong with it, never stops the ones after it
            if records.where("sent"):   # the send may have gone out (a timeout): its record finds it again
                log(f"relay-in: {label} sent, the node's answer is unknown ({type(e).__name__})")
                return
            why = e.reason if isinstance(e, Wait) else str(e) if isinstance(e, chain.ChainError) else f"unexpected ({type(e).__name__})"
            if seen.get(label) != why:
                with records.lock:
                    seen[label] = why
                log(f"relay-in: {label} waits: {why}")
            continue
        log(f"relay-in: {label} sent")
        return
