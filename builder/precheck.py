"""The pre-check: before a block is proven, run the ZisK emulator on its input and keep the block within its budgets.

  1. predicted proof time              <= budget_seconds: cost_total * (1 / cost_per_second) + cost_intercept, from the emulator's own cost figure
  2. emulator steps                    <= max_steps (a sanity ceiling well above honest blocks)
  3. the emulator run's wall time      <= timeout (over: the emulator's process group is killed)
  4. input size in bytes               <= max_input_bytes
  5. distinct contract codes loaded    <= max_codes, and their total bytes <= max_code_bytes
  6. an input tool that fails, or a guest that aborts or fails in the emulator, counts as over budget.

An emulator that is missing, killed, or whose output cannot be read is a service failure (PrecheckFailed), not a verdict: nobody is
blamed for it. The check bounds a block, it does not predict its proof time exactly. The code loads are read from the witness the input tool was given
(its "codes" list; the input itself is the same codes in a binary form). Everything here is plain functions over files and callbacks:
building a prefix of a block and making its input is the caller's job, handed in as a callback."""
import json, os, re, shutil, signal, subprocess, time
from dataclasses import dataclass
from pathlib import Path

MIB = 1024 * 1024
DEFAULT_MAX_STEPS = 1_000_000_000        # a ceiling: honest blocks measured up to ~380M steps at 30M gas and ~760M at 60M; the cost line binds first
DEFAULT_TIMEOUT = 40.0                   # seconds, for the emulator run
DEFAULT_BUDGET_SECONDS = 120.0           # the proof time a block may be predicted to need
DEFAULT_COST_PER_SECOND = 274_725_275    # cost units of proof work per second: proof_s = cost_total / this + intercept (3.64e-9 s per unit)
DEFAULT_COST_INTERCEPT = 15.0            # seconds
DEFAULT_CUT_SECONDS = 300.0              # the most time one cut may spend searching before it keeps the longest prefix known to fit
DEFAULT_MAX_INPUT_BYTES = 64 * MIB       # the prover's inline limit is 134 MB
DEFAULT_MAX_CODES = 1000                 # the proof still passes at about 1,350 loads of 24 KB codes
DEFAULT_MAX_CODE_BYTES = 24 * MIB
EMULATOR_INPUT_MEMORY = 512 * MIB        # the emulator's own default (128 MiB) is below the guest's real input limit
# The emulator's -X report (ZisK 1.3.1): a line `STEPS   6,752,005`, and under COST DISTRIBUTION a line `TOTAL   1,157,634,907 100.00%`.
STEPS_LINE = re.compile(r"^STEPS:?[ \t]+([\d,]+)[ \t]*$", re.MULTILINE)
COST_LINE = re.compile(r"^TOTAL[ \t]+([\d,]+)[ \t]+100\.00%", re.MULTILINE)
STEP_CAP_MARKER = "EmulationNoCompleted"   # what the emulator says when it stops at the step cap (-n); its report is printed before this
GUEST_MARKERS = ("OOM limit of heap", "Block validation failed", "panicked at")   # what the guest's own failure looks like in the output

# The verdicts. "ok" is the only one that lets a block go to the prover.
OK, COST, STEPS, TIME, INPUT_BYTES, CODES, CODE_BYTES, GUEST, INPUT_TOOL, UNBUILDABLE = (
    "ok", "cost", "steps", "time", "input_bytes", "codes", "code_bytes", "guest", "input_tool", "unbuildable")
WHY = {
    COST: "the predicted proof time is over the proving budget",
    STEPS: "the emulator needs more steps than the proving budget",
    TIME: "the pre-check did not finish in time",
    INPUT_BYTES: "the input is bigger than the proving budget",
    CODES: "the block loads more contract codes than the proving budget",
    CODE_BYTES: "the block loads more contract code bytes than the proving budget",
    GUEST: "the guest program fails on this block",
    INPUT_TOOL: "the input tool cannot make an input of this block",
    UNBUILDABLE: "reth cannot build a block of just these transactions",
}


class PrecheckError(Exception):
    """The pre-check cannot run at all (a missing emulator or guest file): a start-up error, not a verdict."""


class PrecheckFailed(Exception):
    """The emulator did not give a usable answer (it was killed, crashed, or printed nothing readable). A service failure: the caller backs
    off and no transaction is blamed."""


class InputToolFailed(Exception):
    """The input tool refused the block (for example the execution witness is too big). The pre-check counts it as over budget."""


@dataclass(frozen=True)
class Budgets:
    max_steps: int = DEFAULT_MAX_STEPS
    timeout: float = DEFAULT_TIMEOUT
    max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES
    max_codes: int = DEFAULT_MAX_CODES
    max_code_bytes: int = DEFAULT_MAX_CODE_BYTES
    budget_seconds: float = DEFAULT_BUDGET_SECONDS
    cost_per_second: float = DEFAULT_COST_PER_SECOND
    cost_intercept: float = DEFAULT_COST_INTERCEPT

    def predicted_seconds(self, cost_total: int) -> float:
        return cost_total / self.cost_per_second + self.cost_intercept


@dataclass(frozen=True)
class Emulator:
    cmd: str                  # the emulator program (and any fixed arguments), split on spaces
    elf: str                  # the guest ELF, the same file the prover uses
    input_memory: int = EMULATOR_INPUT_MEMORY


@dataclass(frozen=True)
class Precheck:
    """What the builder is configured with when --precheck is on."""
    emu: Emulator
    budgets: Budgets = Budgets()
    max_checks: int = 64   # the most blocks one cut may try, whatever its size, before it keeps the longest prefix known to fit
    max_seconds: float = DEFAULT_CUT_SECONDS   # and the most time it may take


@dataclass
class Verdict:
    verdict: str = OK
    steps: int | None = None
    cost: int | None = None
    predicted: float | None = None
    seconds: float | None = None
    input_bytes: int | None = None
    codes: int | None = None
    code_bytes: int | None = None
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.verdict == OK

    def reason(self) -> str:
        """What the explorer shows for a transaction left out because of this verdict."""
        return "over the proving budget: " + WHY[self.verdict] + (f" ({self.detail})" if self.detail else "")

    def fields(self) -> dict:
        """The journal line's fields."""
        return {"verdict": self.verdict, "steps": self.steps, "cost": self.cost,
                "predictedSeconds": None if self.predicted is None else round(self.predicted, 1), "seconds": None if self.seconds is None else round(self.seconds, 3),
                "inputBytes": self.input_bytes, "codes": self.codes, "codeBytes": self.code_bytes}


@dataclass
class Emulated:
    returncode: int | None    # None: killed at the timeout
    output: str
    seconds: float
    timed_out: bool = False


def check_start(emu: Emulator) -> None:
    """Raises PrecheckError, with what is missing, when the emulator or the guest ELF cannot be found."""
    program = emu.cmd.split()[0] if emu.cmd.split() else ""
    if not program or not (shutil.which(program) or (os.sep in program and os.access(program, os.X_OK))):
        raise PrecheckError(f"--precheck is on, but the emulator {program or '(none)'!r} was not found or is not executable")
    if not Path(emu.elf).is_file():
        raise PrecheckError(f"--precheck is on, but the guest ELF {emu.elf!r} does not exist")


def _kill_group(proc) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def run_emulator(emu: Emulator, input_path: str | Path, timeout: float, max_steps: int) -> Emulated:
    """Runs the emulator (with -X, which prints the steps and the cost; and -n, which stops it one step past `max_steps`) in its own session; at the timeout, or when anything interrupts the wait,
    the whole process group is killed."""
    args = [*emu.cmd.split(), "-e", emu.elf, "-i", str(input_path), "--max-input-mem", str(emu.input_memory), "-n", str(max_steps + 1), "-X"]
    started = time.monotonic()
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=timeout)
        return Emulated(proc.returncode, out or "", time.monotonic() - started)
    except subprocess.TimeoutExpired:
        _kill_group(proc)
        try:   # a helper that left the group and still holds the pipe must not hold the check: drain for a moment, then let go
            proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            for pipe in (proc.stdout, proc.stderr):
                try:
                    pipe and pipe.close()
                except Exception:
                    pass
            proc.wait()
        return Emulated(None, "", time.monotonic() - started, timed_out=True)
    except BaseException:   # an interrupt must not leave the emulator running on its own
        _kill_group(proc)
        try:
            proc.wait(timeout=5)
        except Exception:
            pass
        for pipe in (proc.stdout, proc.stderr):
            try:
                pipe and pipe.close()
            except Exception:
                pass
        raise


def _number(text: str) -> int:
    return int(text.replace(",", "").replace("_", ""))


def parse_steps(output: str) -> int | None:
    m = STEPS_LINE.search(output)
    return _number(m.group(1)) if m else None


def parse_cost(output: str) -> int | None:
    m = COST_LINE.search(output)
    return _number(m.group(1)) if m else None


def code_loads(witness_path: str | Path) -> tuple[int, int]:
    """(distinct codes, their total bytes) from the witness's "codes" list (hex strings, as reth returns them)."""
    codes = json.loads(Path(witness_path).read_bytes()).get("codes") or []
    distinct = {c.removeprefix("0x").lower() for c in codes}
    return len(distinct), sum(len(c) // 2 for c in distinct)


def evaluate(emu: Emulator, budgets: Budgets, input_path: str | Path, witness_path: str | Path) -> Verdict:
    """The five budgets for one block whose input and witness exist. The cheap ones (input bytes, code loads) come first: a block
    over one of them is not emulated."""
    size = Path(input_path).stat().st_size
    n_codes, n_bytes = code_loads(witness_path)
    v = Verdict(input_bytes=size, codes=n_codes, code_bytes=n_bytes)
    if size > budgets.max_input_bytes:
        v.verdict, v.detail = INPUT_BYTES, f"{size} > {budgets.max_input_bytes} bytes"
    elif n_codes > budgets.max_codes:
        v.verdict, v.detail = CODES, f"{n_codes} > {budgets.max_codes}"
    elif n_bytes > budgets.max_code_bytes:
        v.verdict, v.detail = CODE_BYTES, f"{n_bytes} > {budgets.max_code_bytes} bytes"
    if not v.ok:
        return v
    run = run_emulator(emu, input_path, budgets.timeout, budgets.max_steps)
    v.seconds = run.seconds
    if run.timed_out:
        v.verdict, v.detail = TIME, f"over {budgets.timeout:g} s, the emulator was killed"
        return v
    last = (run.output.strip().splitlines() or [""])[-1][:200]
    if run.returncode is not None and run.returncode > 0 and any(m in run.output for m in GUEST_MARKERS):   # the guest's own failure
        v.verdict, v.detail = GUEST, last
        return v
    if run.returncode is not None and run.returncode > 0 and STEP_CAP_MARKER in run.output:   # stopped at the step cap: the report is printed all the same
        v.steps = parse_steps(run.output)
        if v.steps is not None and v.steps > budgets.max_steps:
            v.cost = parse_cost(run.output)
            v.verdict, v.detail = STEPS, f"more than {budgets.max_steps} steps"
            return v
    if run.returncode != 0:   # killed by a signal (the host's out-of-memory killer, say), or the emulator itself failed: not the block's fault
        how = f"killed by signal {-run.returncode}" if run.returncode < 0 else f"exit {run.returncode}"
        raise PrecheckFailed(f"the emulator failed ({how}): {last}")
    v.steps, v.cost = parse_steps(run.output), parse_cost(run.output)
    if v.steps is None or v.cost is None:
        raise PrecheckFailed(f"the emulator's output has no {'steps' if v.steps is None else 'cost'} figure: {last}")
    v.predicted = budgets.predicted_seconds(v.cost)
    if v.steps > budgets.max_steps:
        v.verdict, v.detail = STEPS, f"{v.steps} > {budgets.max_steps}"
    elif v.predicted > budgets.budget_seconds:
        v.verdict, v.detail = COST, f"about {v.predicted:.0f} s > {budgets.budget_seconds:g} s"
    return v


def check_block(emu: Emulator, budgets: Budgets, make_input) -> Verdict:
    """`make_input()` makes the block's input and returns (input path, witness path), or raises InputToolFailed."""
    try:
        input_path, witness_path = make_input()
    except InputToolFailed as e:
        return Verdict(INPUT_TOOL, detail=str(e)[-200:])
    return evaluate(emu, budgets, input_path, witness_path)


@dataclass
class Selection:
    """What fits: `kept` goes into the block, `waiting` returns to the pool for the next block, `convicted` are single
    transactions over budget on their own (each with the verdict that convicted it); `checks` counts the checks made."""
    kept: list
    waiting: list
    convicted: list          # [(transaction, Verdict)]
    checks: int = 0
    exhausted: bool = False  # the limit on checks was reached before the search finished


class _Exhausted(Exception):
    pass


def longest_prefix(n: int, check) -> tuple[int, Verdict | None]:
    """The largest k in [0, n] such that check(k) passes, by halves (k = 0 always fits). `check(k)` judges the first k
    transactions. Returns (k, the verdict of the smallest prefix known not to fit, so of k + 1 transactions or more; None when all
    n fit). When k = 0 and n > 0, that verdict is the first transaction's own."""
    first = check(n)
    if first.ok:
        return n, None
    lo, hi, bad = 0, n, first
    while hi - lo > 1:
        mid = (lo + hi) // 2
        v = check(mid)
        if v.ok:
            lo = mid
        else:
            hi, bad = mid, v
    return lo, bad


def select(txs: list, check, max_checks: int = 64, dependents=None, max_seconds: float | None = None, clock=time.monotonic) -> Selection:
    """Cuts a block back to what fits. `check(list of transactions)` returns a Verdict for a block of exactly those transactions.
    The whole list is checked first; over budget, the longest prefix that fits is found by halves, and the transaction right after it is
    checked alone, unless a kept transaction of the same sender comes before it: over budget on its own, it is convicted (wherever it stands
    in the block); otherwise, or when reth cannot build it alone (verdict UNBUILDABLE), the trouble is the combination and it waits with the rest. When not even the first transaction fits on its own it is convicted (but if reth cannot build the block's first transaction alone, that is reth's fault: PrecheckFailed, nobody blamed), and the search starts again on the
    transactions after it. A pair that is bad only together is cut between them. The search is bounded: at most 2 * log2(n) + 4 checks (and
    `max_checks`), and `max_seconds` for all of it; then the longest prefix known to fit is kept.
    `dependents(convicted transaction, the transactions after it)`, when given, says which of those cannot run without it (the same
    sender's later ones): they wait, and are not tried."""
    selection = Selection([], [], [], 0)
    rest = list(txs)
    stuck: list = []   # waiting for a convicted transaction they depend on
    fit = 0   # the longest prefix of `rest` seen to pass
    limit = min(max_checks, 2 * len(rest).bit_length() + 4)
    started = clock()

    def counted(items: list, prefix: bool = True) -> Verdict:
        nonlocal fit
        if selection.checks >= limit or (max_seconds is not None and clock() - started > max_seconds):
            raise _Exhausted
        selection.checks += 1
        v = check(items)
        if v.ok and prefix:
            fit = max(fit, len(items))
        return v

    def convict(tx, v: Verdict) -> list:
        selection.convicted.append((tx, v))
        return list(dependents(tx, rest[rest.index(tx) + 1:])) if dependents else []

    try:
        while rest:
            fit = 0
            k, bad = longest_prefix(len(rest), lambda m: counted(rest[:m]))
            if k == 0 and bad.verdict == UNBUILDABLE and rest[0] is not txs[0]:   # not the block's first: it may need one that is gone, so it waits
                stuck.append(rest[0])
                rest = rest[1:]
                continue
            if k == 0 and bad.verdict == UNBUILDABLE:   # the block's first: reth just built it first on this parent, so the refusal is reth's
                raise PrecheckFailed(f"reth refused to build the block's first transaction on its own: {bad.detail}")
            if k == 0:
                gone = convict(rest[0], bad)
                stuck += gone
                rest = [t for t in rest[1:] if not any(t is g for g in gone)]
                continue
            kept, later = rest[:k], rest[k:]
            # The transaction after the cut can be tried alone only when it can run on the parent: not when a kept transaction of the same
            # sender comes before it (its nonce is too high alone), and not when reth cannot build it without an earlier one. Then it waits;
            # it is convicted in a later block, if it is the offender, once the earlier ones are mined.
            if later and not (dependents and any(dependents(t, later[:1]) for t in kept)):
                alone = counted([later[0]], prefix=False)
                if not alone.ok and alone.verdict != UNBUILDABLE:   # over budget by itself, though it is not the first: it is the offender, not the block
                    gone = convict(later[0], alone)
                    stuck += gone
                    later = [t for t in later[1:] if not any(t is g for g in gone)]
            selection.kept, selection.waiting = kept, later + stuck
            return selection
    except _Exhausted:
        selection.exhausted = True
        selection.kept, selection.waiting = rest[:fit], [t for t in rest[fit:] if not any(t is c for c, _ in selection.convicted)] + stuck
    else:
        selection.waiting = stuck
    return selection
