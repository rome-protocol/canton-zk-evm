"""The memo of a transfer to the gateway: what its sender wrote, read as the deposit's label and recipient. Nothing here asks a server or the ledger."""
import re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "builder"))
from keccak import keccak256

REASON_KEY = "splice.lfdecentralizedtrust.org/reason"   # the memo that wallets write
LABEL_KEY = "romeprotocol.com/ostia-label"
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
DECIMAL = r"(?:0|[1-9][0-9]*)"   # as the router writes a number: no leading zeros
ROUTE = re.compile(rf"r1:({DECIMAL}):0x([0-9a-f]{{40}}):({DECIMAL}):({DECIMAL})")   # r1:<network>:<address>:<most fee>:<nonce>
ROUTE_BITS = (32, 256, 64)   # the bits of the network, the most fee and the nonce, as the router's Labels.parse takes them
MAX_LABEL = 200   # characters of an outside party's label that are kept


class Unreadable(Exception):
    """The memo is missing or is not one the intake takes: the transfer stays as it is."""


def checksummed(digits: str) -> str:
    """The 40 hex digits with the EIP-55 capitals."""
    lower = digits.lower()
    hashed = keccak256(lower.encode()).hex()
    return "".join(c.upper() if int(hashed[i], 16) >= 8 else c for i, c in enumerate(lower))


def address_of(text: str) -> str:
    """The 40 lowercase hex digits of an EVM address as the memo writes it: all lowercase or all uppercase as written, mixed case only if the EIP-55 checksum holds."""
    if not ADDRESS.fullmatch(text):
        raise Unreadable("the memo is not one EVM address (0x and 40 hex digits)")
    digits = text[2:]
    if digits != digits.lower() and digits != digits.upper() and digits != checksummed(digits):
        raise Unreadable("the memo's address has capitals that are not its EIP-55 checksum")
    return digits.lower()


def route_parts(label: str):
    """(network, most fee) of a route text that `read` returned as a label, or None when the label is not a route text."""
    found = ROUTE.fullmatch(label)
    return (int(found.group(1)), int(found.group(3))) if found else None


def read(meta: dict, instruction: str, router: str = None) -> tuple:
    """(label, recipient) of a transfer's meta: the memo, which holds one EVM address, or, when `router` (an address) is given, one route text r1:... for it.
    The label is the memo's own label if it has one, else the instruction's contract id; a route text is its own label. The recipient is 40 lowercase hex digits."""
    memo = meta.get(REASON_KEY)
    if not isinstance(memo, str) or not memo.strip():
        raise Unreadable("the transfer has no memo")
    memo = memo.strip()
    if memo.startswith("r1:"):
        found = ROUTE.fullmatch(memo)
        if not router:
            raise Unreadable("the memo is a route and no router is set")
        if not found or not int(found.group(2), 16) or any(int(found.group(n)) >> bits for n, bits in zip((1, 3, 4), ROUTE_BITS)):
            raise Unreadable("the memo is not a route: r1:<network>:<0x address>:<most fee>:<nonce>, the network under 2^32, the fee under 2^256 and the nonce under 2^64")
        return memo, address_of(router)
    recipient = address_of(memo)
    label = meta.get(LABEL_KEY, instruction)
    if not isinstance(label, str) or not 0 < len(label) <= MAX_LABEL:
        raise Unreadable(f"the label is empty or longer than {MAX_LABEL} characters")
    return label, recipient
