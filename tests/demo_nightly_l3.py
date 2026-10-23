#!/usr/bin/env python3
"""L3 of the explorer's design (section 9), the nightly flood on the rehearsal chain: the real reth, Canton, builder and the explorer's indexer, with the
stand-in proof. It floods the producer with blocks of plain transfers (1,428 fit under the 30 Mgas cap), cut one after another as the builder takes them,
and measures, for each block, from the moment the update can be read on the reader's participant (the ledger end, polled every 20 ms, reaches the offset the
update has on that participant, which the indexer stored (canton_updates.reader_offset, found by the update's id; offsets are local to a participant, so the builder's
own is no use); the clock starts at the last poll that could not read it, so a lag is an upper bound, at most one poll too long):
  served   the moment the block's row is readable in the explorer's PostgreSQL (what the API serves from): a psql session polls `select max(number), clock_timestamp()
           from blocks` every 20 ms, and the first tick that sees the block is its time. It is taken from the database, never from an API answer, so it holds nothing
           of the size of the answer (/api/block/N lists all 1,428 transactions) or of the polls before it. B1's index lag. The first answer of the API from its database
           (status final, with the Canton record; one from reth alone says nothing of the indexer) is still waited for, polled every 60 ms, and its delay after `served`
           is reported (api_answer_after_served_s).
  record   how long after the block's Canton record time (canton_updates.record_time, the time the synchronizer gave the update) the block was served: reported
           beside B1 as an observed number (record_time_to_served_p50_s, _p95_s), as the design's section 9 asks; it is not held to a budget. The record time and the
           database's clock are both this machine's wall clock in the rehearsal.
  sse      how long after the block was readable in the database (the last tick that could not see it, an upper bound) a live-stream client receives the block's
           `block` event (B4); every block must reach the client. It is not clamped: an event that came before the tick shows as a negative number, within the error.
and, over the whole flood, the growth of the explorer's database per million transactions (B6). l3.json reports the measurement error (measurement_error_s): the
lag is an upper bound, over by at most one ledger poll plus one database tick.
Time to final is NOT measured: the flood's transactions go straight to reth (not through the explorer's RPC, so tx_lifecycle has no accepted_at for them), and
without a GPU there is no proof to wait for; a block's `final` and `served` would be the same moment.
Held to B1 (p95 <= 2.75 s, on the shared runner the project's W1-derived B1 of explorer/test/budgets.ts; the design's 1.0 s for a block of
at most 1,428 transactions is checked on the reference machine, the explorer's DevNet host), B4 (p95 <= 0.5 s) and B6 (<= 2.5 GB per million transactions).

  demo_nightly_l3.py run <seconds> <transactions per block> <results.json>

Reads: EXPLORER (the explorer's URL), L3_PY (the Python of the demo's virtualenv), L3_DB (the explorer's database container), and the demo's own variables,
which the rehearsal exports with the function `cut_block` (bash -c cut_block cuts a block through the real builder; with CUT_BLOCK_JSON=1 it prints the commit's update id),
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

# B1 for L3 (docs/METRICS.md): L3 runs on a shared GitHub runner (Canton, reth, the builder, PostgreSQL and the explorer share its CPU), so its index
# lag is held to the W1-derived provisional B1 of explorer/test/budgets.ts (B1_MS = 2750), now that the measurement is precise; the design's 1.0 s is checked on the reference
# machine (the explorer's DevNet host). test_demo_nightly_l3.py checks that the two files agree.
B1_S = 2.75
B4_S = 0.5
B6_BYTES = 2.5e9
MIN_TXS_FOR_B6 = 5_000
POLL_S = 0.06
GIVE_UP_S = 180
HASH_LISTS = re.compile(r'\[\s*(?:"0x[0-9a-fA-F]+"(?:\s*,\s*"0x[0-9a-fA-F]+")*)?\s*\]')   # a list of transaction hashes, which the builder report holds by the thousand
LEDGER_POLL_S = 0.02
DB_POLL_S = 0.02
WALL_OFFSET = time.time() - time.monotonic()   # monotonic seconds + this = wall-clock seconds (the database's clock is the wall clock of this machine)


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


def judge(blocks, growth, txs_added, database_clock_error=None):
    """The summary of a flood and the budgets it broke."""
    failures = []
    if not blocks:
        return {"blocks": 0}, ["no block was cut"]
    never = [b["number"] for b in blocks if b["served_s"] is None]
    if never:
        failures.append(f"blocks {never} were never seen in the database by the clock that times them" + (f" (its last error: {database_clock_error})" if database_clock_error else ""))
    unanswered = [b["number"] for b in blocks if b["served_s"] is not None and "api_answer_after_served_s" in b and b["api_answer_after_served_s"] is None]
    if unanswered:
        failures.append(f"blocks {unanswered} were in the database but the API never answered for them from it")
    clockless = [b["number"] for b in blocks if b.get("t0_from") == "fallback"]
    if clockless:
        failures.append(f"B1: the clock of blocks {clockless} could not start from the reader's ledger end (the offset was not read), so their lag is not measured")
    served = [b["served_s"] for b in blocks if b["served_s"] is not None]
    sse = [b["sse_after_served_s"] for b in blocks if b["sse_after_served_s"] is not None]
    since_record = [b["record_time_to_served_s"] for b in blocks if b.get("record_time_to_served_s") is not None]   # observed, never held
    summary = {
        "blocks": len(blocks), "transactions": sum(b["txs"] for b in blocks), "largest_block_txs": max(b["txs"] for b in blocks),
        "served_p50_s": percentile(served, 50), "served_p95_s": percentile(served, 95), "served_max_s": max(served, default=None),
        "record_time_to_served_p50_s": percentile(since_record, 50), "record_time_to_served_p95_s": percentile(since_record, 95), "record_time_blocks": len(since_record),
        "final_measured": False,
        "final_note": "time to final is not measured: the flood goes straight to reth (tx_lifecycle has no accepted_at for it) and a stand-in proof is no wait",
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


def record_times(update_ids):
    """The Canton record time of each update as the indexer stored it (canton_updates.record_time), in wall-clock seconds: update id -> epoch seconds."""
    ids = [u for u in update_ids if u]
    if not ids or not all(u.isalnum() for u in ids):
        return {}
    return {row[0]: float(row[1]) for row in sql_rows("select update_id, extract(epoch from record_time) from canton_updates where update_id in (" + ",".join(f"'{u}'" for u in ids) + ")")}


def block_updates(numbers):
    """The update id of each block as the indexer stored it (blocks.update_id), by block number: it does not depend on what `cut_block` printed, so a cut that failed
    but committed is timed like any other."""
    ns = [n for n in numbers if isinstance(n, int)]
    if not ns:
        return {}
    return {int(row[0]): row[1] for row in sql_rows("select number, update_id from blocks where number in (" + ",".join(str(n) for n in ns) + ")")}


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


class DbClock(threading.Thread):
    """When each block's row became readable in the explorer's PostgreSQL: one psql session runs `select max(number), clock_timestamp() from blocks` every 20 ms, and every
    tick is kept as (database clock, newest block number). The database runs on this machine, so its clock is this one's (time.time()). Blocks are written in order, so
    the first tick whose newest number reaches a block is when the block was first seen, and the tick before it could not see it: the block became readable between the
    two (a commit is atomic), and the gap between them is the measurement error."""
    def __init__(self, container):
        super().__init__(daemon=True)
        self.container, self.stop, self.times, self.newest, self.proc, self.error = container, False, [], [], None, None

    def run(self):
        try:
            self.proc = subprocess.Popen(["docker", "exec", "-i", self.container, "psql", "-U", "explorer", "-d", "explorer", "-AtF", " "],
                                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
            self.proc.stdin.write("select coalesce(max(number), 0), extract(epoch from clock_timestamp())::float8 from blocks;\n\\watch " + str(DB_POLL_S) + "\n")
            self.proc.stdin.flush()
            for line in self.proc.stdout:
                self.tick(line)
                if self.stop:
                    break
        except Exception as e:  # a dead clock is blocks that cannot be timed: judge() names them
            self.error = f"{type(e).__name__}: {str(e)[:200]}"
        finally:
            if self.proc is not None:
                self.proc.kill()

    def tick(self, line):
        """One line of psql's output: `<newest block number> <epoch seconds>`; anything else (a header, an error) is kept as the last error."""
        m = re.fullmatch(r"(\d+) (\d+\.?\d*)", line.strip())
        if not m:
            self.error = line.strip()[:200] or self.error
            return
        number, at = int(m.group(1)), float(m.group(2))
        if self.newest and number < self.newest[-1]:   # the table cannot lose blocks while L3 runs; a reindex would, and the clock must not run backwards
            return
        self.times.append(at)
        self.newest.append(number)

    def seen(self, number):
        """(the last tick that could not see the block, the first tick that could), as wall-clock seconds; None for either when there is no such tick."""
        i = bisect.bisect_left(self.newest, number)
        return (self.times[i - 1] if 0 < i <= len(self.times) else None), (self.times[i] if i < len(self.times) else None)

    def gaps(self):
        """The gaps between consecutive ticks: how long the database was not looked at."""
        return [b - a for a, b in zip(self.times, self.times[1:])]


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


def reth_head():
    """reth's head block: (number, hash)."""
    block = rpc("eth_getBlockByNumber", ["latest", False])
    return int(block["number"], 16), block["hash"].lower()


def canton_head():
    """Canton's head, from the chain's state contract (the rehearsal's function `canton_head`): (number, hash)."""
    done = subprocess.run(["bash", "-c", "canton_head"], capture_output=True, text=True, timeout=120)
    for line in reversed(done.stdout.strip().splitlines()):
        try:
            answer = json.loads(line)
            return int(answer["headNumber"]), "0x" + str(answer["headHash"]).removeprefix("0x").lower()
        except (ValueError, KeyError, TypeError):
            continue
    raise RuntimeError(f"Canton's head could not be read (exit {done.returncode}): {(done.stderr + done.stdout).strip()[:300]}")


def after_failed_cut(canton, reth, reth_before, reason):
    """What a cut that failed leaves L3 to do: None to carry on (Canton has the block, and reth the same one), else the failure that stops L3. A cut is never made
    again: an Advance that Canton answered late may still commit, and a second block cut on top of it forks the chain. `canton` and `reth` are (number, hash);
    `reth_before` is reth's head number before the cut; `reason` is the builder's."""
    if canton != reth:
        at = min(canton[0], reth[0]) + (1 if canton[0] != reth[0] else 0)
        return f"the chain forked at block {at}: Canton holds {canton[0]} ({canton[1]}), reth holds {reth[0]} ({reth[1]})"
    if canton[0] <= reth_before:
        return reason   # neither has a new block: the cut did not happen, and the builder says why
    return None


def from_database(body):
    """Whether an answer of /api/block/<n> comes from the explorer's database: the final block with its Canton record. Reth alone answers "unindexed" or "proving"."""
    return isinstance(body, dict) and body.get("status") == "final" and body.get("canton") is not None


class Sender(threading.Thread):
    """Sends batches of transfers one after another, one batch ahead of the builder: the next batch goes into reth's pool while the builder cuts the block before it."""
    def __init__(self, py, root, per_block):
        super().__init__(daemon=True)
        # At the lowest priority: on the runner the sender shares its cores with Canton, reth, the builder and the explorer, and a sender that is ahead of them starved
        # Canton into answering the builder's Advance too late (20 s) in two of four trial runs.
        self.cmd, self.ready, self.stop, self.error = ["nice", "-n", "19", py, str(root / "demo_w1.py"), "plain", str(per_block)], queue.Queue(maxsize=1), False, None

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
    dbclock = DbClock(os.environ["L3_DB"])
    dbclock.start()
    size0, txs0 = database()
    accepted0 = sql("select count(*) from tx_lifecycle where accepted_at is not null")
    tables0 = table_sizes()
    cut = []          # (number, update id, returned at, transactions)
    seen = {}         # number -> {"api_sent": t, "api_answered": t}: the first answer of the API from its database (monotonic seconds)
    done = threading.Event()
    cuts_kept = []    # cuts that reported a failure but that Canton and reth both hold

    def watch():
        while True:
            active = [(n, t) for n, _, t, _ in list(cut) if "api_answered" not in seen.setdefault(n, {}) and time.monotonic() - t < GIVE_UP_S]
            if not active and done.is_set():
                return
            for number, _ in active:
                sent = time.monotonic()
                status, body = get(f"{base}/api/block/{number}")
                if status == 200 and from_database(body):
                    seen[number].setdefault("api_sent", sent)
                    seen[number].setdefault("api_answered", time.monotonic())
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
            before = int(rpc("eth_blockNumber", []), 16)
            cutting = subprocess.run(["bash", "-c", "cut_block"], capture_output=True, text=True, env={**os.environ, "CUT_BLOCK_JSON": "1"})
            if cutting.returncode != 0:
                # The reason is in what cut_block printed: all of it is kept beside the results, and the lists of hashes are left out of the message. The cut is not made
                # again: the builder settles an Advance that had no answer by its command id, and what is left is for Canton's head and reth's to say.
                said = cutting.stderr + cutting.stdout
                Path(results).with_name(f"l3-cut-failure-{len(cut) + 1}.txt").write_text(said)
                reason = f"cut_block exited {cutting.returncode}: {HASH_LISTS.sub('[...]', said).strip()[:1200]}"
                print(reason, flush=True)
                try:
                    stop = after_failed_cut(canton_head(), reth_head(), before, reason)
                except Exception as e:
                    stop = f"{reason}; and the heads could not be compared: {type(e).__name__}: {str(e)[:300]}"
                if stop:
                    raise RuntimeError(stop)
                cuts_kept.append({"block_after": len(cut), "reason": reason[:600]})
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
    while time.monotonic() < grace and any("api_answered" in seen.get(n, {}) and n not in stream.arrived for n, *_ in cut):
        time.sleep(0.1)
    stream.stop = clock.stop = dbclock.stop = True
    size1, txs1 = database()
    accepted1 = sql("select count(*) from tx_lifecycle where accepted_at is not null")
    tables1 = table_sizes()
    update_ids = block_updates([n for n, *_ in cut])   # the block's update by its number in the database, not from what cut_block printed
    offsets = reader_offsets([update_ids.get(n) or u for n, u, _, _ in cut])
    record_at = record_times([update_ids.get(n) or u for n, u, _, _ in cut])
    blocks = []
    for number, printed_id, returned, count in cut:
        update_id = update_ids.get(number) or printed_id
        mark, got = seen.get(number, {}), stream.arrived.get(number)
        offset = offsets.get(update_id)
        t0 = clock.reached(offset)
        t0_from = "ledger" if t0 is not None else "fallback"
        t0 = returned if t0 is None else t0
        before, first = dbclock.seen(number)          # wall-clock seconds: the last database tick that could not see the block, the first that could
        t0, got = t0 + WALL_OFFSET, None if got is None else got + WALL_OFFSET
        answered = mark.get("api_answered")
        blocks.append({"number": number, "txs": count, "update_id": update_id, "reader_offset": offset, "t0_from": t0_from,
                       "served_s": None if first is None else max(0.0, first - t0),
                       "record_time_to_served_s": None if first is None or record_at.get(update_id) is None else first - record_at[update_id],
                       "database_tick_gap_s": None if first is None or before is None else first - before,
                       "api_answer_after_served_s": None if first is None or answered is None else answered + WALL_OFFSET - first,
                       "sse_after_served_s": None if got is None or (before is None and first is None) else got - (first if before is None else before)})
    summary, failures = judge(blocks, growth_per_million(size0, size1, txs0, txs1), txs1 - txs0, dbclock.error)
    if blocks:
        summary["blocks_per_minute"] = round(len(blocks) / flood_s * 60, 2)
    if txs1 > txs0:   # where the growth is: the five tables that grew most, in bytes per million transactions added
        grown = sorted(((t, tables1.get(t, 0) - tables0.get(t, 0)) for t in tables1), key=lambda kv: -kv[1])[:5]
        summary["growth_by_table_bytes_per_million"] = {t: round(g / (txs1 - txs0) * 1_000_000) for t, g in grown}
    gaps, ledger_gaps = dbclock.gaps(), [b - a for a, b in zip(clock.sent, clock.sent[1:])]
    summary["measurement_error_s"] = {
        "note": "the lag is an upper bound: over by at most the ledger poll gap (the clock starts at the last poll that could not read the update) plus the database tick gap (the block is timed at the first tick that saw it); the stream delay is measured from the last tick that could not see the block, so it is over by at most one database tick gap",
        "database_tick_gap_p95_s": percentile(gaps, 95), "database_tick_gap_max_s": max(gaps, default=None), "database_ticks": len(dbclock.times),
        "ledger_poll_gap_p95_s": percentile(ledger_gaps, 95), "ledger_poll_gap_max_s": max(ledger_gaps, default=None),
        "lag_over_by_at_most_s": None if not gaps or not ledger_gaps else max(gaps) + max(ledger_gaps),
        "database_clock_last_error": dbclock.error,
    }
    summary["transactions_with_accepted_at"] = accepted1 - accepted0   # why time to final is not measured: the flood does not go through the explorer's RPC
    summary.update(cuts_failed_but_committed=cuts_kept, ledger_end_polls=len(clock.offsets), ledger_end_polls_unanswered=clock.misses, ledger_end_last_error=clock.last_miss)
    summary.update(seconds=seconds, flood_seconds=round(flood_s, 1), transactions_per_block_sent=per_block, database_bytes_before=size0, database_bytes_after=size1, failures=failures, per_block=blocks)
    Path(results).write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "per_block"}, indent=1))
    return 1 if failures else 0


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == "run":
        sys.exit(run(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]))
    print(__doc__, file=sys.stderr)
    sys.exit(2)
