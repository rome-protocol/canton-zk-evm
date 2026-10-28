#!/usr/bin/env python3
"""The OTC swap of the demo: a seller on Canton and a buyer on the EVM trade through a venue. See demo/README.md ("The OTC swap") and apps/otc/README.md.

  otc.py upload-dar                     load the OTC app's package (apps/otc/dist/otc-venue.dar, from apps/otc/build.sh) into the users participant
  otc.py ids <label>                    the payment id of the venue's trade with that label, and the id of the claim it makes
  otc.py offer <label> <tkb> <token> <tka> [<buyer>]
                                        the seller (U) offers <tkb> TKB (up to 10 decimals) for <tka> TKA (a whole number) of the ERC-20 token at
                                        <token>, to be paid to the seller's EVM address. <buyer> is the EVM address that gets the wrapped TKB:
                                        the buyer's own (the key V of demo/evm.py) if none is given
  otc.py accept <label>                 the venue (the Canton party V) accepts the offer: the trade is made, and with it the request that the
                                        seller allocate the TKB (the token standard's AllocationRequest)
  otc.py allocate <label>               the seller allocates the TKB through the token's own factory, with the trade's own spec: the settlement
                                        the trade names (the venue is its executor), one leg from the seller to the gateway
  otc.py publish <label> [<wrapped token>]
                                        the venue's driver makes the chain package's VenueTrade, which lets the chain settle the
                                        trade against the buyer's payment. The seller's allocation goes with it as a disclosed contract (JSON
                                        Ledger API v2 form), for a builder started with --venue for the venue's party. The wrapped token is the
                                        one registered for TKB (canton.py register-token); name it only if there are several
  otc.py close <label>                  the venue ends a trade it will not settle: it archives the venue's trade, the seller takes back his allocation
                                        (the trade's own), and the trade is closed. Each step is done only if it is there, so it also works after the
                                        request was rejected or withdrawn (which alone does not stop a published trade)
  otc.py pay <label> [<tka> [<seconds>]]
                                        the buyer approves the gateway and pays the seller through it, naming the trade: his payment is his
                                        acceptance. <tka> is a whole number, the trade's amount if none: a smaller one is the refused case (the
                                        builder leaves it out and nothing moves on Canton, but the short payment stays pending in reth's pool and holds back every later
                                        transaction of the buyer's key until it is replaced: `evm.py replace v`, same nonce). With <seconds>, waits until the payment's block is finalized
  otc.py claim <label> [<seconds>]      the buyer claims the wrapped TKB that the settled trade left for him (the gateway's claim). It needs
                                        the funded claim, so send it after the trade's block is finalized: it goes in a later block. With
                                        <seconds>, waits until its block is finalized
  otc.py check <label>                  what is there now: the offer, the trade, the allocation, the venue's trade, the funded claim, the TKB
                                        of the seller and of the gateway, the TKA of both, and the buyer's wrapped TKB (at the finalized block)

Seller, venue and buyer here: the seller is the Canton party U (with the EVM key u, which is paid), the venue is the Canton party V, and the
buyer is the EVM key v (V of demo/evm.py), who holds TKA and has no Canton party. All Canton commands go through demo/canton.py's network, so
its settings apply (CZE_STATE_DIR, the Ledger API URLs, CZE_CANTON=external with its token files); the EVM ones through demo/evm.py.
Run `canton.py setup` and register the wrapped token (`canton.py register-token`) first. Every command prints one JSON object.
"""
import hashlib, json, re, sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import canton, evm

ROOT = canton.ROOT
OTC = "#otc-venue:Otc.Otc:"
OFFER, TRADE = OTC + "TradeOffer", OTC + "Trade"
VENUE_TRADE, FUNDED_CLAIM, GATEWAY_TOKEN = canton.CHAIN + "VenueTrade", canton.CHAIN + "FundedClaim", canton.CHAIN + "GatewayToken"
SELLER, VENUE, BUYER = "u", "v", "v"   # the Canton parties of the seller and the venue; the EVM key of the buyer
DECIMAL, TIME = re.compile(r"-?[0-9]+\.[0-9]+"), re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z")
DAR = ROOT / "apps" / "otc" / "dist" / "otc-venue.dar"
LEG = "leg"   # the id of the trade's one transfer leg (apps/otc/src/Otc/Otc.daml, legId)
ALLOCATE_WITHIN, SETTLE_WITHIN = timedelta(hours=1), timedelta(hours=2)
COMMAND_ROLES = {"upload-dar": ("admin",), "ids": (), "offer": ("demo",), "accept": ("demo",), "allocate": ("demo",), "close": ("demo",)}
DEFAULT_ROLES = ("demo", "operator")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def pay_id(venue: str, label: str) -> str:
    """Daml's `venueTradeId venue label`: the SHA-256 of "venue-trade,<venue party id>,<label>"."""
    return sha256_hex(f"venue-trade,{venue},{label}")


def claim_id(payment: str) -> str:
    """Daml's `venueClaimId payId`: the SHA-256 of "claim,<payId>"."""
    return sha256_hex("claim," + payment)


def micros(delta: timedelta) -> dict:
    return {"microseconds": str(int(delta.total_seconds() * 1_000_000))}


def decimal(text: str) -> str:
    return text if "." in text else text + ".0"


def buyer_address() -> str:
    return evm.make_keys(evm.state_dir())[BUYER]


def with_label(events: list, label: str) -> list:
    return [e for e in events if e["createArgument"]["label"] == label]


def one(found: list, what: str) -> dict:
    if len(found) != 1:
        raise canton.Fail(f"expected one {what}, found {len(found)}")
    return found[0]


def trade_of(net: canton.Network, label: str) -> dict:
    return one(with_label(net.template("users", VENUE, TRADE), label), f"trade {label!r} (accept the offer first)")


def venue_trade_of(net: canton.Network, label: str) -> dict:
    """The chain package's trade for this label as the operator sees it: the one the chain settles against."""
    payment = pay_id(net.party(VENUE), label)
    return one([e for e in net.template("operator", "operator", VENUE_TRADE) if e["createArgument"]["payId"] == payment], f"venue trade {label!r} (publish it first)")


def allocations_of(net: canton.Network, who: str, label: str, blob: bool = False) -> list:
    return [e for e in net.template("users", who, canton.ALLOCATION_OF_TOKEN, blob=blob) if e["createArgument"]["allocation"]["settlement"]["settlementRef"]["id"] == label]


def gateway_token(net: canton.Network, instrument: dict, wrapped: str = None) -> dict:
    """The GatewayToken registered for this instrument (and, if named, at this EVM address), as the operator sees it."""
    found = [e for e in net.template("operator", "operator", GATEWAY_TOKEN)
             if e["createArgument"]["instrumentId"] == instrument and (wrapped is None or e["createArgument"]["evmToken"] == canton.evm_address(wrapped))]
    if len(found) > 1:
        raise canton.Fail("several wrapped tokens are registered for this instrument: name the one to use")
    return one(found, "wrapped token registered for the instrument (canton.py register-token)")


def upload_dar(net: canton.Network) -> dict:
    if not DAR.exists():
        raise canton.Fail(f"no {DAR}: run apps/otc/build.sh first")
    net.post("users", canton.UPLOAD_PATH, DAR.read_bytes(), "admin", "application/octet-stream")
    return {"uploaded": DAR.name, "to": "users"}


def ids(net: canton.Network, label: str) -> dict:
    payment = pay_id(net.party(VENUE), canton.read_label(label))
    return {"label": label, "payId": payment, "claimId": claim_id(payment)}


def offer(net: canton.Network, label: str, amount: str, token: str, tokens: str, buyer: str = None) -> dict:
    canton.read_label(label)
    if not canton.CANTON_AMOUNT.fullmatch(amount) or float(amount) == 0:
        raise SystemExit(f"the amount must be more than zero, with at most 10 decimals: {amount!r}")
    if not canton.WHOLE.fullmatch(tokens) or int(tokens) == 0:
        raise SystemExit(f"the TKA amount must be a whole number, more than zero: {tokens!r}")
    token = canton.evm_address(token)
    keys = evm.make_keys(evm.state_dir())
    payee, recipient = canton.evm_address(keys[SELLER]), canton.evm_address(buyer or keys[BUYER])
    if any(with_label(net.template("users", VENUE, t), label) for t in (OFFER, TRADE)):
        raise canton.Fail(f"an offer or a trade with the label {label!r} is there already")
    chain, registry = canton.chain_record(net), net.party("registry")
    net.submit("users", [SELLER], {"CreateCommand": {"templateId": OFFER, "createArguments": {
        "seller": net.party(SELLER), "venue": net.party(VENUE), "gateway": chain["gateway"], "instrument": {"admin": registry, "id": canton.INSTRUMENT},
        "amount": decimal(amount), "token": token, "amountBase": f"{int(tokens) * evm.ONE:064x}", "payee": payee, "recipient": recipient, "label": label,
        "allocateWithin": micros(ALLOCATE_WITHIN), "settleWithin": micros(SETTLE_WITHIN)}}})
    made = one(net.wait_for("the offer", lambda: with_label(net.template("users", VENUE, OFFER), label)), "offer")
    return {"label": label, "offer": made["contractId"], "token": "0x" + token, "tka": int(tokens), "tkb": decimal(amount), "payee": "0x" + payee, "recipient": "0x" + recipient}


def accept(net: canton.Network, label: str) -> dict:
    made = one(with_label(net.template("users", VENUE, OFFER), label), f"offer {label!r}")
    net.submit("users", [VENUE], {"ExerciseCommand": {"templateId": OFFER, "contractId": made["contractId"], "choice": "Accept", "choiceArgument": {}}})
    trade = one(net.wait_for("the trade", lambda: with_label(net.template("users", VENUE, TRADE), label)), "trade")
    return {"label": label, "trade": trade["contractId"]}


def trade_spec(trade: dict) -> dict:
    """The allocation the trade asks for: its settlement (the venue is the executor, the label the reference) and its one leg, seller to gateway, for
    the trade's amount. The seller makes exactly this, and the driver takes no other allocation for the trade."""
    meta = canton.NO_EXTRA_ARGS["meta"]
    return {"settlement": {"executor": trade["venue"], "settlementRef": {"id": trade["label"], "cid": None}, "requestedAt": trade["requestedAt"],
                           "allocateBefore": trade["allocateBefore"], "settleBefore": trade["settleBefore"], "meta": meta},
            "transferLegId": LEG,
            "transferLeg": {"sender": trade["seller"], "receiver": trade["gateway"], "amount": trade["amount"], "instrumentId": trade["instrument"], "meta": meta}}


def canonical(value):
    """A ledger value compared by what it says: a decimal by its number, a time by its instant (the ledger may write either with other digits)."""
    if isinstance(value, dict):
        return {k: canonical(v) for k, v in value.items() if v is not None}   # the ledger may leave out an optional field that is None
    if isinstance(value, list):
        return [canonical(v) for v in value]
    if isinstance(value, str):
        if DECIMAL.fullmatch(value):
            return Decimal(value)
        if TIME.fullmatch(value):
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value


def differences(got, want, path: str = "") -> list:
    """Where two canonical values differ, as the paths of the fields."""
    if isinstance(got, dict) and isinstance(want, dict):
        return [d for k in sorted(set(got) | set(want)) for d in differences(got.get(k), want.get(k), f"{path}/{k}")]
    return [] if got == want else [f"{path}: {got!r} is not {want!r}"]


def is_the_trades(event: dict, trade: dict) -> bool:
    return canonical(event["createArgument"]["allocation"]) == canonical(trade_spec(trade))


def allocate(net: canton.Network, label: str) -> dict:
    """The seller allocates through the token's factory with the trade's spec (trade_spec). canton.py's allocate makes the call: the token registry's
    rules contract goes with it as a disclosed contract."""
    trade = trade_of(net, label)["createArgument"]
    mine = [e for e in allocations_of(net, SELLER, label) if is_the_trades(e, trade)]
    if mine:   # a repeated run: the allocation stands, and no second one is made
        return {"label": label, "allocation": one(mine, "allocation")["contractId"]}
    made = canton.allocate(net, label, None, None, spec=trade_spec(trade), who=SELLER)
    return {"label": label, "allocation": made["contractId"]}


def disclosed_form(event: dict) -> dict:
    """A created event as a disclosed contract, in the JSON Ledger API v2 form."""
    if not event.get("createdEventBlob"):
        raise canton.Fail("the participant gave no created event blob for the allocation")
    return {"templateId": event["templateId"], "contractId": event["contractId"], "createdEventBlob": event["createdEventBlob"], "synchronizerId": event["synchronizerId"]}


def publish(net: canton.Network, label: str, wrapped: str = None) -> dict:
    """The venue's driver: once the seller allocated, make the chain package's VenueTrade. Its signatories are the venue and the seller, so the driver
    submits as both: the seller's party is hosted where the venue's driver can act as it. The allocation goes with it as a disclosed contract, from
    the venue's view of it or else the seller's, and only if it is the trade's own."""
    trade = trade_of(net, label)["createArgument"]
    payment, claim = pay_id(net.party(VENUE), label), claim_id(pay_id(net.party(VENUE), label))
    if [e for e in net.template("operator", "operator", VENUE_TRADE) if e["createArgument"]["payId"] == payment]:
        raise canton.Fail(f"the trade {label!r} is published already")
    if canonical(trade["settleBefore"]) <= datetime.now(timezone.utc):
        raise canton.Fail(f"the trade {label!r} is past its settle-before time {trade['settleBefore']}: close it")
    # The chain ties the Canton side to nothing but the allocation's own amount, so this is the check that the buyer gets what the trade says: only
    # an allocation that is the trade's own (its settlement and its leg, trade_spec) is taken, whoever made it and with whatever label it shares.
    found = [e for e in allocations_of(net, VENUE, label, blob=True) + allocations_of(net, SELLER, label, blob=True) if is_the_trades(e, trade)]
    found = list({e["contractId"]: e for e in found}.values())
    if not found:
        others = [e for who in (VENUE, SELLER) for e in allocations_of(net, who, label)]
        why = "; ".join(differences(canonical(others[0]["createArgument"]["allocation"]), canonical(trade_spec(trade)))) if others else "none"
        raise canton.Fail(f"no allocation of {label!r} is the trade's own, with its executor, leg and amount (the seller allocates first); the first one differs at: {why}")
    allocation = one(found, f"allocation of {label!r} that is the trade's own")
    token = gateway_token(net, trade["instrument"], wrapped)
    chain = canton.chain_record(net)
    net.submit("users", [VENUE, SELLER], {"CreateCommand": {"templateId": VENUE_TRADE, "createArguments": {
        "venue": trade["venue"], "sender": trade["seller"], "operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"],
        "chainId": chain["chainId"], "label": label, "payId": payment, "token": trade["token"], "payee": trade["payee"], "amount": trade["amountBase"],
        "allocation": allocation["contractId"], "allocationDisclosed": json.dumps(disclosed_form(allocation)), "gatewayToken": token["contractId"],
        "claimId": claim, "recipient": trade["recipient"]}}})
    made = net.wait_for("the venue's trade", lambda: [e for e in net.template("operator", "operator", VENUE_TRADE) if e["createArgument"]["payId"] == payment])
    return {"label": label, "venueTrade": made[0]["contractId"], "payId": payment, "claimId": claim, "wrappedToken": "0x" + token["createArgument"]["evmToken"]}


def close(net: canton.Network, label: str) -> dict:
    """The venue ends a trade it will not settle (called off, past its time, or settled): it archives the chain package's VenueTrade (as the venue and
    the seller, its signatories), has the seller take back his allocation, and closes the Trade. Each is done only if it is there, so it can be run again,
    and it also works when the Trade is gone already (the seller rejected the request, or the venue withdrew it): the VenueTrade is found by the payment
    id and names the allocation. Only the trade's own allocation is taken back (publish's test), not another settlement's with the same reference id.
    Turning down the request does not stop a published trade: the VenueTrade and the allocation stay, and a full payment still settles, until this
    is run. A builder started with --venue cannot see a withdrawn allocation, so a VenueTrade left active would keep getting Advances Canton refuses."""
    found = with_label(net.template("users", VENUE, TRADE), label)
    trade = one(found, f"trade {label!r}") if found else None
    payment = pay_id(net.party(VENUE), label)
    made = [e for e in net.template("users", VENUE, VENUE_TRADE) if e["createArgument"]["payId"] == payment]
    if not trade and not made:
        raise canton.Fail(f"nothing of the trade {label!r} is left to close")
    named = {e["createArgument"]["allocation"] for e in made}
    mine = [e for e in allocations_of(net, SELLER, label) if e["contractId"] in named or (trade and is_the_trades(e, trade["createArgument"]))]
    done = []
    for e in made:
        net.submit("users", [VENUE, SELLER], {"ExerciseCommand": {"templateId": VENUE_TRADE, "contractId": e["contractId"], "choice": "Archive", "choiceArgument": {}}})
        done.append("venueTrade")
    for held in mine:
        net.submit("users", [SELLER], {"ExerciseCommand": {"templateId": canton.ALLOCATION_INTERFACE, "contractId": held["contractId"], "choice": "Allocation_Withdraw",
                                                          "choiceArgument": {"extraArgs": canton.NO_EXTRA_ARGS}}})
        done.append("allocation")
    if trade:
        net.submit("users", [VENUE], {"ExerciseCommand": {"templateId": TRADE, "contractId": trade["contractId"], "choice": "Close", "choiceArgument": {}}})
        net.wait_for("the trade to be gone", lambda: not with_label(net.template("users", VENUE, TRADE), label) or None)
    return {"label": label, "closed": (["trade"] if trade else []) + done}


def finalized(tx: str, seconds: str) -> dict:
    return evm.main(["wait", tx, seconds])


def pay(net: canton.Network, label: str, tokens: str = None, seconds: str = None) -> dict:
    """The buyer approves the gateway for the amount, then pays the seller through it against the trade's payment id."""
    made = venue_trade_of(net, label)["createArgument"]
    full = int(made["amount"], 16) // evm.ONE
    count = tokens or str(full)   # none (or "", to give the seconds only): the trade's amount
    if not canton.WHOLE.fullmatch(count) or int(count) == 0:
        raise SystemExit(f"the TKA amount must be a whole number, more than zero: {count!r}")
    claim_of = claim_id(made["payId"])
    if evm.main(["used", claim_of]).get("used") is not False:   # the gateway takes an id once: a claim that someone else has made with this id leaves the buyer with nothing to claim; an answer that is not a plain "no" is a failed check
        raise SystemExit(f"the gateway has already taken the claim id of {label!r} ({claim_of}), or the check did not answer: do not pay")
    approve = evm.main(["approve", BUYER, "0x" + made["token"], "gateway", count])
    paid = evm.main(["pay", BUYER, made["payId"], "0x" + made["token"], "0x" + made["payee"], count])
    out = {"label": label, "tka": int(count), "tradeTka": full, "approve": approve["tx"], "pay": paid["tx"]}
    if seconds is not None:
        out["receipt"] = finalized(paid["tx"], seconds)
    return out


def claim(net: canton.Network, label: str, seconds: str = None) -> dict:
    """The buyer claims the wrapped TKB with the claim's id, once the trade has made the funded claim (Canton has committed the trade's block)."""
    payment = pay_id(net.party(VENUE), label)
    claim_of = claim_id(payment)
    funded = one([e for e in net.template("operator", "operator", FUNDED_CLAIM) if e["createArgument"]["claimId"] == claim_of],
                 f"funded claim of {label!r} (the trade is not settled: wait for its block to be finalized)")
    arguments = funded["createArgument"]
    token = one([e for e in net.template("operator", "operator", GATEWAY_TOKEN) if e["contractId"] == arguments["gatewayToken"]], "wrapped token of the claim")
    sent = evm.main(["claim", BUYER, claim_of, "0x" + token["createArgument"]["evmToken"], arguments["amount"]])
    out = {"label": label, "claimId": claim_of, "amount": arguments["amount"], "claim": sent["tx"]}
    if seconds is not None:
        out["receipt"] = finalized(sent["tx"], seconds)
    return out


def check(net: canton.Network, label: str) -> dict:
    """The state of the trade on both sides. The EVM balances are those of the finalized block, the one Canton has committed."""
    trade = trade_of(net, label)["createArgument"]
    payment = pay_id(net.party(VENUE), label)
    claim_of = claim_id(payment)
    token = "0x" + trade["token"]
    wrapped = "0x" + gateway_token(net, trade["instrument"])["createArgument"]["evmToken"]
    buyer = buyer_address()
    seller = "0x" + trade["payee"]
    bought = evm.main(["wrapped", wrapped, buyer, "finalized"])
    return {"label": label,
            "offer": bool(with_label(net.template("users", VENUE, OFFER), label)),
            "trade": True,
            "allocation": bool([e for e in allocations_of(net, SELLER, label) if is_the_trades(e, trade)]),
            "venueTrade": bool([e for e in net.template("operator", "operator", VENUE_TRADE) if e["createArgument"]["payId"] == payment]),
            "fundedClaim": bool([e for e in net.template("operator", "operator", FUNDED_CLAIM) if e["createArgument"]["claimId"] == claim_of]),
            "tkb": {"seller": canton.holdings(net, SELLER), "gateway": canton.holdings(net, "gateway", "operator")},
            "tka": {"seller": evm.main(["balance", token, seller, "finalized"])["tka"], "buyer": evm.main(["balance", token, buyer, "finalized"])["tka"]},
            "wrapped": {"token": wrapped, "buyer": bought["balance"], "supply": bought["supply"]}}


def main(argv: list) -> dict:
    net = canton.Network()
    n, cmd = len(argv), argv[:1]
    if net.external:
        net.check_roles(COMMAND_ROLES.get(argv[0], DEFAULT_ROLES) if argv else ())
    if argv == ["upload-dar"]:
        return upload_dar(net)
    if cmd == ["ids"] and n == 2:
        return ids(net, argv[1])
    if cmd == ["offer"] and n in (5, 6):
        return offer(net, *argv[1:])
    if cmd == ["accept"] and n == 2:
        return accept(net, argv[1])
    if cmd == ["allocate"] and n == 2:
        return allocate(net, argv[1])
    if cmd == ["publish"] and n in (2, 3):
        return publish(net, *argv[1:])
    if cmd == ["close"] and n == 2:
        return close(net, argv[1])
    if cmd == ["pay"] and n in (2, 3, 4):
        return pay(net, *argv[1:])
    if cmd == ["claim"] and n in (2, 3):
        return claim(net, *argv[1:])
    if cmd == ["check"] and n == 2:
        return check(net, argv[1])
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except canton.Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
