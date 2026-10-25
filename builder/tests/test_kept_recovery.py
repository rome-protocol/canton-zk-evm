"""Recovery with several blocks kept: an in-doubt command settles by its own id, the blocks above it are sent again, and every abandoned
attempt is closed. Run: python3 -m unittest discover -s builder/tests"""
import json, sys, threading, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import HEAD_HASH, HEAD_NUMBER, raw_of, tx

ALICE, BOB = tb.ALICE, tb.BOB
N = HEAD_NUMBER + 1


class Recovery(tb.Case):
    def producer(self, s):
        self.now = [1_000_000.0]
        return b.Producer(s.cfg, threading.Event(), idle=0.5, status_file=str(Path(s.dir) / "status.json"), emit=lambda r: None,
                          clock=lambda: self.now[0], wait=lambda seconds: False)

    def journal(self, s, *names):
        folder = Path(s.cfg.work_dir) / "journal"
        lines = [json.loads(l) for f in sorted(folder.glob("*.jsonl")) for l in f.read_text().splitlines()] if folder.exists() else []
        return [l for l in lines if l["event"] in names]

    def in_doubt(self, extra_ref=("old-run", 7)):
        """Block N is in doubt (its Advance had no answer, made by the first producer's attempt 1) and block N+1's transaction is kept, made
        by an attempt of an older run. Returns the setup, the first producer and the transaction of N+1."""
        t1, t2 = tx(ALICE, 0), tx(BOB, 0)
        s = self.setup({ALICE: [t1]})
        s.reth.mined[t2["hash"]] = t2   # reth knows it, so that it can be sent again
        s.ledger.late = True
        first = self.producer(s)
        first.step()
        self.assertTrue(b.unresolved_path(s.cfg).exists())
        entries = json.loads(b.saved_path(s.cfg).read_text())
        self.assertEqual({e["number"] for e in entries}, {N})
        entries.append({"hash": t2["hash"], "raw": raw_of(t2), "number": N + 1, "run": extra_ref[0], "attempt": extra_ref[1]})
        b.saved_path(s.cfg).write_text(json.dumps(entries))
        return s, first, t1, t2

    def closed(self, s, run):
        return sorted(((l["attempt_run"], l["attempt"], l["outcome"]) for l in self.journal(s, "resolved") if l["run"] == run), key=lambda r: r[1:] != (7, "restarted"))

    def test_restart_where_the_command_committed_keeps_the_tip_and_closes_both_attempts(self):
        s, first, t1, t2 = self.in_doubt()
        second = self.producer(s)
        second.load_unresolved()
        s.ledger.land(ok=True)
        second.step()   # N is settled first, by its command id
        self.assertEqual([e["number"] for e in json.loads(b.saved_path(s.cfg).read_text())], [N + 1])   # only N's entries went
        self.assertEqual(self.in_pool(s), set())
        second.restore()   # reth moves to Canton's head and the block above it is sent again
        self.assertEqual(self.in_pool(s), {t2["hash"]})
        self.assertFalse(b.saved_path(s.cfg).exists())
        self.assertEqual(self.closed(s, second.journal.run_id),
                         [("old-run", 7, "restarted"), (first.journal.run_id, 1, "committed")])
        head = s.forkchoices()[-1]
        self.assertEqual(head["headBlockHash"], head["finalizedBlockHash"])

    def test_restart_where_the_command_failed_sends_the_whole_union_in_block_order_and_closes_both_attempts(self):
        s, first, t1, t2 = self.in_doubt()
        second = self.producer(s)
        second.load_unresolved()
        s.ledger.land(ok=False)
        second.step()
        self.assertEqual(self.in_pool(s), {t1["hash"], t2["hash"]})
        self.assertFalse(b.saved_path(s.cfg).exists())
        self.assertFalse(b.unresolved_path(s.cfg).exists())
        self.assertEqual(self.closed(s, second.journal.run_id),
                         [("old-run", 7, "restarted"), (first.journal.run_id, 1, "not committed")])
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)

    def test_the_union_is_sent_in_block_order_whatever_the_order_in_the_file(self):
        s, first, t1, t2 = self.in_doubt()
        entries = json.loads(b.saved_path(s.cfg).read_text())
        b.saved_path(s.cfg).write_text(json.dumps(list(reversed(entries))))   # block N+1's entry first
        s.ledger.land(ok=False)
        sent = []
        real = b.resend
        b.resend = lambda reth, pairs: (sent.extend(h for h, _ in pairs), real(reth, pairs))[1]
        self.addCleanup(setattr, b, "resend", real)
        result = b.recover_saved(s.cfg)
        self.assertEqual(sent, [t1["hash"], t2["hash"]])
        self.assertEqual(result["settled"]["committed"], False)

    def test_recover_saved_closes_the_attempts_before_it_clears_the_file(self):
        s, first, t1, t2 = self.in_doubt()
        s.ledger.land(ok=True)
        seen = []
        def close(refs):
            seen.append((list(refs), b.saved_path(s.cfg).exists()))
        found = b.recover_saved(s.cfg, close=close)   # settles N as committed, then sends the block above it again
        self.assertEqual(seen, [([("old-run", 7)], True)])   # N's own attempt is for the settle step; the file was still there
        self.assertEqual((found["recovered"], found["attempts"]), (1, [{"run": "old-run", "attempt": 7}]))
        self.assertEqual(self.in_pool(s), {t2["hash"]})
        self.assertFalse(b.saved_path(s.cfg).exists())

    def test_a_tip_the_record_names_stays_the_head_and_only_the_block_is_made_final(self):
        s, first, t1, t2 = self.in_doubt()
        s.ledger.land(ok=True)
        u = {**json.loads(b.unresolved_path(s.cfg).read_text()), "tip": HEAD_HASH}
        u["since"] = u["submittedAt"]
        committed, _, _, _ = b.resolve_unknown(s.cfg, u, b.read_saved(s.cfg) or [])
        self.assertTrue(committed)
        call = s.forkchoices()[-1]
        self.assertEqual((call["headBlockHash"], call["finalizedBlockHash"]), (HEAD_HASH, u["hash"]))
        self.assertEqual([e["number"] for e in json.loads(b.saved_path(s.cfg).read_text())], [N + 1])

    def test_an_empty_rebuild_on_the_tip_leaves_the_union_and_a_restart_recovers_the_other_blocks_transactions(self):
        t1 = tx(ALICE, 0)
        s = self.setup({})   # an empty pool: the rebuild holds nothing
        s.reth.mined[t1["hash"]] = t1
        b.save_kept(s.cfg, [(t1["hash"], raw_of(t1))], number=N - 1)
        b.save_kept(s.cfg, [("0xold", "0x00")], number=N)   # an earlier copy of the rebuilt block
        from websockets.sync.client import connect
        ws = connect(s.cfg.ws_url, max_size=None)
        self.addCleanup(ws.close)
        reth = b.Reth(s.cfg, ws)
        reth.forkchoice(HEAD_HASH, HEAD_HASH, HEAD_HASH)
        b.build(s.cfg, reth, b.Ledger(s.cfg).head(), HEAD_HASH, set())
        self.assertEqual([e["number"] for e in json.loads(b.saved_path(s.cfg).read_text())], [N - 1])
        found = b.recover_saved(s.cfg)
        self.assertEqual((found["recovered"], self.in_pool(s)), (1, {t1["hash"]}))


class ReadSaved(tb.Case):
    def test_a_block_or_the_blocks_above_it_can_be_read(self):
        s = self.setup({})
        for n, h in ((5, "0xa"), (6, "0xb"), (7, "0xc")):
            b.save_kept(s.cfg, [(h, "0x" + h[2:] * 2)], number=n)
        self.assertEqual(b.read_saved(s.cfg, number=6), [("0xb", "0xbb")])
        self.assertEqual(b.read_saved(s.cfg, above=5), [("0xb", "0xbb"), ("0xc", "0xcc")])
        self.assertEqual(b.read_saved(s.cfg, above=7), [])
        b.saved_path(s.cfg).write_text(json.dumps([{"hash": "0xa", "raw": "0x01"}]))   # an older file: the block's own, never above anything
        self.assertEqual((b.read_saved(s.cfg, number=9), b.read_saved(s.cfg, above=1)), ([("0xa", "0x01")], []))


if __name__ == "__main__":
    unittest.main()
