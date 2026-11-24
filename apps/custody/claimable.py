"""Whether a transfer to the gateway can be claimed as it stands, read live from Ostia. Used by intake.py; see README.md.

A route memo (r1:...) is claimed by the router's `claimAndBridge`, so the checks here are that function's own, on the book's and the router's current answers: the fee (the asset's
`feeOut` plus the claim fee of the network), the minimum, what is left after the fee cut down to the destination's unit, the memo's most fee and the lock room. Every number is read
from the book and the router at the time; none is kept here. A plain memo deposit has no fee in the 0.6.0 deposit path: it only has to leave something to claim.
"""
import json, sys, urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "builder"))
from keccak import keccak256
import builder as b

CHECK_OUT = keccak256(b"checkOut(address,uint32)")[:4]   # book: (Asset, unit, claimPart), reverts when the direction, the route or the destination is not open
LOCK_ROOM = keccak256(b"lockRoom(address)")[:4]          # router: what the lock cap still has room for
ASSET_WORDS = 7                                          # state, instrument, feeOut, feeIn, feeRefund, minAmount, lockCap: all static, so the answer is 9 words
FEE_OUT, MIN_AMOUNT = 2, 5


class Refused(Exception):
    """The transfer cannot be claimed as it stands: the intake rejects it, and this text is the reason its sender is given."""


class Reverted(Exception):
    """Ostia answered that the call reverts (not that it could not be answered)."""


def shown(units: int) -> str:
    """A base-unit amount as the Canton decimal that a wallet shows (no trailing zeros)."""
    whole, frac = divmod(units, b.UNIT)
    digits = f"{frac:010d}".rstrip("0")
    return f"{whole}.{digits}" if digits else str(whole)


def eth_call(url: str):
    """A function (to, data) -> the answer's bytes: `eth_call` at the latest block on Ostia. A revert is Reverted; anything else that goes wrong is a RuntimeError that does not name the URL."""
    def call(to: str, data: bytes) -> bytes:
        try:
            answer = b.post_json(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": to, "data": "0x" + data.hex()}, "latest"]}, {"user-agent": "Rome Protocol rome@romeprotocol.com"}, timeout=30)
            error = answer.get("error") if isinstance(answer, dict) else None
            if error is not None:
                if isinstance(error, dict) and (error.get("code") == 3 or "revert" in str(error.get("message")).lower()):
                    raise Reverted()
                raise ValueError("error")
            return bytes.fromhex(answer["result"][2:])
        except Reverted:
            raise
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
            if isinstance(e, urllib.error.HTTPError):
                e.close()
            raise RuntimeError("the router's book cannot be read on Ostia") from None
    return call


class Route:
    """What the book and the router say now of one asset and one destination, in base units."""
    def __init__(self, fee_out: int, minimum: int, unit: int, claim: int, room: int):
        self.fee_out, self.minimum, self.unit, self.claim, self.room = fee_out, minimum, unit, claim, room


class Ostia:
    """The book and the router on Ostia, read through `call`."""
    def __init__(self, call, book: str, router: str):
        self.call, self.book, self.router = call, "0x" + book, "0x" + router   # the addresses as 40 hex digits

    @staticmethod
    def words(answer: bytes, count: int) -> list:
        if len(answer) != 32 * count:
            raise RuntimeError("the router's book gave an answer that is not the one expected")
        return [int.from_bytes(answer[i:i + 32], "big") for i in range(0, len(answer), 32)]

    def route(self, token: str, network: int) -> Route:
        """The live route of `token` (an address, 40 hex digits) to `network`. A Refused when the book says it is not open; a RuntimeError when it cannot be read."""
        argument = bytes.fromhex(token).rjust(32, b"\0") + network.to_bytes(32, "big")
        try:
            got = self.words(self.call(self.book, CHECK_OUT + argument), ASSET_WORDS + 2)
        except Reverted:
            raise Refused("the route is not open now") from None
        try:
            room = self.words(self.call(self.router, LOCK_ROOM + bytes.fromhex(token).rjust(32, b"\0")), 1)[0]
        except Reverted:
            raise RuntimeError("the router's lock room cannot be read on Ostia") from None
        unit = got[ASSET_WORDS]
        if unit == 0:
            raise RuntimeError("the router's book gave a destination with no unit")
        return Route(got[FEE_OUT], got[MIN_AMOUNT], unit, got[ASSET_WORDS + 1], room)


def check_route(ostia: Ostia, token: str, network: int, amount: int, max_fee: int) -> None:
    """Nothing when `claimAndBridge` would take this amount now; a Refused that says why not. The router's checks, in its order, on the live numbers."""
    r = ostia.route(token, network)
    fee0 = r.fee_out + r.claim
    if fee0 > max_fee:
        raise Refused(f"the route's fee is now {shown(fee0)} and the memo allows {shown(max_fee)}")
    least = max(r.minimum, fee0 + r.unit)   # at the minimum, with at least one unit left after the fee
    if amount < least:
        raise Refused(f"the least amount for this route is now {shown(least)}")
    send = (amount - fee0) // r.unit * r.unit
    if amount - send > max_fee:   # the cut-off leftover is part of the fee
        raise Refused(f"the fee for this amount is {shown(amount - send)} and the memo allows {shown(max_fee)}")
    if send > r.room:
        raise Refused("the route has no room for this amount now")


def check_plain(amount: int) -> None:
    """A plain memo deposit has no fee or minimum of the gateway's: it must leave something to claim (`Gateway.claim` refuses zero)."""
    if amount <= 0:
        raise Refused("there is nothing to claim")
