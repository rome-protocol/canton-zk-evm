"""Recovery with several blocks kept: an in-doubt command settles by its own id, the blocks above it are sent again, and every abandoned
attempt is closed. Run: python3 -m unittest discover -s builder/tests"""
import contextlib, errno, json, sys, threading, unittest
from unittest import mock
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
        u = json.loads(b.unresolved_path(s.cfg).read_text())
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
        self.assertEqual(head["finalizedBlockHash"], "0x" + s.ledger.head["headHash"])   # Canton's head, which is block N
        self.assertEqual(head["finalizedBlockHash"], u["hash"])

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
        block = json.loads(b.unresolved_path(s.cfg).read_text())["hash"]
        found = b.recover_saved(s.cfg, close=close)   # settles N as committed, then sends the block above it again
        self.assertEqual(seen, [([("old-run", 7)], True)])   # N's own attempt is for the settle step; the file was still there
        self.assertEqual((found["recovered"], found["attempts"]), (1, [{"run": "old-run", "attempt": 7}]))
        self.assertEqual((found["settled"]["committed"], found["settled"]["blockHash"], found["lostTransactions"]), (True, block, []))
        self.assertEqual(self.in_pool(s), {t2["hash"]})
        self.assertFalse(b.saved_path(s.cfg).exists())

    def test_a_tip_the_record_names_stays_the_head_and_only_the_block_is_made_final(self):
        s, first, t1, t2 = self.in_doubt()
        s.ledger.land(ok=True)
        tip = "0x" + "cd" * 32   # a block above N, as the loop's tip would be
        s.reth.blocks[tip] = {"number": N + 1, "timestamp": 0, "gasLimit": 30_000_000, "parent": json.loads(b.unresolved_path(s.cfg).read_text())["hash"]}
        u = {**json.loads(b.unresolved_path(s.cfg).read_text()), "tip": tip}
        u["since"] = u["submittedAt"]
        committed, _, _, _ = b.resolve_unknown(s.cfg, u, b.read_saved(s.cfg) or [])
        self.assertTrue(committed)
        call = s.forkchoices()[-1]
        self.assertEqual((call["headBlockHash"], call["finalizedBlockHash"]), (tip, u["hash"]))
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

    def restart_with_file(self, s, entries, *record):
        """A new producer on a kept file made by earlier runs. Returns it and the list of (attempts closed, file still there) pairs."""
        b.saved_path(s.cfg).parent.mkdir(parents=True, exist_ok=True)
        b.saved_path(s.cfg).write_text(json.dumps(entries))
        p = self.producer(s)
        seen, real = [], p.close_attempts
        def close(refs):
            seen.append((list(refs), b.saved_path(s.cfg).exists()))
            real(refs)
        p.close_attempts = close
        return p, seen

    def test_a_restart_with_no_record_closes_every_attempt_the_file_names_while_the_file_exists(self):
        t1, t2 = tx(ALICE, 0), tx(BOB, 0)
        s = self.setup({})
        s.reth.mined.update({t1["hash"]: t1, t2["hash"]: t2})
        p, seen = self.restart_with_file(s, [
            {"hash": t1["hash"], "raw": raw_of(t1), "number": N, "run": "run-a", "attempt": 3},
            {"hash": t2["hash"], "raw": raw_of(t2), "number": N + 1, "run": "run-a", "attempt": 4}])
        p.restore()
        self.assertEqual(self.in_pool(s), {t1["hash"], t2["hash"]})
        self.assertEqual(seen, [([("run-a", 3), ("run-a", 4)], True)])
        lines = [(l["attempt_run"], l["attempt"], l["outcome"]) for l in self.journal(s, "resolved")]
        self.assertEqual(lines, [("run-a", 3, "restarted"), ("run-a", 4, "restarted")])
        self.assertFalse(b.saved_path(s.cfg).exists())

    def test_a_restart_with_no_record_sends_the_entries_in_block_order(self):
        s = self.setup({})
        entries = [{"hash": "0xc", "raw": "0x03", "number": N + 2}, {"hash": "0xa", "raw": "0x01", "number": N},
                   {"hash": "0xb", "raw": "0x02", "number": N + 1}, {"hash": "0xd", "raw": "0x04", "number": N}]
        b.saved_path(s.cfg).parent.mkdir(parents=True, exist_ok=True)
        b.saved_path(s.cfg).write_text(json.dumps(entries))
        sent = []
        with mock.patch.object(b, "resend", lambda reth, pairs: sent.extend(pairs) or []):
            out = b.recover_saved(s.cfg)
        self.assertEqual([h for h, _ in sent], ["0xa", "0xd", "0xb", "0xc"])   # by block, each block's own order kept
        self.assertEqual(out["recovered"], 4)

    def test_an_old_format_file_with_no_record_is_sent_again_and_its_attempt_closed(self):
        t1 = tx(ALICE, 0)
        s = self.setup({})
        s.reth.mined[t1["hash"]] = t1
        p, seen = self.restart_with_file(s, [{"hash": t1["hash"], "raw": raw_of(t1), "run": "run-a", "attempt": 3}])
        p.restore()
        self.assertEqual(self.in_pool(s), {t1["hash"]})
        self.assertEqual(seen, [([("run-a", 3)], True)])
        self.assertEqual([(l["attempt_run"], l["attempt"], l["outcome"]) for l in self.journal(s, "resolved")], [("run-a", 3, "restarted")])
        self.assertFalse(b.saved_path(s.cfg).exists())

    def test_an_old_format_file_and_a_committed_record_clears_the_untagged_entries_as_the_blocks(self):
        s, first, t1, t2 = self.in_doubt()
        self.old_format_first(s)
        second = self.producer(s)
        second.load_unresolved()
        s.ledger.land(ok=True)
        second.step()
        self.assertEqual([e["number"] for e in json.loads(b.saved_path(s.cfg).read_text())], [N + 1])   # the untagged entry was N's
        self.assertEqual(self.in_pool(s), set())
        self.assertEqual(self.closed(s, second.journal.run_id)[-1:], [(first.journal.run_id, 1, "committed")])

    def old_format_first(self, s):
        """Takes the number off the entries of the in-doubt block (the first one in the file), as an older builder wrote them."""
        entries = json.loads(b.saved_path(s.cfg).read_text())
        entries[0].pop("number")
        self.assertEqual(entries[0]["hash"], tx(ALICE, 0)["hash"])
        b.saved_path(s.cfg).write_text(json.dumps(entries))

    def test_an_old_format_file_and_a_record_that_did_not_commit_sends_all_of_it_again(self):
        s, first, t1, t2 = self.in_doubt()
        self.old_format_first(s)
        second = self.producer(s)
        second.load_unresolved()
        s.ledger.land(ok=False)
        second.step()
        self.assertEqual(self.in_pool(s), {t1["hash"], t2["hash"]})
        self.assertFalse(b.saved_path(s.cfg).exists())
        self.assertEqual(self.closed(s, second.journal.run_id), [("old-run", 7, "restarted"), (first.journal.run_id, 1, "not committed")])


    # -- a kept file that cannot be read is never removed or emptied
    @contextlib.contextmanager
    def unreadable(self, s):
        """The kept file exists but reading it fails (permission, I/O error)."""
        real = Path.read_text
        target = b.saved_path(s.cfg)
        def read_text(path, *a, **k):
            if path == target:
                raise OSError(errno.EACCES, "Permission denied")
            return real(path, *a, **k)
        with mock.patch.object(Path, "read_text", read_text):
            yield

    def test_an_unreadable_kept_file_survives_the_not_committed_settle_and_nothing_moves_until_it_reads(self):
        s, first, t1, t2 = self.in_doubt()
        before = b.saved_path(s.cfg).read_text()
        second = self.producer(s)
        second.load_unresolved()
        s.ledger.land(ok=False)
        moves = len(s.forkchoices())
        with self.unreadable(s):
            second.step()
            second.step()
        self.assertEqual(b.saved_path(s.cfg).read_text(), before)
        self.assertTrue(b.unresolved_path(s.cfg).exists())
        self.assertEqual((self.in_pool(s), len(s.forkchoices())), (set(), moves))   # reth was not moved and nothing was sent
        second.step()   # readable again: the whole file is sent, in block order
        self.assertEqual(self.in_pool(s), {t1["hash"], t2["hash"]})
        self.assertFalse(b.saved_path(s.cfg).exists())

    def test_an_unreadable_kept_file_survives_recover_saved(self):
        s, first, t1, t2 = self.in_doubt()
        before = b.saved_path(s.cfg).read_text()
        s.ledger.land(ok=False)
        with self.unreadable(s), self.assertRaises(b.BuilderError):
            b.recover_saved(s.cfg)
        self.assertEqual(b.saved_path(s.cfg).read_text(), before)
        self.assertTrue(b.unresolved_path(s.cfg).exists())
        found = b.recover_saved(s.cfg)
        self.assertEqual(found["settled"]["committed"], False)
        self.assertEqual(self.in_pool(s), {t1["hash"], t2["hash"]})

    def test_an_unreadable_kept_file_with_no_command_in_doubt_survives_recover_saved(self):
        s = self.setup({})
        b.save_kept(s.cfg, [("0xa", "0x01")], number=N)
        before = b.saved_path(s.cfg).read_text()
        with self.unreadable(s), self.assertRaises(b.BuilderError):
            b.recover_saved(s.cfg)
        self.assertEqual(b.saved_path(s.cfg).read_text(), before)

    def committed_settle(self, record_number):
        s, first, t1, t2 = self.in_doubt()
        before = b.saved_path(s.cfg).read_text()
        s.ledger.land(ok=True)
        u = json.loads(b.unresolved_path(s.cfg).read_text())
        u["since"] = u["submittedAt"]
        if record_number:
            self.assertIsInstance(u["number"], int)
        else:
            u["number"] = None   # a record with no integer number
        with self.unreadable(s):
            committed, _, _, _ = b.resolve_unknown(s.cfg, u, [])
        self.assertTrue(committed)
        self.assertEqual(b.saved_path(s.cfg).read_text(), before)

    def test_an_unreadable_kept_file_survives_the_committed_settle_with_a_record_number(self):
        self.committed_settle(True)

    def test_an_unreadable_kept_file_survives_the_committed_settle_with_no_record_number(self):
        self.committed_settle(False)


if __name__ == "__main__":
    unittest.main()
