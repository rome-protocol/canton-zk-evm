#!/usr/bin/env python3
"""L3 of the explorer's design (section 9), the nightly flood on the rehearsal chain: the real reth, Canton, builder and the explorer's indexer, with the
stand-in proof. It floods the producer with blocks of plain transfers (1,428 fit under the 30 Mgas cap), cut one after another as the builder takes them,
and measures, for each block, from the moment the update can be read on the reader's participant (the ledger end, polled every 20 ms, reaches the offset the
update has on that participant, which the indexer stored (canton_updates.reader_offset; offsets are local to a participant, so the builder's own is no use); the clock starts at the last poll that could not read it, so a lag is an upper bound, at most one poll too long):
  served   the first time the explorer's API answers for the block from its database (status final, with the Canton record): B1's index lag, polled every 60 ms
           (the REST routes allow 20 requests a second to a client). An answer from reth alone ("unindexed", "proving") does not count: reth has the block the
           moment the builder commits, so it would say nothing of the indexer.
  final    the first time the API says the block is final
  sse      how long after `served` a live-stream client receives the block's `block` event (B4); every block must reach the client
and, over the whole flood, the growth of the explorer's database per million transactions (B6).
Held to B1 (p95 <= 1.0 s), B4 (p95 <= 0.5 s) and B6 (<= 2.5 GB per million transactions). Without a GPU there is no proving, so time to final here is the
chain's without a proof: it is reported, not held to a budget.

  demo_nightly_l3.py run <seconds> <transactions per block> <results.json>

Reads: EXPLORER (the explorer's URL), L3_PY (the Python of the demo's virtualenv), L3_DB (the explorer's database container), and the demo's own variables,
which the rehearsal exports with the function `cut_block` (bash -c cut_block cuts a block through the real builder; with CUT_BLOCK_JSON=1 it prints the commit's offset),
and L3_LEDGER (the reader's participant, http://127.0.0.1:7577). The next batch of transfers is sent while the builder cuts the block before it. Exits 1 when a budget is broken.
"""
import json
import math
import os
import subprocess
import sys
import threading
import bisect
import http.client
import queue
import re
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
HASH_LISTS = re.compile(r'\[(?:\s*"0x[0-9a-fA-F]+"\s*,?)*\s*\]')   # a list of transaction hashes, which the builder report holds by the thousand
LEDGER_POLL_S = 0.02


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
    clockless = [b["number"] for b in blocks if b.get("t0_from") == "fallback"]
    if clockless:
        failures.append(f"B1: the clock of blocks {clockless} could not start from the reader's ledger end (the offset was not read), so their lag is not measured")
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
    unreceived = [b["number"] for b in blocks if b["served_s"] is not None and b["sse_after_served_s"] is None]
    if not sse:
        failures.append("B4: no live-stream client received any block")
    elif unreceived:
        failures.append(f"B4: the live-stream client received {len(sse)} of {len(sse) + len(unreceived)} blocks; missing {unreceived}")
    if sse and summary["sse_p95_s"] > B4_S:
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
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        return 0, None


def rpc(method, params):
    url = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', 8545)}"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, {"content-type": "application/json"}), timeout=60) as r:
        return json.load(r)["result"]


def sql_rows(query):
    out = subprocess.run(["docker", "exec", os.environ["L3_DB"], "psql", "-U", "explorer", "-d", "explorer", "-tAF", " ", "-c", query], check=True, capture_output=True, text=True)
    return [line.split(" ") for line in out.stdout.strip().splitlines()]


def sql(query):
    return int(sql_rows(query)[0][0])


def reader_offsets(update_ids):
    """Where each update is on the reader's participant, as the indexer stored it (canton_updates.reader_offset): update id -> offset."""
    ids = [u for u in update_ids if u]
    if not ids or not all(u.isalnum() for u in ids):   # an update id is hex; anything else does not go into a query
        return {}
    return {row[0]: int(row[1]) for row in sql_rows("select update_id, reader_offset from canton_updates where update_id in (" + ",".join(f"'{u}'" for u in ids) + ")")}


def database():
    """The database's size, and the transactions in it."""
    return sql("select pg_database_size(current_database())"), sql("select count(*) from transactions")


def table_sizes():
    """The explorer's tables with their indexes, by name: where the growth is."""
    return {row[0]: int(row[1]) for row in sql_rows("select c.relname, pg_total_relation_size(c.oid) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'r' and n.nspname = 'public'")}


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


class LedgerClock(threading.Thread):
    """The reader's participant's ledger end, polled every 20 ms (section 9's t0: the update can be read there). Every poll is kept, as (sent at, offset read)."""
    def __init__(self, base):
        super().__init__(daemon=True)
        self.base, self.stop, self.sent, self.offsets, self.misses, self.last_miss = base, False, [], [], 0, None

    def run(self):
        while not self.stop:
            sent = time.monotonic()
            try:
                # The participant is on this machine, not an outside service, and its HTTP server logs a warning for every request whose User-Agent holds an address.
                with urllib.request.urlopen(f"{self.base}/v2/state/ledger-end", timeout=5) as r:
                    offset = json.load(r).get("offset")
            except Exception as e:  # the clock must outlive any one bad answer: a dead clock is a block that cannot be timed
                offset, self.last_miss = None, f"{type(e).__name__}: {str(e)[:200]}"
            if type(offset) is int:
                self.sent.append(sent)
                self.offsets.append(offset)
            else:
                self.misses += 1
            time.sleep(LEDGER_POLL_S)

    def reached(self, offset):
        """When the update at `offset` became readable, as an upper bound: the moment the last poll that could not read it was sent. The true time is between that and
        the answer of the first poll that could, so the lag measured from here is at most this much, and the error is a poll's length (20 ms and the round trip).
        None when no poll read it (or the offset is not known); the first poll's own time when that poll could already read it."""
        if type(offset) is not int:
            return None
        i = bisect.bisect_left(self.offsets, offset)   # the ledger end only grows, so the polls are in order
        return self.sent[max(0, i - 1)] if i < len(self.offsets) else None


def committed(output):
    """The `updateId` of the commit that `cut_block` printed (the last JSON line of its output); None when it says none."""
    for line in reversed(output.strip().splitlines()):
        try:
            answer = json.loads(line)
        except ValueError:
            continue
        if isinstance(answer, dict):
            return answer.get("updateId") if isinstance(answer.get("updateId"), str) and answer.get("updateId") else None
    return None


def from_database(body):
    """Whether an answer of /api/block/<n> comes from the explorer's database: the final block with its Canton record. Reth alone answers "unindexed" or "proving"."""
    return isinstance(body, dict) and body.get("status") == "final" and body.get("canton") is not None


class Sender(threading.Thread):
    """Sends batches of transfers one after another, one batch ahead of the builder: the next batch goes into reth's pool while the builder cuts the block before it."""
    def __init__(self, py, root, per_block):
        super().__init__(daemon=True)
        self.cmd, self.ready, self.stop, self.error = [py, str(root / "demo_w1.py"), "plain", str(per_block)], queue.Queue(maxsize=1), False, None

    def run(self):
        try:
            while not self.stop:
                subprocess.run(self.cmd, check=True, capture_output=True)
                while not self.stop:
                    try:
                        self.ready.put(True, timeout=0.5)
                        break
                    except queue.Full:
                        pass
        except Exception as e:  # the sender's failure is the flood's: run() raises it
            self.error = e

    def next_batch(self):
        while True:
            if self.error:
                raise RuntimeError(f"the sender stopped: {self.error}")
            try:
                return self.ready.get(timeout=0.5)
            except queue.Empty:
                pass


def run(seconds, per_block, results):
    base, py, root = os.environ["EXPLORER"], os.environ["L3_PY"], Path(__file__).resolve().parent
    stream = Stream(base)
    stream.start()
    clock = LedgerClock(os.environ.get("L3_LEDGER", "http://127.0.0.1:7577"))
    clock.start()
    size0, txs0 = database()
    tables0 = table_sizes()
    cut = []          # (number, update id, returned at, transactions)
    seen = {}         # number -> {"served": t, "final": t}
    done = threading.Event()

    def watch():
        while True:
            active = [(n, t) for n, _, t, _ in list(cut) if "final" not in seen.setdefault(n, {}) and time.monotonic() - t < GIVE_UP_S]
            if not active and done.is_set():
                return
            for number, _ in active:
                status, body = get(f"{base}/api/block/{number}")
                now = time.monotonic()
                if status == 200 and from_database(body):
                    seen[number].setdefault("served", now)
                    seen[number]["final"] = now
                time.sleep(POLL_S)
            if not active:
                time.sleep(POLL_S)

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    sender = Sender(py, root, per_block)
    sender.start()
    started = time.monotonic()
    end = started + seconds
    try:
        while time.monotonic() < end:
            sender.next_batch()
            cutting = subprocess.run(["bash", "-c", "cut_block"], capture_output=True, text=True, env={**os.environ, "CUT_BLOCK_JSON": "1"})
            if cutting.returncode != 0:   # the reason is in what cut_block printed: all of it is kept beside the results, and the lists of hashes are left out of the message
                said = cutting.stderr + cutting.stdout
                Path(results).with_name("l3-cut-failure.txt").write_text(said)
                raise RuntimeError(f"cut_block exited {cutting.returncode}: {HASH_LISTS.sub('[...]', said).strip()[:2500]}")
            out = cutting.stdout
            returned = time.monotonic()
            number = int(rpc("eth_blockNumber", []), 16)
            count = len(rpc("eth_getBlockByNumber", [hex(number), False])["transactions"])
            cut.append((number, committed(out), returned, count))
            print(f"block {number}: {count} transactions committed", flush=True)
    finally:
        sender.stop = True
        done.set()
    flood_s = time.monotonic() - started
    watcher.join(timeout=GIVE_UP_S + 30)
    # A block's `block` event can come a moment after the API serves it: give the stream until every served block has arrived, up to 5 s.
    grace = time.monotonic() + 5
    while time.monotonic() < grace and any("served" in seen.get(n, {}) and n not in stream.arrived for n, *_ in cut):
        time.sleep(0.1)
    stream.stop = clock.stop = True
    size1, txs1 = database()
    tables1 = table_sizes()
    offsets = reader_offsets([u for _, u, _, _ in cut])
    blocks = []
    for number, update_id, returned, count in cut:
        mark, got = seen.get(number, {}), stream.arrived.get(number)
        served = mark.get("served")
        offset = offsets.get(update_id)
        t0 = clock.reached(offset)
        t0_from = "ledger" if t0 is not None else "fallback"
        t0 = returned if t0 is None else t0
        blocks.append({"number": number, "txs": count, "update_id": update_id, "reader_offset": offset, "t0_from": t0_from,
                       "served_s": None if served is None else max(0.0, served - t0),
                       "final_s": None if "final" not in mark else max(0.0, mark["final"] - t0),
                       "sse_after_served_s": None if served is None or got is None else max(0.0, got - served)})
    summary, failures = judge(blocks, growth_per_million(size0, size1, txs0, txs1), txs1 - txs0)
    if blocks:
        summary["blocks_per_minute"] = round(len(blocks) / flood_s * 60, 2)
    if txs1 > txs0:   # where the growth is: the five tables that grew most, in bytes per million transactions added
        grown = sorted(((t, tables1.get(t, 0) - tables0.get(t, 0)) for t in tables1), key=lambda kv: -kv[1])[:5]
        summary["growth_by_table_bytes_per_million"] = {t: round(g / (txs1 - txs0) * 1_000_000) for t, g in grown}
    summary.update(ledger_end_polls=len(clock.offsets), ledger_end_polls_unanswered=clock.misses, ledger_end_last_error=clock.last_miss)
    summary.update(seconds=seconds, flood_seconds=round(flood_s, 1), transactions_per_block_sent=per_block, database_bytes_before=size0, database_bytes_after=size1, failures=failures, per_block=blocks)
    Path(results).write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "per_block"}, indent=1))
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "run":
        sys.exit(run(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]))
    print(__doc__, file=sys.stderr)
    sys.exit(2)
