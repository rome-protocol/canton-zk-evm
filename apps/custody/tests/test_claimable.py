"""Tests for claimable.py: the live checks of a route, and the eth_call reader of Ostia (against a local HTTP server). Run: python3 -m unittest discover -s apps/custody/tests"""
import sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import claimable
from test_intake import FakeOstia, Server

BOOK, ROUTER, ASSET = "9a" * 20, "7a" * 20, "d1" * 20


class Route(unittest.TestCase):
    def setUp(self):
        self.book = FakeOstia()
        self.ostia = claimable.Ostia(self.book.call, BOOK, ROUTER)

    def check(self, amount, max_fee=2 * 10**9, network=0):
        claimable.check_route(self.ostia, ASSET, network, amount, max_fee)

    def refused(self, amount, why, max_fee=2 * 10**9):
        with self.assertRaises(claimable.Refused) as caught:
            self.check(amount, max_fee)
        self.assertEqual(str(caught.exception), why)

    def test_the_amount_must_leave_one_unit_after_the_fee_and_reach_the_minimum(self):
        self.refused(3 * 10**9 - 1, "the least amount for this route is now 0.3")
        self.check(3 * 10**9)
        self.refused(2 * 10**9, "the least amount for this route is now 0.3")   # the incident: all fee
        self.book.minimum = 10**10   # a minimum above the fee and the unit is the floor
        self.refused(10**10 - 1, "the least amount for this route is now 1")
        self.check(10**10)

    def test_a_unit_of_one_makes_more_than_the_fee_enough(self):
        self.book.unit, self.book.minimum = 1, 1
        self.refused(2 * 10**9, "the least amount for this route is now 0.2000000001")
        self.check(2 * 10**9 + 1)

    def test_the_memos_most_fee_is_the_sender_cap_on_the_live_fee(self):
        self.check(5 * 10**9, max_fee=2 * 10**9)
        self.book.claim = 16 * 10**8
        self.refused(5 * 10**9, "the route's fee is now 0.21 and the memo allows 0.2")
        self.check(51 * 10**8, max_fee=21 * 10**8)

    def test_a_most_fee_of_the_largest_number_is_no_cap(self):
        self.check(5 * 10**9, max_fee=2**256 - 1)

    def test_a_fee_cut_to_the_unit_is_still_under_the_cap(self):
        self.refused(39 * 10**8, "the fee for this amount is 0.29 and the memo allows 0.2")
        self.check(39 * 10**8, max_fee=29 * 10**8)

    def test_the_lock_room_bounds_what_is_sent(self):
        self.book.room = 10**9
        self.check(3 * 10**9)   # sends 0.1
        self.refused(4 * 10**9, "the route has no room for this amount now")

    def test_a_route_the_book_does_not_open_is_refused_and_one_it_cannot_answer_is_an_error(self):
        self.book.open = False
        self.refused(5 * 10**9, "the route is not open now")
        self.book.open, self.book.down = True, True
        with self.assertRaises(RuntimeError):
            self.check(5 * 10**9)

    def test_an_answer_of_the_wrong_size_or_a_destination_with_no_unit_is_an_error(self):
        for answer in (b"", b"\0" * 32 * 8, b"\0" * 32 * 10):
            with self.subTest(size=len(answer)), self.assertRaises(RuntimeError):
                claimable.Ostia(lambda to, data, a=answer: a, BOOK, ROUTER).route(ASSET, 0)
        self.book.unit = 0
        with self.assertRaises(RuntimeError):
            self.check(5 * 10**9)

    def test_a_plain_deposit_needs_only_something_to_claim(self):
        claimable.check_plain(1)
        with self.assertRaises(claimable.Refused):
            claimable.check_plain(0)

    def test_amounts_are_shown_as_a_wallet_shows_them(self):
        self.assertEqual([claimable.shown(n) for n in (0, 1, 5 * 10**8, 10**10, 12 * 10**9 + 5)], ["0", "0.0000000001", "0.05", "1", "1.2000000005"])


class Reader(unittest.TestCase):
    def reader(self, handle):
        server = Server(handle)
        self.addCleanup(server.stop)
        self.url = server.url
        return claimable.eth_call(server.url)

    def test_the_call_is_an_eth_call_at_the_latest_block_with_the_project_contact(self):
        seen = []

        def handle(method, path, body, headers):
            seen.append((body["method"], body["params"], headers.get("User-Agent")))
            return 200, {"jsonrpc": "2.0", "id": 1, "result": "0x" + "00" * 31 + "07"}
        got = self.reader(handle)("0x" + BOOK, bytes.fromhex("aabbccdd"))
        self.assertEqual((got, seen), (b"\0" * 31 + b"\7", [("eth_call", [{"to": "0x" + BOOK, "data": "0xaabbccdd"}, "latest"], "Rome Protocol rome@romeprotocol.com")]))

    def test_a_revert_is_told_from_an_answer_that_cannot_be_read(self):
        for answer in ((200, {"error": {"code": 3, "message": "execution reverted", "data": "0x"}}), (200, {"error": {"code": -32000, "message": "execution reverted: RouteNotOpen"}})):
            with self.subTest(answer=answer), self.assertRaises(claimable.Reverted):
                self.reader(lambda *a, answer=answer: answer)("0x" + BOOK, b"")
        for answer in ((500, {}), (200, {"error": {"code": -32603, "message": "internal error"}}), (200, {"result": "nonsense"}), (200, {}), (200, [])):
            reader = self.reader(lambda *a, answer=answer: answer)
            with self.subTest(answer=answer), self.assertRaises(RuntimeError) as caught:
                reader("0x" + BOOK, b"")
            self.assertNotIn(self.url, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
