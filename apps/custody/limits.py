"""The custody worker's limits, published for readers (the explorer, and through it the Bridge page). Part of intake.py; see README.md.

The worker writes `custody-limits.json` in its work folder at the start of every poll round, so a reader sees what the running worker enforces and how old that is: nothing is
copied into a second setting. A part that is not switched on has no limits in the file (null): the intake has `minDeposits`, the payouts have `minPayouts`.
"""
import json, os
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path

FILE = "custody-limits.json"


def amount_text(amount: Fraction) -> str:
    """The amount as plain decimal text ("10", "0.25"), exact (a least amount is read from decimal text, so its denominator is a power of 10 or has 2 and 5 only)."""
    if amount.denominator == 1:
        return str(amount.numerator)
    with localcontext() as ctx:
        ctx.prec = 80
        text = format(Decimal(amount.numerator) / Decimal(amount.denominator), "f")
    return text.rstrip("0").rstrip(".") if "." in text else text


def least_list(minimums: dict):
    """[{instrumentAdmin, instrumentId, least}] of {(admin, id): amount}, in the order of the instruments; None when the part is off."""
    if minimums is None:
        return None
    return [{"instrumentAdmin": admin, "instrumentId": name, "least": amount_text(amount)} for (admin, name), amount in sorted(minimums.items())]


def document(now: datetime, poll_seconds: float, min_deposits=None, min_payouts=None) -> dict:
    """What the file holds. `min_deposits` and `min_payouts` are {(admin, id): amount} (empty: the part is on with no least amount), None when that part is off."""
    return {
        "version": 1,
        "updatedAt": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "pollSeconds": poll_seconds,
        "minDeposits": least_list(min_deposits),
        "minPayouts": least_list(min_payouts),
    }


def publish(work_dir: str, doc: dict) -> None:
    """Writes the file in the work folder, all or nothing (a reader never sees half of it). An OSError is the caller's to report."""
    path = Path(work_dir) / FILE
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(doc))
    os.replace(tmp, path)
