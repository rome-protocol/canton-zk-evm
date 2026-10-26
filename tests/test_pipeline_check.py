"""tests/pipeline_check.py on the builder's golden journals and on journals that break each rule."""
import json, os, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
import pipeline_check as pc

GOLDEN = Path(__file__).resolve().parent.parent / "builder" / "tests" / "golden"


def golden(name):
    return json.loads((GOLDEN / f"{name}.json").read_text())["journal"]


def attempt(n, att, t, txs, outcome="committed", run="r", number=None, final=True, resolution=None, proof="ok"):
    ln = lambda event, sec, **kw: {"v": 1, "run": run, "seq": 0, "time": f"2026-01-01T00:00:{sec:02d}.000Z", "event": event, "attempt": att, **kw}
    out = [ln("cut", t, number=n), ln("built", t, block_hash=f"0x{n:02x}{att:02x}", tx_hashes=txs), ln("proof_ended", t, outcome=proof),
           ln("submitted", t + 1, command_id=f"c{att}")]
    if outcome:
        out.append(ln("answered", t + 2, outcome=outcome))
    if resolution:
        out.append(ln("resolved", t + 5, outcome=resolution))
    if final and (outcome == "committed" or resolution == "committed"):
        out.append(ln("final_seen", t + 6, number=n))
    return out


class Golden(unittest.TestCase):
    def test_commit_and_unknown_then_committed_are_clean(self):
        for name in ("commit", "unknown_then_committed"):
            self.assertEqual(pc.check_journal(golden(name)), [], name)

    def test_refusal_is_clean(self):
        self.assertEqual(pc.check_journal(golden("refusal")), [])


class Rules(unittest.TestCase):
    def test_a_good_run_with_a_refusal_and_a_retry(self):
        lines = attempt(2, 1, 0, ["0xa"]) + attempt(3, 2, 10, ["0xb"], outcome="refused", final=False) + attempt(3, 3, 20, ["0xb"]) + attempt(4, 4, 30, ["0xc"])
        self.assertEqual(pc.check_journal(lines, sent=["0xA", "0xb", "0xc"]), [])
        self.assertEqual(pc.stats(lines)["refused"], 1)

    def test_a_height_committed_twice_and_a_gap(self):
        lines = attempt(2, 1, 0, ["0xa"]) + attempt(2, 2, 10, ["0xb"]) + attempt(5, 3, 20, ["0xc"])
        bad = "\n".join(pc.check_journal(lines))
        self.assertIn("height 2 was committed 2 times", bad)
        self.assertIn("gap", bad)
        self.assertIn("submitted again", bad)

    def test_a_height_submitted_while_in_doubt(self):
        lines = attempt(2, 1, 0, ["0xa"], outcome="unknown", resolution="not committed") + attempt(2, 2, 2, ["0xb"], outcome="refused", final=False)
        self.assertIn("still in doubt", "\n".join(pc.check_journal(lines)))

    def test_the_next_height_before_the_doubt_ends(self):
        lines = attempt(2, 1, 0, ["0xa"], outcome="unknown", resolution="committed") + attempt(3, 2, 2, ["0xb"])
        self.assertIn("was in doubt", "\n".join(pc.check_journal(lines)))
        lines = attempt(2, 1, 0, ["0xa"], outcome="unknown", resolution="committed") + attempt(3, 2, 10, ["0xb"])
        self.assertEqual(pc.check_journal(lines), [])

    def test_lost_not_final_missing_and_short(self):
        lines = attempt(2, 1, 0, ["0xa"], final=False) + [{"v": 1, "run": "r", "seq": 9, "time": "2026-01-01T00:01:00.000Z", "event": "lost", "transactions": [{"hash": "0xz"}]}]
        bad = "\n".join(pc.check_journal(lines, sent=["0xa", "0xq"], blocks=5))
        for part in ("never seen final", "named lost", "1 of 2 sent", "only 1 blocks"):
            self.assertIn(part, bad)

    def test_a_cancelled_attempt_counts_when_it_was_proven(self):
        cancelled = attempt(3, 2, 10, ["0xb"], outcome=None, final=False) + [{"v": 1, "run": "r", "seq": 0, "time": "2026-01-01T00:00:13.000Z", "event": "cancelled", "attempt": 2, "number": 3, "depends_on": 1}]
        lines = attempt(2, 1, 0, ["0xa"], outcome="refused", final=False) + cancelled
        s = pc.stats(lines, {"0x0302"[2:]: "2026-01-01T00:00:12.000Z"})   # the prover finished block 3's proof a second before it was dropped
        self.assertEqual((s["cancelled"], s["cancelledProven"], s["refused"]), (1, 1, 1))
        self.assertEqual(pc.stats(lines, {"0x0302"[2:]: "2026-01-01T00:00:14.000Z"})["cancelledProven"], 0)   # after the drop: not proven then
        self.assertEqual(pc.stats(lines)["cancelledProven"], 0)

    def test_the_depth_of_an_unwind_and_what_is_in_flight(self):
        gone = lambda att, n, dep: [{"v": 1, "run": "r", "seq": 0, "time": "2026-01-01T00:00:13.000Z", "event": "cancelled", "attempt": att, "number": n, "depends_on": dep}]
        lines = (attempt(2, 1, 0, ["0xa"], outcome="refused", final=False) + attempt(3, 2, 1, ["0xb"], outcome=None, final=False) + gone(2, 3, 1)
                 + attempt(4, 3, 2, ["0xc"], outcome=None, final=False) + gone(3, 4, 2) + attempt(5, 4, 20, ["0xd"], outcome=None, final=False))
        s = pc.stats(lines)
        self.assertEqual((s["unwind"], s["cancelled"], s["refused"]), (3, 2, 1))
        self.assertEqual(s["inFlight"], 1)   # only the block made last is neither final, nor cancelled, nor refused
        self.assertEqual(pc.stats(attempt(2, 1, 0, ["0xa"]))["unwind"], 0)
        again = attempt(2, 1, 0, ["0xa"], outcome=None, final=False, run="old") + [{"v": 1, "run": "new", "seq": 0, "time": "2026-01-01T00:01:00.000Z", "event": "resolved", "attempt": 1, "attempt_run": "old", "outcome": "restarted"}]
        self.assertEqual((pc.stats(again)["restarted"], pc.stats(again)["inFlight"]), (1, 0))

    def test_reads_a_folder_and_skips_a_cut_line(self):
        with tempfile.TemporaryDirectory() as d:
            lines = attempt(2, 1, 0, ["0xa"])
            Path(d, "2026-01-01.jsonl").write_text("\n".join(json.dumps(x) for x in lines) + '\n{"event":"cu')
            self.assertEqual(len(pc.read_journal(d)), len(lines))


class Chain(unittest.TestCase):
    """check_chain against a reth that is a dict."""
    def run_chain(self, blocks, receipts, finalized, lines, sent):
        def batch(method, params_list, size=100):
            table = blocks if method == "eth_getBlockByNumber" else receipts
            return [table.get(p[0]) for p in params_list]
        pc.reth_batch, pc.reth = batch, lambda method, params: {"number": hex(finalized)}
        return pc.check_chain(lines, sent)

    def test_agreement_and_each_disagreement(self):
        lines = attempt(2, 1, 0, ["0xaa"])   # built hash 0x0201
        good_block, good_receipt = {"0x2": {"hash": "0x0201"}}, {"0xaa": {"blockNumber": "0x2", "blockHash": "0x0201"}}
        self.assertEqual(self.run_chain(good_block, good_receipt, 2, lines, ["0xaa"]), [])
        self.assertIn("reth's block is 0x9999", "\n".join(self.run_chain({"0x2": {"hash": "0x9999"}}, good_receipt, 2, lines, ["0xaa"])))
        self.assertIn("above reth's finalized", "\n".join(self.run_chain(good_block, good_receipt, 1, lines, ["0xaa"])))
        self.assertIn("no receipt", "\n".join(self.run_chain(good_block, {}, 2, lines, ["0xaa"])))


if __name__ == "__main__":
    unittest.main()
