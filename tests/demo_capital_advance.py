#!/usr/bin/env python3
"""Part of tests/demo_package_upgrade.sh. The builder (builder/builder.py, same arguments) with one change: the header hex of the Advance has
one capital letter in it, so that the text Daml holds and the text the runtime sends (lowercased) differ. Canton refuses such a block: the
hash in the `verify2` line is of the text as Daml holds it."""
import re, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "builder"))
import builder

advance = builder.Ledger.advance


def with_a_capital(self, chain, argument, command_id=None):
    header = argument["headerHex"]
    found = re.search("[a-f]", header)
    if not found:
        raise SystemExit("the header hex has no letter to put in capitals")
    changed = {**argument, "headerHex": header[:found.start()] + found.group().upper() + header[found.end():]}
    return advance(self, chain, changed, command_id)


builder.Ledger.advance = with_a_capital
sys.exit(builder.main())
