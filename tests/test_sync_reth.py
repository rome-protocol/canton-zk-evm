"""network/sync_reth.py: reth behind Canton, ahead of it, or on its head, against a fake reth."""
import sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "network"))
import sync_reth


def h(n):
    return "0x" + f"{n:02x}" * 32


class FakeReth:
    """Blocks 0..have; the canonical head and the finalized block are the numbers given."""
    def __init__(self, have, latest, finalized, valid=True):
        self.have, self.latest, self.finalized, self.valid, self.updates = have, latest, finalized, valid, []

    def call(self, method, params):
        if method == "eth_getBlockByNumber":
            n = {"latest": self.latest, "finalized": self.finalized}[params[0]]
            return {"number": hex(n), "hash": h(n)}
        if method == "eth_getBlockByHash":
            n = int(params[0][2:4], 16)
            return {"number": hex(n), "hash": h(n)} if n <= self.have else None
        raise AssertionError(method)

    def forkchoice(self, head, safe, finalized):
        self.updates.append((head, safe, finalized))
        if not self.valid:
            raise sync_reth.SyncError("not VALID")
        self.latest = self.finalized = int(head[2:4], 16)


class Reconcile(unittest.TestCase):
    def run_it(self, reth, number):
        return sync_reth.reconcile(number, h(number), reth.call, reth.forkchoice)

    def test_same_block_moves_nothing(self):
        r = self.run_it(FakeReth(5, 5, 5), 5)
        self.assertEqual((r["moved"], r["reth_latest"], r["reth_finalized"]), ("no", 5, 5))

    def test_reth_ahead_is_moved_back_to_cantons_head(self):
        reth = FakeReth(7, 7, 5)   # blocks 6 and 7 were never committed on Canton
        r = self.run_it(reth, 5)
        self.assertEqual((r["moved"], r["reth_latest_before"], r["reth_latest"], r["reth_finalized"]), ("yes", 7, 5, 5))
        self.assertEqual(reth.updates, [(h(5), h(5), h(5))])

    def test_reth_finalized_behind_latest_on_cantons_head_is_finalized(self):
        r = self.run_it(FakeReth(5, 5, 4), 5)
        self.assertEqual((r["moved"], r["reth_finalized_before"], r["reth_finalized"]), ("yes", 4, 5))

    def test_reth_behind_canton_is_an_error_and_moves_nothing(self):
        reth = FakeReth(3, 3, 3)
        with self.assertRaisesRegex(sync_reth.SyncError, "reth does not have"):
            self.run_it(reth, 5)
        self.assertEqual(reth.updates, [])

    def test_a_block_with_another_number_is_an_error(self):
        reth = FakeReth(9, 9, 9)
        reth.call_orig = reth.call
        reth.call = lambda m, p: {"number": "0x4", "hash": p[0]} if m == "eth_getBlockByHash" else reth.call_orig(m, p)
        with self.assertRaisesRegex(sync_reth.SyncError, "as number 4"):
            self.run_it(reth, 5)

    def test_reth_that_does_not_accept_the_update_is_an_error(self):
        with self.assertRaises(sync_reth.SyncError):
            self.run_it(FakeReth(7, 7, 5, valid=False), 5)

    def test_a_head_that_did_not_move_is_caught(self):
        reth = FakeReth(7, 7, 5)
        reth.forkchoice = lambda *a: None   # says VALID and does nothing
        with self.assertRaisesRegex(sync_reth.SyncError, "not Canton's head"):
            self.run_it(reth, 5)


if __name__ == "__main__":
    unittest.main()
