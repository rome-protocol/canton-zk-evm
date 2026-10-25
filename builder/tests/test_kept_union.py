"""The kept file holds the transactions of every block being made, each entry tagged with its block's number, and each attempt has a folder of
its own. Run: python3 -m unittest discover -s builder/tests"""
import json, sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import HEAD_HASH, HEAD_NUMBER, tx
from websockets.sync.client import connect

N = HEAD_NUMBER + 1


class KeptFile(tb.Case):
    def entries(self, s):
        return json.loads(b.saved_path(s.cfg).read_text())

    def test_each_entry_carries_its_blocks_number(self):
        s = self.setup({})
        b.save_kept(s.cfg, [("0xa", "0x01"), ("0xb", "0x02")], number=5)
        self.assertEqual(self.entries(s), [{"hash": "0xa", "raw": "0x01", "number": 5}, {"hash": "0xb", "raw": "0x02", "number": 5}])

    def test_the_file_holds_the_union_and_a_block_is_saved_over_only_itself(self):
        s = self.setup({})
        b.save_kept(s.cfg, [("0xa", "0x01")], number=5)
        b.save_kept(s.cfg, [("0xb", "0x02")], number=6)
        self.assertEqual(b.read_saved(s.cfg), [("0xa", "0x01"), ("0xb", "0x02")])
        b.save_kept(s.cfg, [("0xc", "0x03")], number=5)   # block 5 is rebuilt: its entries are replaced, block 6's stay
        self.assertEqual(sorted(b.read_saved(s.cfg)), [("0xb", "0x02"), ("0xc", "0x03")])
        self.assertEqual(sorted(e["number"] for e in self.entries(s)), [5, 6])

    def test_clearing_a_block_leaves_the_others_and_the_last_one_removes_the_file(self):
        s = self.setup({})
        b.save_kept(s.cfg, [("0xa", "0x01")], number=5)
        b.save_kept(s.cfg, [("0xb", "0x02")], number=6)
        b.clear_saved(s.cfg, 5)
        self.assertEqual(b.read_saved(s.cfg), [("0xb", "0x02")])
        b.clear_saved(s.cfg, 5)   # nothing of block 5 is left: no change
        self.assertEqual(b.read_saved(s.cfg), [("0xb", "0x02")])
        b.clear_saved(s.cfg, 6)
        self.assertFalse(b.saved_path(s.cfg).exists())
        b.clear_saved(s.cfg, 6)   # no file: no error
        b.save_kept(s.cfg, [("0xa", "0x01")], number=5)
        b.clear_saved(s.cfg)      # without a number the whole file goes
        self.assertFalse(b.saved_path(s.cfg).exists())

    def test_a_file_without_numbers_still_reads_and_belongs_to_the_block_being_made(self):
        s = self.setup({})
        b.saved_path(s.cfg).parent.mkdir(parents=True, exist_ok=True)
        b.saved_path(s.cfg).write_text(json.dumps([{"hash": "0xa", "raw": "0x01", "run": "r1", "attempt": 3}, {"hash": "0xb", "raw": "0x02"}]))
        self.assertEqual(b.read_saved(s.cfg), [("0xa", "0x01"), ("0xb", "0x02")])
        b.clear_saved(s.cfg, 7)   # one block's entries, as before the numbers: the whole file
        self.assertFalse(b.saved_path(s.cfg).exists())
        b.saved_path(s.cfg).write_text(json.dumps([{"hash": "0xa", "raw": "0x01"}]))
        b.save_kept(s.cfg, [("0xb", "0x02")], number=7)   # a new block replaces the single block of the old file, as it did
        self.assertEqual(self.entries(s), [{"hash": "0xb", "raw": "0x02", "number": 7}])

    def test_a_rebuild_with_no_transaction_removes_only_its_blocks_entries(self):
        s = self.setup({})   # an empty pool: the block holds nothing
        b.save_kept(s.cfg, [("0xa", "0x01")], number=N)       # an earlier copy of this block's transactions (they are back in the pool)
        b.save_kept(s.cfg, [("0xb", "0x02")], number=N + 1)   # the transactions of a block that is still in flight
        ws = connect(s.cfg.ws_url, max_size=None)
        self.addCleanup(ws.close)
        reth = b.Reth(s.cfg, ws)
        chain = b.Ledger(s.cfg).head()
        reth.forkchoice(HEAD_HASH, HEAD_HASH, HEAD_HASH)
        built = b.build(s.cfg, reth, chain, HEAD_HASH, set())
        self.assertEqual((built.n, built.chosen), (N, []))
        self.assertEqual(b.read_saved(s.cfg), [("0xb", "0x02")])

    def test_putting_a_block_back_sends_its_transactions_and_keeps_the_others_entries(self):
        a = tx(tb.ALICE, 0)
        s = self.setup({tb.ALICE: [a]})
        b.save_kept(s.cfg, [("0xb", "0x02")], number=N + 1)
        ws = connect(s.cfg.ws_url, max_size=None)
        self.addCleanup(ws.close)
        reth = b.Reth(s.cfg, ws)
        chain = b.Ledger(s.cfg).head()
        reth.forkchoice(HEAD_HASH, HEAD_HASH, HEAD_HASH)
        built = b.build(s.cfg, reth, chain, HEAD_HASH, set())
        self.assertEqual(sorted(e["number"] for e in self.entries(s)), [N, N + 1])
        reth.forkchoice(HEAD_HASH, HEAD_HASH, HEAD_HASH)
        self.assertEqual(b.put_back(reth, built.n), [])
        self.assertEqual(self.entries(s), [{"hash": "0xb", "raw": "0x02", "number": N + 1}])
        self.assertEqual(reth.imported, [])


class AttemptFolders(tb.Case):
    def cut(self, s):
        ws = connect(s.cfg.ws_url, max_size=None)
        self.addCleanup(ws.close)
        reth = b.Reth(s.cfg, ws)
        chain = b.Ledger(s.cfg).head()
        reth.forkchoice(HEAD_HASH, HEAD_HASH, HEAD_HASH)
        return reth, chain

    def test_a_rebuilt_block_gets_a_folder_and_the_first_one_is_left_alone(self):
        s = self.setup({tb.ALICE: [tx(tb.ALICE, 0)]})
        reth, chain = self.cut(s)
        first = b.build(s.cfg, reth, chain, HEAD_HASH, set())
        (first.attempt_dir / "input.bin").write_text("what a cancelled job may still be reading")
        reth.forkchoice(HEAD_HASH, HEAD_HASH, HEAD_HASH)
        b.put_back(reth, first.n)
        second = b.build(s.cfg, reth, chain, HEAD_HASH, set())
        self.assertEqual((first.n, first.work), (second.n, second.work))
        self.assertNotEqual(first.attempt_dir, second.attempt_dir)
        self.assertEqual(first.attempt_dir.parent, first.work)
        self.assertEqual((first.attempt_dir / "input.bin").read_text(), "what a cancelled job may still be reading")
        self.assertEqual(sorted(p.name for p in second.attempt_dir.iterdir()), ["block.json", "witness.json"])

    def test_the_tools_get_the_attempts_folder_and_the_accepted_proof_ends_in_the_blocks_out(self):
        s = self.setup({tb.ALICE: [tx(tb.ALICE, 0)]})
        reth, chain = self.cut(s)
        built = b.build(s.cfg, reth, chain, HEAD_HASH, set())
        b.prove(s.cfg, built)
        lines = [l.split() for l in s.log.read_text().splitlines()]
        self.assertTrue(all(str(built.attempt_dir) in " ".join(l) for l in lines))   # the input tool and the prover read and write there
        self.assertTrue((built.work / "out" / "wrapped-proof.hex").is_file())
        self.assertFalse((built.attempt_dir / "out").exists())                     # moved, not copied
        self.assertTrue((built.attempt_dir / "input.bin").is_file())

    def test_only_the_newest_attempt_folders_of_a_block_are_kept(self):
        s = self.setup({tb.ALICE: [tx(tb.ALICE, 0)]})
        reth, chain = self.cut(s)
        folders = []
        for _ in range(b.KEEP_ATTEMPTS + 2):
            built = b.build(s.cfg, reth, chain, HEAD_HASH, set())
            folders.append(built.attempt_dir)
            reth.forkchoice(HEAD_HASH, HEAD_HASH, HEAD_HASH)
            b.put_back(reth, built.n)
        self.assertEqual(sorted(p for p in built.work.glob("attempt-*")), sorted(folders[-b.KEEP_ATTEMPTS:]))


if __name__ == "__main__":
    unittest.main()
