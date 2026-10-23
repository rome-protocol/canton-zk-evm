#!/usr/bin/env python3
"""Makes reth's head, safe and finalized block Canton's head, the way the builder does before it builds, and prints what it found.
Used by network/restart.sh after a restart, when reth may be behind Canton, ahead of it, or on the same block.

First, the builder's in-doubt record (unresolved.json in its work folder): when the builder was stopped with an Advance that had no answer, that
command may still commit, so Canton's head says nothing yet. It is settled the builder's own way (builder.recover_saved: its completion, or Canton's
head once Canton's own time is past its window; this waits for it), and only then is reth compared with Canton's head. The work folder's lock is held for the whole
run, so a running producer is refused with a message.

  ahead of Canton   reth's blocks after Canton's head were never committed on Canton (and no in-doubt command is left that could commit one):
                    reth is moved back to Canton's head
                    (reth runs with --engine.allow-unwind-canonical-header for this). reth does not return an unwound block's transactions
                    to its pool, so they are read first and sent again afterwards, the way the builder does (errors are ignored: a
                    transaction whose nonce is used already is not a problem). Nobody's transaction is lost to a planned restart.
  on Canton's head  nothing moves
  behind Canton     Canton committed a block that reth does not have, so reth cannot continue this chain: this stops with an error

Prints key=value lines: in_doubt_command, in_doubt_committed, in_doubt_resolved (only when a record was settled), canton_head, canton_hash, reth_latest_before, reth_finalized_before, reth_latest, reth_finalized, moved, dropped_transactions, resent_transactions.
Exits 0 only if reth's latest and finalized block are Canton's head. Reads the same environment as the builder (CZE_STATE_DIR, CZE_LEDGER_USER,
CZE_BUILDER_PARTY, CZE_FEE_RECIPIENT, RETH_HTTP_PORT, ...)."""
import contextlib, json, sys, time, urllib.request
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
    # The transactions of the blocks above Canton's head, read before the move (afterwards reth no longer has them).
    raws = []
    for n in range(canton_number + 1, (before_latest["number"] or 0) + 1):
        for tx_hash in (call("eth_getBlockByNumber", [hex(n), False]) or {}).get("transactions", []):
            raw = call("eth_getRawTransactionByHash", [tx_hash])
            if raw:
                raws.append(raw)
    forkchoice(canton_hash, canton_hash, canton_hash)
    resent = 0
    for raw in raws:
        try:
            call("eth_sendRawTransaction", [raw])
            resent += 1
        except SyncError:
            pass
    after_latest, after_final = block("latest"), block("finalized")
    for name, b in (("latest", after_latest), ("finalized", after_final)):
        if b["hash"] != canton_hash:
            raise SyncError(f"after the update reth's {name} block is {b['number']} ({b['hash']}), not Canton's head {canton_number} ({canton_hash})")
    moved = (before_latest["hash"], before_final["hash"]) != (canton_hash, canton_hash)
    return {"canton_head": canton_number, "canton_hash": canton_hash, "reth_latest_before": before_latest["number"],
            "reth_finalized_before": before_final["number"], "reth_latest": after_latest["number"], "reth_finalized": after_final["number"],
            "moved": "yes" if moved else "no", "dropped_transactions": len(raws), "resent_transactions": resent}


def sync(cfg, builder, call, forkchoice, wait=time.sleep) -> dict:
    """Settles the builder's in-doubt command if there is a record, then reconciles reth with Canton's head, all under the work folder's lock."""
    with contextlib.ExitStack() as stack:
        try:
            stack.enter_context(builder.work_lock(cfg.work_dir))
        except builder.BuilderError as e:
            raise SyncError(f"the builder is running, or another sync_reth: stop it first, reth must not be moved under it ({e})") from e
        settled = None
        if builder.unresolved_path(cfg).exists():
            settled = (builder.recover_saved(cfg, wait=wait) or {}).get("settled")
        chain = builder.Ledger(cfg).head()
        result = reconcile(int(chain["headNumber"]), "0x" + chain["headHash"], call, forkchoice)
    if settled:
        result = {"in_doubt_command": settled["commandId"], "in_doubt_committed": "yes" if settled["committed"] else "no",
                  "in_doubt_resolved": settled["resolved"], **result}
    return result


def main() -> int:
    import os
    import builder
    try:
        cfg = builder.Config.from_env()
        url = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', 8545)}"

        def call(method, params):
            request = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                             {"content-type": "application/json"})
            try:
                with urllib.request.urlopen(request, timeout=60) as r:
                    reply = json.load(r)
            except OSError as e:
                raise SyncError(f"{method}: reth does not answer: {e}")
            if "error" in reply:
                raise SyncError(f"{method} failed: {reply['error']}")
            return reply["result"]

        result = sync(cfg, builder, call, builder.Reth(cfg, None).forkchoice)
    except (SyncError, builder.BuilderError) as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return 1
    for k, v in result.items():
        print(f"{k}={v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
