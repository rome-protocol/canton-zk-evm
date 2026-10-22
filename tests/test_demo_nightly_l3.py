"""The judging half of the nightly L3 (tests/demo_nightly_l3.py): the percentile, the growth per million, and each budget's verdict. No chain needed."""
import http.server
import sys
import threading
import time
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


class Served(unittest.TestCase):
    """B1 counts a block as served only when the explorer's database answers; reth has the block the moment the builder commits it."""
    def test_an_answer_from_reth_alone_is_not_served(self):
        self.assertFalse(l3.from_database({"status": "unindexed", "number": 5, "canton": None}))
        self.assertFalse(l3.from_database({"status": "proving", "number": 5, "canton": None}))
        self.assertFalse(l3.from_database({"status": "genesis", "number": 0, "canton": None}))

    def test_a_final_block_with_its_canton_record_is_served(self):
        self.assertTrue(l3.from_database({"status": "final", "number": 5, "canton": {"updateId": "u"}}))

    def test_a_final_block_without_a_canton_record_is_not_served(self):
        self.assertFalse(l3.from_database({"status": "final", "number": 5, "canton": None}))

    def test_no_body_is_not_served(self):
        self.assertFalse(l3.from_database(None))


class Clock(unittest.TestCase):
    def clock(self):
        c = l3.LedgerClock("http://unused")
        c.sent, c.offsets = [10.0, 10.02, 10.04, 10.06], [100, 100, 140, 200]
        return c

    def test_the_time_is_the_last_poll_that_could_not_read_the_offset(self):
        # 140 was first read by the poll sent at 10.04; the one before it, sent at 10.02, could not: the lag is counted from there
        self.assertEqual(self.clock().reached(140), 10.02)
        self.assertEqual(self.clock().reached(200), 10.04)
        self.assertEqual(self.clock().reached(101), 10.02)

    def test_an_offset_already_read_by_the_first_poll_counts_from_that_poll(self):
        self.assertEqual(self.clock().reached(100), 10.0)
        self.assertEqual(self.clock().reached(1), 10.0)

    def test_an_offset_not_reached_has_no_time(self):
        self.assertIsNone(self.clock().reached(201))

    def test_an_unknown_offset_has_no_time(self):
        self.assertIsNone(self.clock().reached(None))

    def test_the_update_id_is_read_from_the_last_json_line(self):
        self.assertEqual(l3.committed('noise\n{"committed": true, "completionOffset": 77, "updateId": "1220ab"}\n'), "1220ab")

    def test_no_update_id_in_the_output(self):
        self.assertIsNone(l3.committed("nothing here"))
        self.assertIsNone(l3.committed('{"committed": true, "updateId": null}'))

    def test_an_update_id_that_is_not_hex_never_reaches_a_query(self):
        self.assertEqual(l3.reader_offsets(["12'; drop table blocks; --"]), {})
        self.assertEqual(l3.reader_offsets([None, ""]), {})


class Poller(unittest.TestCase):
    def test_the_clock_survives_bad_answers_and_keeps_polling(self):
        answers = iter([(200, b'{"offset": 5}'), (500, b"boom"), (200, b"not json"), (200, b'{"offset": 9}')])
        last = [(200, b'{"offset": 9}')]

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                status, body = next(answers, last[0])
                self.send_response(status)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        clock = l3.LedgerClock(f"http://127.0.0.1:{server.server_port}")
        clock.start()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and (not clock.offsets or clock.offsets[-1] < 9):
            time.sleep(0.01)
        clock.stop = True
        server.shutdown()
        server.server_close()
        self.assertEqual(clock.offsets[0], 5)
        self.assertEqual(clock.offsets[-1], 9)
        self.assertEqual(clock.misses, 2)
        self.assertIsNotNone(clock.last_miss)
        self.assertIsNotNone(clock.reached(9))


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

    def test_a_block_that_never_reached_the_stream_fails(self):
        blocks = [block(i) for i in range(19)] + [dict(block(19), sse_after_served_s=None)]
        _, failures = l3.judge(blocks, **self.ok)
        self.assertTrue(any(f.startswith("B4") and "19 of 20" in f for f in failures), failures)

    def test_a_block_whose_clock_could_not_start_fails(self):
        _, failures = l3.judge([block(1), dict(block(2), t0_from="fallback")], **self.ok)
        self.assertTrue(any(f.startswith("B1") and "[2]" in f for f in failures), failures)

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
