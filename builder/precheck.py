"""The pre-check: before a block is proven, run the fast ZisK emulator on its input and keep the block within five budgets.

  1. emulator steps                    <= max_steps
  2. the check's own wall time         <= timeout (over: the emulator's process group is killed)
  3. input size in bytes               <= max_input_bytes
  4. distinct contract codes loaded    <= max_codes, and their total bytes <= max_code_bytes
  5. an input tool that fails, or a guest that aborts or fails in the emulator, counts as over budget.

The check bounds a block, it does not predict its proof time. The code loads are read from the witness the input tool was given
(its "codes" list; the input itself is the same codes in a binary form). Everything here is plain functions over files and callbacks:
building a prefix of a block and making its input is the caller's job, handed in as a callback."""
import json, os, re, shutil, signal, subprocess, time
from dataclasses import dataclass
from pathlib import Path

MIB = 1024 * 1024
DEFAULT_MAX_STEPS = 233_000_000          # 120 s of proof at the worst measured cost per step
DEFAULT_TIMEOUT = 20.0                   # seconds, for the check itself
DEFAULT_MAX_INPUT_BYTES = 64 * MIB       # the prover's inline limit is 134 MB
DEFAULT_MAX_CODES = 1000                 # the proof still passes at about 1,350 loads of 24 KB codes
DEFAULT_MAX_CODE_BYTES = 24 * MIB
EMULATOR_INPUT_MEMORY = 512 * MIB        # the emulator's own default (128 MiB) is below the guest's real input limit
STEPS_LINE = re.compile(r"STEPS:\s*([\d,]+)")

# The verdicts. "ok" is the only one that lets a block go to the prover.
OK, STEPS, TIME, INPUT_BYTES, CODES, CODE_BYTES, GUEST, INPUT_TOOL = (
    "ok", "steps", "time", "input_bytes", "codes", "code_bytes", "guest", "input_tool")
WHY = {
    STEPS: "the emulator needs more steps than the proving budget",
    TIME: "the pre-check did not finish in time",
    INPUT_BYTES: "the input is bigger than the proving budget",
    CODES: "the block loads more contract codes than the proving budget",
    CODE_BYTES: "the block loads more contract code bytes than the proving budget",
    GUEST: "the guest program fails on this block",
    INPUT_TOOL: "the input tool cannot make an input of this block",
}


class PrecheckError(Exception):
    """The pre-check cannot run at all (a missing emulator or guest file): a start-up error, not a verdict."""


class InputToolFailed(Exception):
    """The input tool refused the block (for example the execution witness is too big). The pre-check counts it as over budget."""


@dataclass(frozen=True)
class Budgets:
    max_steps: int = DEFAULT_MAX_STEPS
    timeout: float = DEFAULT_TIMEOUT
    max_input_bytes: int = DEFAULT_MAX_INPUT_BYTES
    max_codes: int = DEFAULT_MAX_CODES
    max_code_bytes: int = DEFAULT_MAX_CODE_BYTES


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
    max_checks: int = 64   # the most blocks one cut may try before it keeps the longest prefix known to fit


@dataclass
class Verdict:
    verdict: str = OK
    steps: int | None = None
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
        return {"verdict": self.verdict, "steps": self.steps, "seconds": None if self.seconds is None else round(self.seconds, 3),
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


def run_emulator(emu: Emulator, input_path: str | Path, timeout: float) -> Emulated:
    """Runs the fast emulator in its own session; at the timeout the whole process group is killed."""
    args = [*emu.cmd.split(), "-e", emu.elf, "-i", str(input_path), "--max-input-mem", str(emu.input_memory), "--steps"]
    started = time.monotonic()
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, start_new_session=True)
    try:
        out, _ = proc.communicate(timeout=timeout)
        return Emulated(proc.returncode, out or "", time.monotonic() - started)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
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


def parse_steps(output: str) -> int | None:
    m = STEPS_LINE.search(output)
    return int(m.group(1).replace(",", "")) if m else None


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
    run = run_emulator(emu, input_path, budgets.timeout)
    v.seconds = run.seconds
    if run.timed_out:
        v.verdict, v.detail = TIME, f"over {budgets.timeout:g} s, the emulator was killed"
        return v
    v.steps = parse_steps(run.output)
    if run.returncode != 0 or v.steps is None:
        v.verdict, v.detail = GUEST, (run.output.strip().splitlines() or [f"exit {run.returncode}"])[-1][:200]
    elif v.steps > budgets.max_steps:
        v.verdict, v.detail = STEPS, f"{v.steps} > {budgets.max_steps}"
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


def select(txs: list, check, max_checks: int = 64, dependents=None) -> Selection:
    """Cuts a block back to what fits. `check(list of transactions)` returns a Verdict for a block of exactly those transactions.
    The whole list is checked first; over budget, the longest prefix that fits is found by halves and the rest wait. When not even
    the first transaction fits on its own it is convicted, and the search starts again on the transactions after it. A pair that
    is bad only together is cut between them. After `max_checks` checks the search stops: the longest prefix known to fit is kept.
    `dependents(convicted transaction, the transactions after it)`, when given, says which of those cannot run without it (the same
    sender's later ones): they wait, and are not tried."""
    selection = Selection([], [], [], 0)
    rest = list(txs)
    stuck: list = []   # waiting for a convicted transaction they depend on
    fit = 0   # the longest prefix of `rest` seen to pass

    def counted(items: list) -> Verdict:
        nonlocal fit
        if selection.checks >= max_checks:
            raise _Exhausted
        selection.checks += 1
        v = check(items)
        if v.ok:
            fit = max(fit, len(items))
        return v

    try:
        while rest:
            fit = 0
            k, bad = longest_prefix(len(rest), lambda m: counted(rest[:m]))
            if k > 0:
                selection.kept, selection.waiting = rest[:k], rest[k:] + stuck
                return selection
            selection.convicted.append((rest[0], bad))
            gone = list(dependents(rest[0], rest[1:])) if dependents else []
            stuck += gone
            rest = [t for t in rest[1:] if not any(t is g for g in gone)]
    except _Exhausted:
        selection.exhausted = True
        selection.kept, selection.waiting = rest[:fit], rest[fit:] + stuck
    else:
        selection.waiting = stuck
    return selection
