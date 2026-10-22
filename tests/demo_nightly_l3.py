#!/usr/bin/env python3
"""L3 of the explorer's design (section 9), the nightly flood on the rehearsal chain: the real reth, Canton, builder and the explorer's indexer, with the
stand-in proof. It floods the producer with blocks of plain transfers (1,428 fit under the 30 Mgas cap), cut one after another as the builder takes them,
and measures, for each block, from the moment the builder has committed it:
  served   the first time the explorer's API answers for the block (B1's index lag, polled every 60 ms: the REST routes allow 20 requests a second to a client)
  final    the first time the API says the block is final
  sse      how long after `served` a live-stream client receives the block's `block` event (B4)
and, over the whole flood, the growth of the explorer's database per million transactions (B6).
Held to B1 (p95 <= 1.0 s), B4 (p95 <= 0.5 s) and B6 (<= 2.5 GB per million transactions). Without a GPU there is no proving, so time to final here is the
chain's without a proof: it is reported, not held to a budget.

  demo_nightly_l3.py run <seconds> <transactions per block> <results.json>

Reads: EXPLORER (the explorer's URL), L3_PY (the Python of the demo's virtualenv), L3_DB (the explorer's database container), and the demo's own variables,
which the rehearsal exports with the function `cut_block` (bash -c cut_block cuts a block through the real builder). Exits 1 when a budget is broken.
"""
import json
import math
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

B1_S = 1.0
B4_S = 0.5
B6_BYTES = 2.5e9
MIN_TXS_FOR_B6 = 5_000
POLL_S = 0.06
GIVE_UP_S = 180


def percentile(values, p):
    """Nearest rank; None for no values."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]


def growth_per_million(size_before, size_after, txs_before, txs_after):
    if txs_after <= txs_before:
        return None
    return (size_after - size_before) / (txs_after - txs_before) * 1_000_000


def judge(blocks, growth, txs_added):
    """The summary of a flood and the budgets it broke."""
    failures = []
    if not blocks:
        return {"blocks": 0}, ["no block was cut"]
    never = [b["number"] for b in blocks if b["served_s"] is None]
    if never:
        failures.append(f"blocks {never} were never served")
    served = [b["served_s"] for b in blocks if b["served_s"] is not None]
    final = [b["final_s"] for b in blocks if b["final_s"] is not None]
    sse = [b["sse_after_served_s"] for b in blocks if b["sse_after_served_s"] is not None]
    summary = {
        "blocks": len(blocks), "transactions": sum(b["txs"] for b in blocks), "largest_block_txs": max(b["txs"] for b in blocks),
        "served_p50_s": percentile(served, 50), "served_p95_s": percentile(served, 95), "served_max_s": max(served, default=None),
        "final_p50_s": percentile(final, 50), "final_p95_s": percentile(final, 95), "final_max_s": max(final, default=None),
        "sse_p50_s": percentile(sse, 50), "sse_p95_s": percentile(sse, 95), "sse_received": len(sse),
        "growth_bytes_per_million": growth, "transactions_added_to_the_database": txs_added,
        "budgets": {"B1_p95_s": B1_S, "B4_p95_s": B4_S, "B6_bytes_per_million": B6_BYTES},
    }
    p95 = summary["served_p95_s"]
    if p95 is not None and p95 > B1_S:
        failures.append(f"B1: index lag p95 {p95:.3f} s is over {B1_S} s")
    if not sse:
        failures.append("B4: no live-stream client received any block")
    elif summary["sse_p95_s"] > B4_S:
        failures.append(f"B4: stream delivery p95 {summary['sse_p95_s']:.3f} s is over {B4_S} s")
    if txs_added < MIN_TXS_FOR_B6 or growth is None:
        failures.append(f"B6: too few transactions ({txs_added}) added to the database to judge its growth (needs {MIN_TXS_FOR_B6})")
    elif growth > B6_BYTES:
        failures.append(f"B6: {growth / 1e9:.2f} GB per million transactions is over {B6_BYTES / 1e9} GB")
    return summary, failures


def get(url, timeout=10):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"user-agent": "Rome Protocol rome@romeprotocol.com"}), timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, None
    except (urllib.error.URLError, OSError, ValueError):
        return 0, None


def rpc(method, params):
    url = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', 8545)}"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, {"content-type": "application/json"}), timeout=60) as r:
        return json.load(r)["result"]


def sql(query):
    out = subprocess.run(["docker", "exec", os.environ["L3_DB"], "psql", "-U", "explorer", "-d", "explorer", "-tAc", query], check=True, capture_output=True, text=True)
    return int(out.stdout.strip())


def database():
    """The database's size, and the transactions in it."""
    return sql("select pg_database_size(current_database())"), sql("select count(*) from transactions")


class Stream(threading.Thread):
    """One live-stream client: when each block's `block` event arrived, by block number."""
    def __init__(self, base):
        super().__init__(daemon=True)
        self.base, self.arrived, self.stop = base, {}, False

    def run(self):
        while not self.stop:
            try:
                with urllib.request.urlopen(urllib.request.Request(f"{self.base}/api/stream?topics=blocks", headers={"accept": "text/event-stream"}), timeout=30) as r:
                    pending = ""
                    while not self.stop:
                        line = r.readline()
                        if not line:
                            break
                        pending += line.decode()
                        while "\n\n" in pending:
                            frame, pending = pending.split("\n\n", 1)
                            lines = frame.split("\n")
                            if "event: block" in lines:
                                ids = [x[4:] for x in lines if x.startswith("id: ")]
                                if ids and ids[0].isdigit():
                                    self.arrived.setdefault(int(ids[0]), time.monotonic())
            except (urllib.error.URLError, OSError):
                time.sleep(0.5)


def run(seconds, per_block, results):
    base, py, root = os.environ["EXPLORER"], os.environ["L3_PY"], Path(__file__).resolve().parent
    stream = Stream(base)
    stream.start()
    size0, txs0 = database()
    cut = []          # (number, committed at, transactions)
    seen = {}         # number -> {"served": t, "final": t}
    done = threading.Event()

    def watch():
        while True:
            active = [(n, t0) for n, t0, _ in list(cut) if "final" not in seen.setdefault(n, {}) and time.monotonic() - t0 < GIVE_UP_S]
            if not active and done.is_set():
                return
            for number, _ in active:
                status, body = get(f"{base}/api/block/{number}")
                now = time.monotonic()
                if status == 200 and body:
                    seen[number].setdefault("served", now)
                    if body.get("status") == "final":
                        seen[number]["final"] = now
                time.sleep(POLL_S)
            if not active:
                time.sleep(POLL_S)

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        subprocess.run([py, str(root / "demo_w1.py"), "plain", str(per_block)], check=True, capture_output=True)
        subprocess.run(["bash", "-c", "cut_block"], check=True)
        t0 = time.monotonic()
        number = int(rpc("eth_blockNumber", []), 16)
        count = len(rpc("eth_getBlockByNumber", [hex(number), False])["transactions"])
        cut.append((number, t0, count))
        print(f"block {number}: {count} transactions committed", flush=True)
    done.set()
    watcher.join(timeout=GIVE_UP_S + 30)
    stream.stop = True
    size1, txs1 = database()
    blocks = []
    for number, t0, count in cut:
        mark, got = seen.get(number, {}), stream.arrived.get(number)
        served = mark.get("served")
        blocks.append({"number": number, "txs": count, "served_s": None if served is None else served - t0,
                       "final_s": None if "final" not in mark else mark["final"] - t0,
                       "sse_after_served_s": None if served is None or got is None else max(0.0, got - served)})
    summary, failures = judge(blocks, growth_per_million(size0, size1, txs0, txs1), txs1 - txs0)
    summary.update(seconds=seconds, transactions_per_block_sent=per_block, database_bytes_before=size0, database_bytes_after=size1, failures=failures, per_block=blocks)
    Path(results).write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "per_block"}, indent=1))
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "run":
        sys.exit(run(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]))
    print(__doc__, file=sys.stderr)
    sys.exit(2)
