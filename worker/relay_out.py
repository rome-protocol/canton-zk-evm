"""The out-relayer (flow A): Canton deposits that name the Canton router as recipient, sent on to another chain through the router's claimAndBridge.

It reads the open DepositRequests of the router from the ledger (as the operator), and for each one: checks the label in the strict r1 form, has the router rebuild the label and the deposit id
(so the relayer keeps no copy of the format that an upgrade could outdate), checks the allocation, the book and the fee the way the router will (the fee that is finally charged must not pass
the label's most fee), and then sends one claimAndBridge, one transaction at a time. A request that fails a check is left alone: it lapses on Canton and the depositor keeps the coin.
"""
import re, sys, time
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

from eth_abi import decode
from eth_utils import keccak

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "demo"))
import canton
import chain
from records import over_caps

CLAIM = "claimAndBridge(string,address,uint256,uint32,address,uint256,uint64)"
CLAIM_TYPES = ["string", "address", "uint256", "uint32", "address", "uint256", "uint64"]
ROUTED_OUT = "0x" + keccak(text="RoutedOut(bytes32,bytes32,address,string,uint32,address,uint256,uint256,uint256)").hex()
ASSET = "(uint8,bytes32,uint256,uint256,uint256,uint256,uint256)"   # state, instrument, feeOut, feeIn, feeRefund, minAmount, lockCap
AMOUNT = re.compile(r"(\d+)(?:\.(\d{1,10}))?")


class Skip(Exception):
    def __init__(self, reason: str, permanent: bool = False):
        super().__init__(reason)
        self.reason, self.permanent = reason, permanent


class Router:
    """The router's own answers (and the book's and the gateway's, which it names): what the relayer asks before it sends."""
    def __init__(self, rpc: chain.Rpc, address: str):
        self.rpc, self.address = rpc, address
        self.book = rpc.view(address, "book()", [], [], ["address"])[0]
        self.gateway = rpc.view(address, "gateway()", [], [], ["address"])[0]

    def label(self, network: int, dest: str, max_fee: int, nonce: int) -> str:
        return self.rpc.view(self.address, "routeLabel(uint32,address,uint256,uint64)", ["uint32", "address", "uint256", "uint64"], [network, dest, max_fee, nonce], ["string"])[0]

    def deposit_id(self, party: str, label: str) -> str:
        return self.rpc.view(self.address, "depositId(string,string)", ["string", "string"], [party, label], ["bytes32"])[0].hex()

    def plan(self, token: str, network: int) -> tuple:
        """(feeOut, minAmount, unit, claim part) for a route that is open now; the book reverts (a ChainError) for one that is not."""
        asset, unit, claim = self.rpc.view(self.book, "checkOut(address,uint32)", ["address", "uint32"], [token, network], [ASSET, "uint256", "uint256"])
        return asset[2], asset[5], unit, claim

    def room(self, token: str) -> int:
        return self.rpc.view(self.address, "lockRoom(address)", ["address"], [token], ["uint256"])[0]

    def used(self, deposit_id: str) -> bool:
        return self.rpc.view(self.gateway, "used(bytes32)", ["bytes32"], [bytes.fromhex(deposit_id)], ["bool"])[0]


class Ledger:
    """What the operator sees on Canton: the chain, the router's open requests, the active allocations, and the wrapped token of each instrument."""
    def __init__(self, net: canton.Network):
        self.net = net

    def snapshot(self, router: str) -> SimpleNamespace:
        net, wanted = self.net, router.lower().removeprefix("0x")
        requests = [{**e["createArgument"], "contractId": e["contractId"]} for e in net.template("operator", "operator", canton.DEPOSIT_REQUEST) if e["createArgument"].get("recipient") == wanted]
        flt = {"InterfaceFilter": {"value": {"interfaceId": canton.ALLOCATION_INTERFACE, "includeInterfaceView": True, "includeCreatedEventBlob": False}}}
        allocations = {e["contractId"]: v["viewValue"]["allocation"] for e in net.active("operator", "operator", flt) for v in e.get("interfaceViews") or []
                       if v.get("viewStatus", {}).get("code", 0) == 0 and v.get("viewValue")}
        wrapped = {(a["instrumentId"]["admin"], a["instrumentId"]["id"]): "0x" + a["evmToken"] for a in (e["createArgument"] for e in net.template("operator", "operator", canton.CHAIN + "GatewayToken"))}
        return SimpleNamespace(chain=canton.chain_record(net), requests=requests, allocations=allocations, wrapped=wrapped)


def units(text) -> "int | None":
    found = AMOUNT.fullmatch(text) if isinstance(text, str) else None
    return int(found[1]) * 10**10 + int((found[2] or "").ljust(10, "0")) if found else None


def decide(r: dict, snap: SimpleNamespace, router: Router, margin: int, now: float) -> list:
    """The arguments of claimAndBridge for this request, or a Skip that says why not."""
    c = snap.chain
    if any(r.get(k) != c[k] for k in ("operator", "confirmer", "gateway", "builder", "chainId")):
        raise Skip("the request names another chain", True)
    parts = canton.route_parts(r.get("label"))
    if not parts or int(parts[1], 16) == 0:
        raise Skip("the label is not in the exact r1 form, or its destination is zero", True)
    network, dest, max_fee, nonce = parts
    try:
        if router.label(network, dest, max_fee, nonce) != r["label"] or router.deposit_id(r["depositor"], r["label"]) != r["depositId"]:
            raise Skip("the router does not rebuild this label and id", True)
    except chain.ChainError as e:
        raise Skip(str(e)) from None
    spec = snap.allocations.get(r["allocation"])
    if not spec:
        raise Skip("its allocation is not active, or not visible to the operator")
    leg, settle = spec["transferLeg"], spec["settlement"]
    if (leg["sender"], leg["receiver"], settle["executor"]) != (r["depositor"], c["gateway"], c["operator"]):
        raise Skip("its allocation is not from the depositor to the gateway with the operator as executor", True)
    if datetime.fromisoformat(settle["settleBefore"]).timestamp() - now < margin:
        raise Skip("its allocation ends too soon to be settled")
    coin = snap.wrapped.get((leg["instrumentId"]["admin"], leg["instrumentId"]["id"]))
    amount = units(leg["amount"])
    if not coin or not amount:
        raise Skip("its instrument has no wrapped token, or its amount is not an amount", True)
    try:
        fee_out, minimum, unit, claim = router.plan(coin, network)
        room, used = router.room(coin), router.used(r["depositId"])
    except chain.ChainError as e:
        raise Skip(f"the router refuses this route or cannot be read ({e})") from None
    if used:
        raise Skip("the gateway has used this id", True)
    send = max(amount - fee_out - claim, 0) // unit * unit
    fee = amount - send
    if amount < minimum or send == 0:
        raise Skip("the amount is below the minimum or leaves nothing after the fee")
    if fee > max_fee:
        raise Skip(f"the fee {fee} is above the label's most fee {max_fee}")   # the final fee: what is cut to the unit is part of it
    if send > room:
        raise Skip("the lock cap leaves no room for it")
    return [r["depositor"], coin, amount, network, dest, max_fee, nonce]


def resolve(rpc: chain.Rpc, signer, records, cfg: dict, log) -> None:
    """The one transaction that is out: done in a final block, failed, still waiting, or replaced (the nonce goes to a transfer of nothing, and the request is let go)."""
    for key, sent in records.where("sent"):
        try:
            state, receipt = chain.settle(rpc, signer, sent, cfg["limits"], cfg["wait"], final=True)
        except chain.ChainError as e:
            log(f"relay-out: {e}")
            continue
        if state == "waiting":
            continue
        count = None
        for entry in (receipt or {}).get("logs", []):
            if entry["topics"][0] == ROUTED_OUT and entry["address"].lower() == sent["router"]:
                count = decode(["string", "uint32", "address", "uint256", "uint256", "uint256"], bytes.fromhex(entry["data"][2:]))[-1]
        records.put(key, state=state, depositCount=count, block=int(receipt["blockNumber"], 16) if receipt else None)
        log(f"relay-out: {key[:12]} {state}")


def run_once(ledger: Ledger, router: Router, rpc: chain.Rpc, signer, records, cfg: dict, log=print, now: float = None) -> None:
    now = time.time() if now is None else now
    resolve(rpc, signer, records, cfg, log)
    if records.where("sent"):
        return   # one at a time: a transaction the builder leaves out would hold the next ones
    snap = ledger.snapshot(router.address)
    for r in sorted(snap.requests, key=lambda r: r["depositId"]):
        key, seen = r["depositId"], records.get(r["depositId"])
        if seen.get("state") in ("done", "failed", "replaced") or seen.get("permanent"):
            continue
        try:
            args = decide(r, snap, router, cfg["margin"], now)
            capped = over_caps(records, args[4], cfg["caps"], now)
            if capped:
                raise Skip(capped)
            if rpc.number("eth_getBalance", [signer.address, "latest"]) < cfg["min_balance"]:
                raise Skip("the relayer's balance is under its floor")
            note = lambda sent, key=key, args=args: records.put(key, state="sent", recipient=args[4], router=router.address.lower(), amount=str(args[2]), **sent) if sent else records.put(key, state="skipped", at=None, tx=None)
            chain.send(rpc, signer, router.address, chain.call_data(CLAIM, CLAIM_TYPES, args), cfg["limits"], record=note)
        except Exception as e:   # one request, whatever is wrong with it, never stops the ones after it
            if records.get(key).get("state") == "sent":   # the send may have gone out (a timeout): its record finds it again
                log(f"relay-out: {key[:12]} sent, the node's answer is unknown ({type(e).__name__})")
                return
            known = isinstance(e, (Skip, chain.ChainError))
            reason, permanent = (getattr(e, "reason", str(e)), getattr(e, "permanent", False)) if known else (f"unexpected ({type(e).__name__})", False)
            if seen.get("reason") != reason:
                log(f"relay-out: {key[:12]} left alone: {reason}")
            records.put(key, state="skipped", reason=reason, permanent=permanent)
            continue
        log(f"relay-out: {key[:12]} sent")
        return
