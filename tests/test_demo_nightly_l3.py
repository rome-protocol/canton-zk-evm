"""The judging half of the nightly L3 (tests/demo_nightly_l3.py): the percentile, the growth per million, and each budget's verdict. No chain needed."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import demo_nightly_l3 as l3  # noqa: E402


def block(n, txs=1000, served=0.2, final=0.3, sse=0.05):
    return {"number": n, "txs": txs, "served_s": served, "final_s": final, "sse_after_served_s": sse}


class Percentile(unittest.TestCase):
    def test_nearest_rank(self):
        self.assertEqual(l3.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10)
        self.assertEqual(l3.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5)
        self.assertEqual(l3.percentile([7], 95), 7)

    def test_empty_is_none(self):
        self.assertIsNone(l3.percentile([], 95))


class Growth(unittest.TestCase):
    def test_per_million(self):
        self.assertEqual(l3.growth_per_million(1_000_000, 11_000_000 , 0, 10_000), 1_000_000_000)

    def test_no_transactions_is_none(self):
        self.assertIsNone(l3.growth_per_million(1, 2, 5, 5))


class Judge(unittest.TestCase):
    ok = dict(growth=1.2e9, txs_added=50_000)

    def test_inside_every_budget(self):
        summary, failures = l3.judge([block(i) for i in range(20)], **self.ok)
        self.assertEqual(failures, [])
        self.assertEqual(summary["blocks"], 20)

    def test_b1_p95_over_one_second_fails(self):
        blocks = [block(i, served=0.2) for i in range(18)] + [block(18, served=1.4), block(19, served=1.5)]
        _, failures = l3.judge(blocks, **self.ok)
        self.assertTrue(any(f.startswith("B1") for f in failures), failures)

    def test_b4_p95_over_half_a_second_fails(self):
        blocks = [block(i, sse=0.1) for i in range(18)] + [block(18, sse=0.9), block(19, sse=0.9)]
        _, failures = l3.judge(blocks, **self.ok)
        self.assertTrue(any(f.startswith("B4") for f in failures), failures)

    def test_a_block_never_served_fails(self):
        _, failures = l3.judge([block(1), dict(block(2), served_s=None, final_s=None)], **self.ok)
        self.assertTrue(any("never served" in f for f in failures), failures)

    def test_b6_over_budget_fails(self):
        _, failures = l3.judge([block(i) for i in range(20)], growth=3.0e9, txs_added=50_000)
        self.assertTrue(any(f.startswith("B6") for f in failures), failures)

    def test_too_few_transactions_to_judge_b6_fails(self):
        _, failures = l3.judge([block(i) for i in range(20)], growth=1e9, txs_added=100)
        self.assertTrue(any("too few" in f for f in failures), failures)

    def test_no_blocks_fails(self):
        _, failures = l3.judge([], **self.ok)
        self.assertTrue(failures)


if __name__ == "__main__":
    unittest.main()
