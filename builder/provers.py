"""The prover pool: the builder's only interface to provers. See README.md, "Provers".

A prover is a name and the URL of one coordinator. A job is the input tool plus the prove command, run with ZISK_COORDINATOR_URL set to one
prover's URL. Each prover takes one job at a time; the oldest waiting job goes to a free prover that is up. Job threads touch neither reth
nor the journal: they report state changes through `Pool.events()`, and the producer's own thread writes the journal lines.

With one prover (or none configured: the local prover the prove command names) the pool is a plain synchronous runner: one try, no health,
no retry, no events. With two or more, a failed job is tried once more on another prover, and a prover's health is tracked.
"""
import math, os, re, shutil, signal, subprocess, sys, threading, time
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_TIMEOUT = 1800.0       # seconds a prove command may take: the limit prover/prove-one.sh has had all along
COOLDOWN_START = 30.0          # a prover that went down gets no job for this long, then tries the next one
COOLDOWN_MAX = 300.0           # the cool-down doubles after each new fault, up to this
BUSY_RETRY_WAIT = 3.0          # seconds a job waits before it asks a coordinator again that said its workers are busy (a timed-out or abandoned job may still be finishing there)
BUSY_RETRIES = 5               # how many times in a row a job asks again before the prover counts as unavailable (a cool-down, like a capacity refusal)
PROOF_HEX_LENGTH = 2688        # a wrapped proof: 1,344 bytes as lowercase hex
# What cargo-zisk and the tools under it print when the coordinator cannot be reached (as opposed to refusing or failing a proof).
CONNECTION_ERROR = re.compile(
    r"connection refused|connection reset|connection closed|connection aborted|error trying to connect|tcp connect error|dns error|"
    r"failed to connect|transport error|broken pipe|no route to host|network is unreachable|host is unreachable|timed out connecting",
    re.IGNORECASE)
# What a ZisK coordinator answers when it refuses a request at once (cluster unavailable): not a failed proof and not a lost connection.
# CAPACITY: its worker is gone (a CUDA abort); every request is refused until the worker is back. BUSY: its worker is running another job.
CAPACITY_REFUSAL = re.compile(r"insufficient ready capacity", re.IGNORECASE)
BUSY_REFUSAL = re.compile(r"workers are busy|cluster unavailable|the service is currently unavailable", re.IGNORECASE)


def refusal_kind(text: str) -> str | None:
    """"capacity", "busy" or None for what a prove command printed."""
    if CAPACITY_REFUSAL.search(text):
        return "capacity"
    return "busy" if BUSY_REFUSAL.search(text) else None


class JobError(Exception):
    """A job failed. `outcome` is what the journal's proof_ended line says: failed, timeout or wrong_block. `connection` is True when the
    prover could not be reached. `unavailable` is "busy" or "capacity" when the prover's coordinator refused the job at once for want of a
    free or ready worker (the block is not blamed). `stage` is "input" when the input tool failed (not a prover's fault) and "prove" otherwise."""

    def __init__(self, message: str, outcome: str = "failed", connection: bool = False, stage: str = "prove",
                 unavailable: str | None = None):
        super().__init__(message)
        self.outcome, self.connection, self.stage, self.unavailable = outcome, connection, stage, unavailable
        self.tried: list = []   # the names of the provers the block was tried on (with two or more provers)


@dataclass
class Prover:
    name: str
    url: str | None = None          # None: whatever ZISK_COORDINATOR_URL the environment already has (today's single local prover)
    state: str = "up"
    cooldown: float = COOLDOWN_START   # the length of the next cool-down
    down_until: float = 0.0
    busy: bool = False
    jobs: int = 0
    failures: int = 0

    def status(self) -> dict:
        return {"name": self.name, "url": self.url, "state": self.state, "busy": self.busy, "jobs": self.jobs, "failures": self.failures}


def parse_provers(specs: list, default_name: str, default_url: str | None = None) -> list:
    """`--prover name=URL` (repeatable, or CZE_PROVERS as a comma-separated list) into Provers. None given: one prover named after the
    prove command, with the URL from the environment."""
    found = []
    for spec in specs:
        name, sep, url = spec.partition("=")
        name, url = name.strip(), url.strip()
        if not sep or not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or not re.fullmatch(r"https?://\S+", url):
            raise ValueError(f"bad --prover {spec!r}: expected name=URL, e.g. gpu0=http://127.0.0.1:7000")
        if any(p.name == name for p in found):
            raise ValueError(f"bad --prover: the name {name!r} is given twice")
        found.append(Prover(name, url))
    return found or [Prover(default_name, default_url)]


def run_command(cmd: str, args: list, env: dict | None = None, timeout: float | None = None) -> None:
    """Runs a command in its own session (a Ctrl-C or a service manager's signal to the builder's group must not cut a proof short).
    At the timeout the whole process group is killed. A non-zero exit is a JobError carrying the end of the output."""
    name = Path(cmd.split()[0]).name
    proc = subprocess.Popen([*cmd.split(), *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True,
                            env={**os.environ, **(env or {})})
    try:
        out, err = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:   # a helper that left the group and still holds the pipes must not hold the producer: drain for a moment, then let go
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            for pipe in (proc.stdout, proc.stderr):
                try:
                    pipe.close()
                except Exception:
                    pass
            proc.wait()
        raise JobError(f"{name} did not finish in {timeout:g} s and was killed", outcome="timeout") from None
    if proc.returncode != 0:
        text = (err or out).strip()
        tail = f"{err or ''}\n{out or ''}"[-4000:]
        raise JobError(f"{name} failed: {text[-400:]}", connection=bool(CONNECTION_ERROR.search(text[-4000:])), unavailable=refusal_kind(tail))


@dataclass
class Job:
    """What one block needs proven. `make_input` is the input tool's command and arguments (run once, on no prover); `prove_cmd` is
    run as `prove_cmd <input> <out>`. `check(proof_hex)` raises a JobError (outcome wrong_block) for a proof that is not this block's."""
    make_input: list | None        # [cmd, *args], or None when input.bin is already there
    prove_cmd: str
    input_path: Path
    out_dir: Path                  # the first try's output folder; a retry writes to out_dir with "-retry" added
    check: object = None
    # Whether `cargo-zisk remote prove -i` sends the input file over the connection or names a path on the coordinator's machine could not be
    # settled from the help of cargo-zisk 1.3.1 (it takes a file path, file://path or inline:// data). Both are supported: by default the path of the local input is
    # passed (the file is uploaded, if the client does that); with input_dir set the input is copied into that folder first (a folder the
    # coordinator's machine can see) and that copy's path is passed, and removed after the try. Neither has run against a second machine.
    input_dir: Path | None = None


@dataclass
class Proved:
    proof: str
    out_dir: Path
    prover: str
    seconds: float
    tried: list = field(default_factory=list)   # the provers a failed try was made on first, in order


class Ticket:
    """A job handed to the pool. `result()` blocks until the proof or the error; `cancel()` discards the result (a job already on a prover
    runs to the end, with no effect on health, and is not retried)."""

    def __init__(self, cond: threading.Condition | None = None):
        self.cond = cond                 # the pool's: a cancel wakes the jobs waiting for a prover
        self.done = threading.Event()
        self.proved: Proved | None = None
        self.error: Exception | None = None
        self.cancelled = False
        self.prover: str | None = None   # the prover the job is on now

    def cancel(self) -> None:
        if self.cond is None:
            self.cancelled = True
            return
        with self.cond:
            self.cancelled = True
            self.cond.notify_all()

    def result(self) -> Proved:
        self.done.wait()
        if self.error:
            raise self.error
        return self.proved


class Pool:
    def __init__(self, provers: list, timeout: float = DEFAULT_TIMEOUT, clock=time.monotonic, run=run_command,
                 cooldown_start: float = COOLDOWN_START, cooldown_max: float = COOLDOWN_MAX,
                 busy_wait: float = BUSY_RETRY_WAIT, busy_retries: int = BUSY_RETRIES, stop: threading.Event | None = None):
        if not provers:
            raise ValueError("a pool needs at least one prover")
        self.provers, self.timeout, self.clock, self.run = list(provers), timeout, clock, run
        self.cooldown_start, self.cooldown_max = cooldown_start, cooldown_max
        self.busy_wait, self.busy_retries = busy_wait, busy_retries
        self.stop = stop    # set by a stop signal: the waits that follow a coordinator's refusal end (the block is given up, its transactions kept)
        for p in self.provers:
            p.cooldown = cooldown_start
        self.managed = len(self.provers) >= 2   # health and retry only exist with two or more provers
        self.cond = threading.Condition()
        self.queue: list = []                   # tickets waiting for a prover, oldest first
        self._events: list = []

    # -- what the producer reads

    def events(self) -> list:
        """The state changes since the last call, oldest first: [{"name", "state", "reason"}]. Always empty with one prover."""
        with self.cond:
            out, self._events = self._events, []
        return out

    def status(self) -> list | None:
        """The status file's `provers` list; None with one prover, which has no health to report."""
        with self.cond:
            return [p.status() for p in self.provers] if self.managed else None

    def any_up(self) -> bool:
        """True when a job could go to a prover now or when a cool-down is over. With two or more provers the producer cuts nothing while this is False."""
        now = self.clock()
        with self.cond:
            return any(p.state == "up" or now >= p.down_until for p in self.provers)

    # -- running jobs

    def prove(self, job: Job) -> Proved:
        """One job, synchronously."""
        return self.submit(job).result()

    def submit(self, job: Job) -> Ticket:
        ticket = Ticket(self.cond)
        threading.Thread(target=self._work, args=(ticket, job), daemon=True, name="prove-job").start()
        return ticket

    def _work(self, ticket: Ticket, job: Job) -> None:
        try:
            ticket.proved = self._run(ticket, job)
        except Exception as e:   # the ticket carries every error to result(); a job thread never dies silently
            ticket.error = e
        finally:
            ticket.done.set()

    def _run(self, ticket: Ticket, job: Job) -> Proved:
        started = self.clock()
        if job.make_input:   # no prover is held for it, and its failure is no prover's fault: it is neither retried nor counted
            try:
                self.run(job.make_input[0], job.make_input[1:], timeout=self.timeout if self.managed else None)
            except JobError as e:
                e.stage = "input"
                raise
        tried: list = []     # (prover, error) of the tries that failed
        avoid_now: list = []  # a prover that just said its workers are busy, while another is free
        busy_asked = 0       # refusals "workers are busy" in a row
        refused = False      # a coordinator refused this job at least once: its later waits end on a stop and it keeps its place in the queue
        single_wait = self.cooldown_start   # the wait before a lone prover is asked again after "no ready worker"; it doubles
        while True:
            prover = self._take(ticket, [t[0] for t in tried] + avoid_now, front=refused, stoppable=refused)
            avoid_now = []
            if prover is None:   # cancelled (or stopped, while it waited out a refusal): never sent
                raise JobError("cancelled" if ticket.cancelled else "stopped while its prover was unavailable", outcome="cancelled")
            out = job.out_dir if not tried else job.out_dir.with_name(job.out_dir.name + "-retry")
            try:
                proof = self._try(prover, job, out)
            except JobError as e:
                if e.unavailable and not e.connection:   # a refusal at once: the prover is unavailable, no proof was tried; the block is not blamed and the failure count does not grow
                    self._release(prover, None, failed=None)
                    if ticket.cancelled:
                        raise JobError("cancelled", outcome="cancelled")
                    refused = True
                    busy_asked = busy_asked + 1 if e.unavailable == "busy" else 0
                    if e.unavailable == "busy" and busy_asked <= self.busy_retries:
                        if self._free_other(prover, [t[0] for t in tried]):
                            avoid_now = [prover]       # another prover is free: send the job there at once
                        else:
                            self._pause(ticket, self.busy_wait)   # this one, after a short wait: a job abandoned or timed out may still be finishing
                        continue
                    busy_asked = 0
                    reason = "its coordinator has no ready worker" if e.unavailable == "capacity" else "its coordinator stays busy"
                    if self.managed:   # down with the usual cool-down; the job waits for a prover that is up (this one again when its cool-down is over)
                        self._down(prover, reason)
                        if tried and not self._another(prover, [t[0] for t in tried]):   # the first prover's real failure stays the block's failure: no waiting for a prover that is out
                            err = self._failed(tried[-1][1], tried)
                            err.tried = [t[0].name for t in tried]
                            raise err
                    else:              # one prover: wait, then ask again, rather than fail the block over and over
                        self._note(f"{prover.name} refused the job ({reason}); asking again in {single_wait:g} s")
                        self._pause(ticket, single_wait)
                        single_wait = min(single_wait * 2, self.cooldown_max)
                    continue
                self._release(prover, e if e.connection and not ticket.cancelled else None, failed=True)   # a cancelled job has no effect on health
                tried.append((prover, e))
                if ticket.cancelled or not self.managed or len(tried) > 1 or not self._another(prover):
                    err = self._failed(e, tried)
                    err.tried = [t[0].name for t in tried]
                    raise err
                continue
            except BaseException:   # not a prover fault (no process, no shared folder, an unreadable proof file): the prover is free again, health unchanged, the error still ends this block
                self._release(prover, None, failed=True)
                raise
            self._release(prover, None, failed=False)
            if not ticket.cancelled:
                for earlier, e in tried:   # it failed on one prover and then succeeded on another: that prover is at fault
                    self._down(earlier, f"{e.outcome} on a block that then succeeded on {prover.name}: {str(e)[:120]}")
            return Proved(proof, out, prover.name, round(self.clock() - started, 3), [t[0].name for t in tried])

    def _failed(self, last: JobError, tried: list) -> JobError:
        """The error of a block that failed on every prover it was sent to. It marks no prover down."""
        if len(tried) < 2:
            return last
        why = "; ".join(f"{p.name}: {str(e)[:150]}" for p, e in tried)
        err = JobError(f"the block failed on every prover it was tried on: {why}", outcome=last.outcome)
        return err

    def _another(self, prover: Prover, exclude: list = ()) -> bool:
        """Another prover, not in `exclude`, that is up or whose cool-down is over."""
        now = self.clock()
        with self.cond:
            return any(p is not prover and p not in exclude and (p.state == "up" or now >= p.down_until) for p in self.provers)

    def _free_other(self, prover: Prover, exclude: list = ()) -> bool:
        """Another prover, not in `exclude` (the ones this block already failed on, which it never goes back to), that is up and not busy right now."""
        now = self.clock()
        with self.cond:
            return any(p is not prover and p not in exclude and not p.busy and (p.state == "up" or now >= p.down_until) for p in self.provers)

    def _note(self, text: str) -> None:
        print(f"prover pool: {text}", file=sys.stderr, flush=True)

    def _try(self, prover: Prover, job: Job, out: Path) -> str:
        env = {"CZE_PROVE_TIMEOUT": str(math.ceil(self.timeout))}
        if prover.url:
            env["ZISK_COORDINATOR_URL"] = prover.url
        shutil.rmtree(out, ignore_errors=True)
        source, copy = job.input_path, None
        if job.input_dir:   # the coordinator reads the input from a folder both machines see
            copy = job.input_dir / f"{prover.name}-{os.getpid()}-{time.time_ns()}.bin"
            shutil.copyfile(job.input_path, copy)
            source = copy
        try:
            # With one prover the builder never kills: the prove command's own limit (CZE_PROVE_TIMEOUT) is the only one, as before.
            self.run(job.prove_cmd, [str(source), str(out)], env=env, timeout=self.timeout if self.managed else None)
        finally:
            if copy:
                copy.unlink(missing_ok=True)
        proof_file = out / "wrapped-proof.hex"
        if not proof_file.is_file():
            raise JobError("the prover finished but left no wrapped-proof.hex")
        proof = proof_file.read_text().strip()
        if len(proof) != PROOF_HEX_LENGTH or proof.strip("0123456789abcdef"):
            raise JobError("the wrapped proof is not 1,344 bytes of lowercase hex")
        if job.check:
            job.check(proof)
        return proof

    # -- dispatch and health

    def _stopped(self) -> bool:
        return self.stop is not None and self.stop.is_set()

    def _take(self, ticket: Ticket, avoid: list, front: bool = False, stoppable: bool = False) -> Prover | None:
        """Waits for the ticket's turn (oldest first) and a free prover that is up (one that is not in `avoid` when another will do).
        `front`: a retry, or a job a coordinator refused, goes before the blocks that came after it. `stoppable`: a stop ends the wait (None)."""
        with self.cond:
            if ticket not in self.queue:
                self.queue.insert(0, ticket) if avoid or front else self.queue.append(ticket)   # a retry goes before the blocks that came after it
            try:
                while True:
                    if ticket.cancelled or (stoppable and self._stopped()):
                        return None
                    if self.queue[0] is ticket:
                        now = self.clock()
                        free = [p for p in self.provers if not p.busy and (p.state == "up" or now >= p.down_until)]
                        pick = [p for p in free if p not in avoid] or ([] if self.managed and avoid else free)
                        pick.sort(key=lambda p: (p.state == "down") if avoid else (p.state != "down"))   # a new block tries a prover whose cool-down is over first; a retry goes to one that is up
                        if pick:
                            prover = pick[0]
                            if prover.state == "down":   # its cool-down is over: this job tries it
                                prover.state = "up"
                                self._events.append({"name": prover.name, "state": "up", "reason": "cool-down over"})
                            prover.busy, ticket.prover = True, prover.name
                            prover.jobs += 1
                            return prover
                    waits = [p.down_until - now for p in self.provers if p.state == "down"] if self.queue[0] is ticket else []
                    self.cond.wait(timeout=min(max(0.05, min(waits)), 1.0) if waits else (0.5 if self.stop is not None else None))
            finally:
                if ticket in self.queue:
                    self.queue.remove(ticket)
                    self.cond.notify_all()

    def _pause(self, ticket: Ticket, seconds: float) -> None:
        """Waits `seconds` (real time), at most; a cancel ends it at once, and a stop within half a second."""
        end = time.monotonic() + seconds
        with self.cond:
            if ticket not in self.queue:   # the job keeps its place at the front while it waits (the next _take removes it), so no newer block takes the prover it will ask again
                self.queue.insert(0, ticket)
            while not ticket.cancelled and not self._stopped() and (left := end - time.monotonic()) > 0:
                self.cond.wait(timeout=min(left, 0.5))

    def _release(self, prover: Prover, connection_error: JobError | None, failed: bool | None) -> None:
        """`failed` None: the job never ran (the coordinator refused it): neither a failure nor a proof."""
        with self.cond:
            prover.busy = False
            if failed is None:
                prover.jobs -= 1   # `jobs` counts the jobs a prover took, and a refused ask was not one
            elif failed:
                prover.failures += 1
            elif self.managed:
                prover.cooldown = self.cooldown_start   # a proof ends the run of faults
            if connection_error is not None and self.managed:   # down in the same step as free, so no waiting job is sent to it
                self._down(prover, f"connection error: {str(connection_error)[:150]}")
            self.cond.notify_all()

    def _down(self, prover: Prover, reason: str) -> None:
        if not self.managed:
            return
        with self.cond:
            if prover.state == "down":
                return
            prover.state = "down"
            prover.down_until = self.clock() + prover.cooldown
            prover.cooldown = min(prover.cooldown * 2, self.cooldown_max)
            self._events.append({"name": prover.name, "state": "down", "reason": reason})
            self._note(f"{prover.name} is down for {prover.down_until - self.clock():g} s: {reason}")
            self.cond.notify_all()
