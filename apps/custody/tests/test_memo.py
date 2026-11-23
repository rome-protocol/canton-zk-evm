"""Tests for memo.py. Run: python3 -m unittest discover -s apps/custody/tests"""
import sys, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import memo

KEY = memo.REASON_KEY
CHECKSUMMED = "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"   # an EIP-55 test vector: lower and upper case letters both
DIGITS = CHECKSUMMED.lower()
INSTRUCTION = "00" + "ab" * 34
ROUTER = "0x" + "7a" * 20
ROUTE = "r1:0:0x" + "e3" * 20 + ":2000000000:17"


def read(text=None, router=None, **more):
    meta = {**({KEY: text} if text is not None else {}), **more}
    return memo.read(meta, INSTRUCTION, router)


class AddressMemo(unittest.TestCase):
    def test_lowercase_uppercase_and_a_good_checksum_are_taken(self):
        for text in ("0x" + DIGITS, "0x" + DIGITS.upper(), "0x" + CHECKSUMMED, "  0x" + DIGITS + "\n", "0x" + "12" * 20):
            with self.subTest(text=text):
                self.assertEqual(read(text)[1], text.strip()[2:].lower())

    def test_the_label_is_the_instruction_unless_the_memo_has_one(self):
        self.assertEqual(read("0x" + DIGITS), (INSTRUCTION, DIGITS))
        self.assertEqual(read("0x" + DIGITS, **{memo.LABEL_KEY: "page-1"}), ("page-1", DIGITS))

    def test_a_bad_checksum_is_refused(self):
        self.assertEqual(memo.checksummed(DIGITS), CHECKSUMMED)
        first = next(i for i, c in enumerate(CHECKSUMMED) if c.isalpha())
        for text in ("0x" + CHECKSUMMED.swapcase(), "0x" + CHECKSUMMED[:first] + CHECKSUMMED[first].swapcase() + CHECKSUMMED[first + 1:]):
            with self.subTest(text=text), self.assertRaisesRegex(memo.Unreadable, "checksum"):
                read(text)

    def test_anything_but_one_address_is_refused(self):
        for text in (None, "", "   ", "0x12", "12" * 20, "0x" + "12" * 21, "0x" + "zz" * 20, "to 0x" + DIGITS, "0x" + DIGITS + " thanks", "0x" + DIGITS + "\n0x" + DIGITS, "0X" + DIGITS, 7):
            with self.subTest(text=text), self.assertRaises(memo.Unreadable):
                read(text)

    def test_a_label_that_is_empty_too_long_or_not_text_is_refused(self):
        for label in ("", "x" * (memo.MAX_LABEL + 1), 5):
            with self.subTest(label=label), self.assertRaises(memo.Unreadable):
                read("0x" + DIGITS, **{memo.LABEL_KEY: label})
        self.assertEqual(read("0x" + DIGITS, **{memo.LABEL_KEY: "x" * memo.MAX_LABEL})[0], "x" * memo.MAX_LABEL)


class RouteMemo(unittest.TestCase):
    def test_a_route_is_its_own_label_and_goes_to_the_router(self):
        self.assertEqual(read(ROUTE, ROUTER), (ROUTE, "7a" * 20))
        self.assertEqual(read(" " + ROUTE + " ", ROUTER, **{memo.LABEL_KEY: "ignored"}), (ROUTE, "7a" * 20))

    def test_without_a_router_a_route_stays_pending(self):
        with self.assertRaisesRegex(memo.Unreadable, "no router"):
            read(ROUTE)

    def test_a_route_that_the_router_would_not_rebuild_is_refused(self):
        zero = "r1:0:0x" + "00" * 20 + ":1:1"
        for text in (zero, "r1:00:0x" + "e3" * 20 + ":1:1", "r1:0:0x" + "E3" * 20 + ":1:1", "r1:0:0x" + "e3" * 20 + ":1", "r1:0:0x" + "e3" * 20 + ":1:1:1", "r1:0:" + "e3" * 20 + ":1:1",
                     "r1:0:0x" + "e3" * 20 + ":-1:1", "r1:0:0x" + "e3" * 20 + ":01:1", "r1:0:0x" + "e3" * 20 + ":1:" + "9" * 21 + "x"):
            with self.subTest(text=text), self.assertRaises(memo.Unreadable):
                read(text, ROUTER)


if __name__ == "__main__":
    unittest.main()
