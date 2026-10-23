"""The judging half of the nightly L3 (tests/demo_nightly_l3.py): the percentile, the growth per million, and each budget's verdict. No chain needed."""
import http.server
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import demo_nightly_l3 as l3  # noqa: E402


def block(n, txs=1000, served=0.2, sse=0.05):
    return {"number": n, "txs": txs, "served_s": served, "sse_after_served_s": sse}


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


class DatabaseClock(unittest.TestCase):
    def clock(self):
        c = l3.DbClock("unused")
        for line in ["5 100.00\n", "5 100.02\n", "6 100.04\n", "6 100.06\n", "9 100.08\n"]:
            c.tick(line)
        return c

    def test_a_block_is_between_the_last_tick_that_could_not_see_it_and_the_first_that_could(self):
        self.assertEqual(self.clock().seen(6), (100.02, 100.04))
        self.assertEqual(self.clock().seen(8), (100.06, 100.08))   # 7 and 8 were written between two ticks: they share the tick that saw them
        self.assertEqual(self.clock().seen(9), (100.06, 100.08))

    def test_a_block_already_there_at_the_first_tick_has_no_tick_before_it(self):
        self.assertEqual(self.clock().seen(5), (None, 100.0))

    def test_a_block_no_tick_has_seen_has_no_time(self):
        self.assertEqual(self.clock().seen(10), (100.08, None))

    def test_anything_psql_prints_that_is_not_a_tick_is_kept_as_the_error_and_not_a_tick(self):
        c = self.clock()
        c.tick("ERROR:  relation \"blocks\" does not exist\n")
        self.assertEqual(len(c.times), 5)
        self.assertIn("does not exist", c.error)

    def test_the_gaps_are_the_time_between_ticks(self):
        self.assertEqual([round(g, 2) for g in self.clock().gaps()], [0.02] * 4)


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


class FailedCut(unittest.TestCase):
    """A cut that failed is never made again: Canton's head and reth's say what L3 does next."""
    def test_a_fork_stops_l3_and_names_both_heads(self):
        why = l3.after_failed_cut((7, "0xaa"), (8, "0xbb"), 7, "cut_block exited 1: late")
        self.assertIn("the chain forked at block 8: Canton holds 7 (0xaa), reth holds 8 (0xbb)", why)

    def test_the_same_number_with_two_hashes_is_a_fork_at_that_number(self):
        self.assertIn("forked at block 8:", l3.after_failed_cut((8, "0xaa"), (8, "0xbb"), 7, "late"))

    def test_canton_holding_the_block_reth_holds_carries_on(self):
        self.assertIsNone(l3.after_failed_cut((8, "0xaa"), (8, "0xaa"), 7, "late"))

    def test_no_new_block_anywhere_fails_with_the_builders_reason(self):
        self.assertEqual(l3.after_failed_cut((7, "0xaa"), (7, "0xaa"), 7, "cut_block exited 1: the pool is empty"), "cut_block exited 1: the pool is empty")

    def test_it_is_never_cut_again(self):
        self.assertFalse(hasattr(l3, "CUT_RETRIES"))
        self.assertNotIn("CUT_RETRIES", Path(l3.__file__).read_text())


class HashLists(unittest.TestCase):
    def test_lists_of_hashes_are_cut_out(self):
        text = 'lost ["0x' + "a" * 64 + '", "0x' + "b" * 64 + '"] and [] done'
        self.assertEqual(l3.HASH_LISTS.sub("[...]", text), "lost [...] and [...] done")

    def test_an_unclosed_list_is_not_slow(self):
        start = time.monotonic()
        l3.HASH_LISTS.sub("[...]", "[" + ' "0x' + "a" * 40 + '"' * 1 + (' "0x' + "b" * 40 + '"') * 60)
        self.assertLess(time.monotonic() - start, 1.0)


class Budgets(unittest.TestCase):
    def test_b1_is_the_one_budgets_ts_holds(self):
        import re
        src = (Path(__file__).resolve().parent.parent / "explorer" / "test" / "budgets.ts").read_text()
        self.assertEqual(l3.B1_S * 1000, int(re.search(r"B1_MS\s*=\s*([0-9_]+)", src).group(1).replace("_", "")))


class Judge(unittest.TestCase):
    ok = dict(growth=1.2e9, txs_added=50_000)

    def test_inside_every_budget(self):
        summary, failures = l3.judge([block(i) for i in range(20)], **self.ok)
        self.assertEqual(failures, [])
        self.assertEqual(summary["blocks"], 20)

    def test_b1_p95_over_its_budget_fails(self):
        blocks = [block(i, served=0.2) for i in range(18)] + [block(18, served=2.9), block(19, served=3.0)]
        _, failures = l3.judge(blocks, **self.ok)
        self.assertTrue(any(f.startswith("B1") for f in failures), failures)

    def test_b4_p95_over_half_a_second_fails(self):
        blocks = [block(i, sse=0.1) for i in range(18)] + [block(18, sse=0.9), block(19, sse=0.9)]
        _, failures = l3.judge(blocks, **self.ok)
        self.assertTrue(any(f.startswith("B4") for f in failures), failures)

    def test_a_block_never_served_fails(self):
        _, failures = l3.judge([block(1), dict(block(2), served_s=None)], database_clock_error="boom", **self.ok)
        self.assertTrue(any("never seen in the database" in f and "boom" in f for f in failures), failures)

    def test_a_block_that_never_reached_the_stream_fails(self):
        blocks = [block(i) for i in range(19)] + [dict(block(19), sse_after_served_s=None)]
        _, failures = l3.judge(blocks, **self.ok)
        self.assertTrue(any(f.startswith("B4") and "19 of 20" in f for f in failures), failures)

    def test_a_block_whose_clock_could_not_start_fails(self):
        _, failures = l3.judge([block(1), dict(block(2), t0_from="fallback")], **self.ok)
        self.assertTrue(any(f.startswith("B1") and "[2]" in f for f in failures), failures)

    def test_a_block_in_the_database_that_the_api_never_answered_for_fails(self):
        _, failures = l3.judge([block(1), dict(block(2), api_answer_after_served_s=None)], **self.ok)
        self.assertTrue(any("[2]" in f and "API never answered" in f for f in failures), failures)

    def test_time_to_final_is_reported_as_not_measured(self):
        summary, _ = l3.judge([block(i) for i in range(20)], **self.ok)
        self.assertIs(summary["final_measured"], False)
        self.assertFalse(any(k.startswith("final_p") for k in summary))

    def test_a_stream_event_before_the_database_tick_is_not_clamped_to_zero(self):
        # B4 can fail: a late event shows its delay, and an early one a negative number inside the measurement error
        summary, _ = l3.judge([block(i, sse=-0.01) for i in range(10)] + [block(10 + i, sse=0.8) for i in range(10)], **self.ok)
        self.assertEqual(summary["sse_p95_s"], 0.8)

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
