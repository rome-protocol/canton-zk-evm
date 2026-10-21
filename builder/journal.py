"""The producer's journal and the block-cutting setting (README.md, "The journal" and "The block-cutting setting").

Nothing here talks to reth, Canton or the prover: `builder.py` calls it at the points where a block's steps happen."""
import http.client, json, os, time, urllib.error, urllib.request, uuid
from datetime import datetime, timezone
from pathlib import Path

def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


JOURNAL_FORMAT = 1
STRATEGIES = ("on_demand",)   # busy_rhythm and fixed_rhythm come later (see README.md, "The block-cutting setting")
MEASURED_PROOF_SECONDS = 6.3  # what an empty block took to prove on the testnet's prover: no rhythm may be shorter than this
MAX_GATHER_MS = 30_000        # a longer wait is a delay, not a way to batch a few more transactions


def iso_ms(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(t * 1000) % 1000:03d}Z"


class Journal:
    """The append-only record of what the producer does (README.md, "The journal"): one JSON line per event in journal/YYYY-MM-DD.jsonl in
    the work folder, flushed and synced to disk. Every line has the format version, the run id, a sequence number that starts again with
    every run, and a UTC time in milliseconds. A journal that cannot be written never stops the chain: the failure is kept in `error`
    (the status file shows it) and the line is lost; the next line tries again."""

    def __init__(self, folder: str | Path, run_id: str | None = None, clock=time.time):
        self.folder, self.run_id, self.clock = Path(folder), run_id or str(uuid.uuid4()), clock
        self.seq = 0
        self.error: dict | None = None   # {"time", "error"} of the last write that failed; None once a write has worked since
        self._checked = None             # the day whose file's last line is known to be whole

    def event(self, name: str, **fields) -> None:
        self.seq += 1   # a line that is lost leaves a gap in the sequence, which the loader can see
        t = self.clock()
        line = {"v": JOURNAL_FORMAT, "run": self.run_id, "seq": self.seq, "time": iso_ms(t), "event": name, **fields}
        try:
            data = (json.dumps(line, separators=(",", ":")) + "\n").encode()
            day = iso_ms(t)[:10]   # the file of the line's own UTC day: a new day is a new file
            self.folder.mkdir(parents=True, exist_ok=True)
            path = self.folder / f"{day}.jsonl"
            new = not path.exists()
            with open(path, "ab") as f:
                if self._checked != day and f.tell():   # a line cut short by a crash or a failed write must not swallow the next one
                    with open(path, "rb") as r:
                        r.seek(-1, os.SEEK_END)
                        if r.read(1) != b"\n":
                            f.write(b"\n")
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            if new:   # the new file's name has to survive a crash too
                fd = os.open(self.folder, os.O_RDONLY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            self._checked, self.error = day, None
        except (OSError, TypeError, ValueError) as e:
            self._checked, self.error = None, {"time": iso(t), "error": f"{type(e).__name__}: {e}"}


class Attempt:
    """One block attempt's lines in the journal, all with the attempt's number. `build_block` writes the lines from the cut to Canton's
    answer through it. With no journal it writes nothing (the `once` command)."""

    def __init__(self, journal: Journal | None, seq: int, cut: dict | None = None, in_flight: int = 0):
        self.journal, self.seq, self.fields, self.in_flight = journal, seq, cut or {}, in_flight
        self.cut_written = self.closed = False   # closed: the attempt has its last line (answered, skipped or failed)
        self.stage = "cut"

    def event(self, name: str, **fields) -> None:
        self.stage = name
        if name in ("answered", "skipped"):
            self.closed = True
        if self.journal is not None:
            self.journal.event(name, attempt=self.seq, **fields)

    def cut(self, number: int | None) -> None:
        """The decision to build, written once the number is known (it is Canton's head plus one)."""
        if not self.cut_written:
            self.cut_written = True
            self.event("cut", number=number, **self.fields)

    def failed(self, reason: str) -> None:
        """The attempt ended before Canton was asked, or the answer could not be used: reth, the ledger or the prover failed it."""
        if self.closed:
            return
        stage = self.stage
        self.cut(None)   # the failure came before Canton's head was read: the number is not known
        self.event("answered", outcome="failed", reason=reason[:600], stage=stage)


def parse_traffic(state: object) -> int | None:
    """The bytes of traffic a participant has used so far, from its traffic state (`extraTrafficConsumed`, as a number or as the digits of an int64)."""
    if isinstance(state, dict) and isinstance(state.get("trafficState"), dict):
        state = state["trafficState"]
    value = state.get("extraTrafficConsumed") if isinstance(state, dict) else None
    if isinstance(value, str) and value.isdigit():
        value = int(value)
    return value if type(value) is int and value >= 0 else None


def read_traffic(url: str, headers: dict) -> int | None:
    """The builder's participant's traffic used so far, or None where it is not configured or the participant does not report it. This
    never fails: a participant that does not answer must not hold up a block."""
    if not url:
        return None
    try:
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=5) as r:
            return parse_traffic(json.load(r))
    except urllib.error.HTTPError as e:   # an answer that is an error: the participant does not report it
        e.close()
        return None
    except (OSError, ValueError, http.client.HTTPException):
        return None


def check_settings(strategy: str, gather_ms: float, heartbeat_seconds: float, max_in_flight: int = 1, provers: int = 1) -> None:
    """Refuses a setting that cannot keep up or that this producer cannot do: raises ValueError that says why."""
    if strategy not in STRATEGIES:
        raise ValueError(f"bad arguments: the strategy {strategy!r} is not available (this producer has: {', '.join(STRATEGIES)})")
    if gather_ms < 0 or heartbeat_seconds < 0:
        raise ValueError("bad arguments: gather_ms and heartbeat_seconds cannot be negative")
    if gather_ms > MAX_GATHER_MS:
        raise ValueError(f"bad arguments: gather_ms {gather_ms:g} is over {MAX_GATHER_MS}: a transaction would wait longer than a block takes to make")
    if max_in_flight != 1:
        raise ValueError("bad arguments: one block at a time is in flight; more needs overlapped proving, which is not built yet")
    shortest = MEASURED_PROOF_SECONDS / provers
    if 0 < heartbeat_seconds < shortest:
        raise ValueError(f"bad arguments: heartbeat_seconds {heartbeat_seconds:g} cannot keep up: an empty block takes {MEASURED_PROOF_SECONDS:g} s "
                           f"to prove on {provers} prover(s), so a block could not be made in less than {shortest:g} s")
