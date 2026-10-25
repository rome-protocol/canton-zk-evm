"""The golden record of the producer at depth 1 (one block in flight): nine scenarios are replayed on the builder, and every call to the
fakes (reth's WebSocket and Engine ports, the Canton JSON Ledger API, the prover and its input tool), in order, with the journal's lines and
the producer's reports, is compared with a fixture in golden/. See golden/README.md for how to regenerate the fixtures and when they may change.
Run: python3 -m unittest discover -s builder/tests"""
import contextlib, json, os, re, sys
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from test_producer import Loop
from fakes import HEAD_NUMBER, JWT_SECRET, tx

WALL_CLOCK = 1_900_000_000.0   # what time.time() says during a scenario, so that the block timestamps, and with them every block hash, are the same on every run
GOLDEN = HERE / "golden"
REGENERATE = os.environ.get("GOLDEN_REGENERATE") == "1"

# The one place that lists what is left out of the comparison because it differs from run to run. A key named here keeps its place in the
# record and its value becomes "<key>": the record still shows that the field was there. Nothing else is ignored.
VOLATILE_KEYS = {
    "seconds",           # how long a step took (journal lines)
    "proveSeconds", "advanceSeconds",   # how long the prover and Advance took (reports)
    "source_commit",     # the git commit the builder runs from (the run_started journal line)
}
VOLATILE_PATTERNS = [   # text that differs from run to run, inside any string
    (re.compile(r"/out-\d+-\d+"), "/out-<pid>-<ns>"),   # the prover's output folder: the process id and the wall clock in nanoseconds
]
# The test's own temporary folder is replaced by "<dir>" in every string (see clean()): it is different in every run.


class Tee(list):
    """A list the fakes append their calls to, which also puts each one in the shared record, so the calls of all the fakes are in one order."""

    def __init__(self, record, source, shape):
        super().__init__()
        self.record, self.source, self.shape = record, source, shape

    def append(self, item):
        super().append(item)
        self.record.append([self.source, *self.shape(item)])


def clean(value, folder: str):
    """The value with the volatile fields named above and this run's temporary folder taken out, as JSON-able data."""
    if isinstance(value, dict):
        return {k: (f"<{k}>" if k in VOLATILE_KEYS else clean(v, folder)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v, folder) for v in value]
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, str):
        value = value.replace(folder, "<dir>")
        for pattern, name in VOLATILE_PATTERNS:
            value = pattern.sub(name, value)
    return value


class Golden(Loop):
    maxDiff = None

    def tearDown(self):
        os.environ["FAKE_PROVER_FAILS"] = ""

    def start(self, pool, **k):
        """A setup whose fakes write every call to `self.calls`."""
        s = self.setup(pool, **k)
        self.calls = []
        r, l = s.reth, s.ledger
        r.ws_calls = Tee(self.calls, "reth", lambda c: c)
        r.engine_calls = Tee(self.calls, "engine", lambda c: c)
        l.submitted = Tee(self.calls, "ledger", lambda body: ["submit-and-wait", body])
        l.queries = Tee(self.calls, "ledger", lambda body: ["active-contracts", body])
        l.gets = Tee(self.calls, "ledger", lambda path: ["get", path])   # the ledger end before each read of the contracts, and /traffic
        l.completion_queries = Tee(self.calls, "ledger", lambda c: ["completions", *c])
        real_run = b.run
        def run(cmd, *args):   # the prover's input tool and the prover itself
            self.calls.append(["prover", Path(cmd).name, *args])
            return real_run(cmd, *args)
        patch = mock.patch.object(b, "run", run)
        patch.start()
        self.addCleanup(patch.stop)
        self.runs = 0
        patch = mock.patch.object(b.time, "time", lambda: WALL_CLOCK)
        patch.start()
        self.addCleanup(patch.stop)
        return s

    def process(self, s, **k):
        """A producer, as a new process would start it: a fresh run id for the journal, a fixed one for the fixture."""
        self.runs += 1
        journal = b.Journal(Path(s.cfg.work_dir) / "journal", run_id=f"run-{self.runs}", clock=lambda: self.now[0])
        return self.producer(s, journal=journal, **k)

    def journal_lines(self, s):
        folder = Path(s.cfg.work_dir) / "journal"
        return [json.loads(line) for f in sorted(folder.glob("*.jsonl")) for line in f.read_text().splitlines()]

    def record(self, s):
        folder = s.dir
        return {"calls": clean(self.calls, folder), "journal": clean(self.journal_lines(s), folder), "reports": clean(self.reports, folder)}

    def check(self, name, s):
        got = self.record(s)
        path = GOLDEN / f"{name}.json"
        if REGENERATE:
            path.write_text(json.dumps(got, indent=1, sort_keys=True) + "\n")
            return
        self.assertTrue(path.exists(), f"no fixture {path.name}: run with GOLDEN_REGENERATE=1 (golden/README.md)")
        want = json.loads(path.read_text())
        for part in ("calls", "journal", "reports"):
            g, w = got[part], want[part]
            if g != w:
                i = next((i for i in range(min(len(g), len(w))) if g[i] != w[i]), min(len(g), len(w)))
                self.fail(f"{name}: the {part} differ from golden/{path.name} at entry {i} (got {len(g)} entries, want {len(w)})\n"
                          f"want: {json.dumps(w[i]) if i < len(w) else '(none)'}\ngot:  {json.dumps(g[i]) if i < len(g) else '(none)'}")

    def run_steps(self, p, *between):
        """The producer's own run(), as a process starts it: run_started, load_unresolved, write_status, then steps. It does len(between) + 1 steps;
        `between[i]` runs before step i + 2. Then it stops, and run_stopped is written."""
        real, n = p.step, [0]
        def step():
            if n[0]:
                between[n[0] - 1]()
            n[0] += 1
            real()
            if n[0] > len(between):
                self.stop.set()
        with mock.patch.object(p, "step", step):
            p.run()

    # The scenarios.

    def test_commit(self):
        s = self.start({tb.ALICE: [tx(tb.ALICE, 0)], tb.BOB: [tx(tb.BOB, 0, price=5)]}, terms=[tb.TERMS])
        s.reth.tx_legs[s.reth.pool[tb.BOB][0]["hash"]] = [tb.PAY]
        p = self.process(s)
        p.step()
        p.step()   # the pool is empty again
        self.assertTrue(self.reports[0]["committed"])
        self.check("commit", s)

    def test_refusal(self):
        s = self.start({tb.ALICE: [tx(tb.ALICE, 0)]}, refuse="no")
        p = self.process(s)
        p.step()
        s.ledger.refuse = None
        self.now[0] += 60; p.step()
        self.assertEqual([r["committed"] for r in self.reports], [False, True])
        self.check("refusal", s)

    def test_not_taken(self):
        s = self.start({tb.ALICE: [tx(tb.ALICE, 0)]})
        s.ledger.reply_status = 429   # back-pressure: the command never reached the participant
        p = self.process(s)
        p.step()
        s.ledger.reply_status = None
        self.now[0] += 60; p.step()
        self.assertEqual([r["committed"] for r in self.reports], [False, True])
        self.check("not_taken", s)

    def test_unknown_then_committed(self):
        s = self.start({tb.ALICE: [tx(tb.ALICE, 0)]}, drop_but_commit=True)
        s.ledger.no_completion = True
        p = self.process(s)
        p.step()
        s.ledger.no_completion, s.ledger.drop_but_commit = False, False
        p.step()   # finds out
        s.reth.pool[tb.ALICE] = [tx(tb.ALICE, 1)]
        p.step()
        self.assertEqual([r.get("committed", r.get("resolved")) for r in self.reports], [None, "committed", True])
        self.check("unknown_then_committed", s)

    def test_unknown_then_not_committed_by_the_window(self):
        s = self.start({tb.ALICE: [tx(tb.ALICE, 0)]}, drop_but_commit=True)
        s.ledger.no_completion, s.ledger.commit = True, False
        p = self.process(s)
        p.step()
        self.now[0] += 10_000
        p.step()   # still waiting: Canton's time is not past the window
        s.ledger.record_time = "2100-01-01T00:00:00.000000Z"
        with mock.patch.object(b, "builder_now", lambda: 4102444800.0):
            p.step()
        s.ledger.drop_but_commit, s.ledger.commit, s.ledger.no_completion = False, True, False
        p.step()
        self.assertEqual([r.get("committed", r.get("resolved")) for r in self.reports], [None, "not committed", True])
        self.check("unknown_then_not_committed_by_the_window", s)

    def test_prover_failure(self):
        s = self.start({tb.ALICE: [tx(tb.ALICE, 0)]}, prover_fails=True)
        p = self.process(s)
        p.step()
        os.environ["FAKE_PROVER_FAILS"] = ""
        self.now[0] += 60; p.step()
        self.assertEqual([r["committed"] for r in self.reports], [False, True])
        self.check("prover_failure", s)

    def test_skipped_a_leg_with_no_canton_side(self):
        t = tx(tb.BOB, 0)
        s = self.start({tb.BOB: [t]})   # no terms: the payment leg has no Canton side
        s.reth.tx_legs[t["hash"]] = [tb.PAY]
        p = self.process(s)
        p.step()
        self.assertTrue(self.reports[0]["skipped"])
        s.ledger.terms.append(tb.TERMS)
        self.now[0] += 2.1; p.step()
        self.assertTrue(self.reports[-1]["committed"])
        self.check("skipped", s)

    def test_restart_with_a_kept_file(self):
        a, c = tx(tb.ALICE, 0), tx(tb.BOB, 0, price=5)
        s = self.start({tb.ALICE: [a], tb.BOB: [c]})
        with b.connect(s.cfg.ws_url, max_size=None) as ws:   # what a crash in the middle of a block leaves: the block built and kept, the builder gone
            reth = b.Reth(s.cfg, ws)
            chain = b.Ledger(s.cfg).head()
            head = "0x" + chain["headHash"]
            reth.forkchoice(head, head, head)
            b.build_and_import(s.cfg, reth, chain, head, set())
        self.assertTrue(b.saved_path(s.cfg).exists())
        p = self.process(s)   # a new process
        self.run_steps(p)
        self.assertEqual(self.reports[0]["recovered"], 2)
        self.check("restart_with_a_kept_file", s)

    def test_restart_with_a_record(self):
        s = self.start({tb.ALICE: [tx(tb.ALICE, 0)]})
        s.ledger.late = True   # the Advance times out and commits only later
        first = self.process(s)
        first.step()
        second = self.process(s)   # a new process: it knows the command from the work folder
        def land():
            s.ledger.land(ok=True)
            s.ledger.late = False
        self.run_steps(second, land)   # the first step finds no completion yet
        self.assertEqual(self.reports[-1]["resolved"], "committed")
        self.check("restart_with_a_record", s)
