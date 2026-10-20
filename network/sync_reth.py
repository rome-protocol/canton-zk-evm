#!/usr/bin/env python3
"""Makes reth's head, safe and finalized block Canton's head, the way the builder does before it builds, and prints what it found.
Used by network/restart.sh after a restart, when reth may be behind Canton, ahead of it, or on the same block.

  ahead of Canton   reth's blocks after Canton's head were never committed on Canton: reth is moved back to Canton's head
                    (reth runs with --engine.allow-unwind-canonical-header for this)
  on Canton's head  nothing moves
  behind Canton     Canton committed a block that reth does not have, so reth cannot continue this chain: this stops with an error

Prints key=value lines: canton_head, canton_hash, reth_latest_before, reth_finalized_before, reth_latest, reth_finalized, moved.
Exits 0 only if reth's latest and finalized block are Canton's head. Reads the same environment as the builder (CZE_STATE_DIR, CZE_LEDGER_USER,
CZE_BUILDER_PARTY, CZE_FEE_RECIPIENT, RETH_HTTP_PORT, ...)."""
import json, sys, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "builder"))


class SyncError(Exception):
    pass


def reconcile(canton_number: int, canton_hash: str, call, forkchoice) -> dict:
    """call(method, params) is reth's HTTP JSON-RPC; forkchoice(head, safe, finalized) is the Engine API update (raises if reth says it is not VALID)."""
    def block(tag):
        b = call("eth_getBlockByNumber", [tag, False])
        return {"number": int(b["number"], 16), "hash": b["hash"]} if b else {"number": None, "hash": None}
    before_latest, before_final = block("latest"), block("finalized")
    wanted = call("eth_getBlockByHash", [canton_hash, False])
    if not wanted:
        raise SyncError(f"Canton is at block {canton_number} ({canton_hash}), which reth does not have (reth's latest block is "
                        f"{before_latest['number']}): reth is behind Canton and cannot continue this chain from this data")
    if int(wanted["number"], 16) != canton_number:
        raise SyncError(f"reth has block {canton_hash} as number {int(wanted['number'], 16)}, Canton says {canton_number}")
    forkchoice(canton_hash, canton_hash, canton_hash)
    after_latest, after_final = block("latest"), block("finalized")
    for name, b in (("latest", after_latest), ("finalized", after_final)):
        if b["hash"] != canton_hash:
            raise SyncError(f"after the update reth's {name} block is {b['number']} ({b['hash']}), not Canton's head {canton_number} ({canton_hash})")
    moved = (before_latest["hash"], before_final["hash"]) != (canton_hash, canton_hash)
    return {"canton_head": canton_number, "canton_hash": canton_hash, "reth_latest_before": before_latest["number"],
            "reth_finalized_before": before_final["number"], "reth_latest": after_latest["number"], "reth_finalized": after_final["number"],
            "moved": "yes" if moved else "no"}


def main() -> int:
    import os
    import builder
    try:
        cfg = builder.Config.from_env()
        chain = builder.Ledger(cfg).head()
        url = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', 8545)}"

        def call(method, params):
            request = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                             {"content-type": "application/json"})
            with urllib.request.urlopen(request, timeout=60) as r:
                reply = json.load(r)
            if "error" in reply:
                raise SyncError(f"{method} failed: {reply['error']}")
            return reply["result"]

        result = reconcile(int(chain["headNumber"]), "0x" + chain["headHash"], call, builder.Reth(cfg, None).forkchoice)
    except (SyncError, builder.BuilderError) as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1
    for k, v in result.items():
        print(f"{k}={v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
