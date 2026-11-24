"""Tests for limits.py and the worker's publishing of its limits (custody-limits.json in the work folder).
Run: python3 -m unittest discover -s apps/custody/tests"""
import contextlib, io, json, os, sys, tempfile, unittest
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import intake, limits, payout

GATEWAY = "gateway::1220" + "11" * 32
DSO = "dso::1220" + "55" * 32
ISSUER = "issuer::1220" + "44" * 32
NOW = datetime(2026, 11, 24, 10, 30, 5, tzinfo=timezone.utc)


def run_once(*extra, work=None):
    """The worker's one round (`--once`) with the polls stubbed out: what it printed, and the file it left."""
    args = ["--gateway-party", GATEWAY, "--ledger-user", "operator", "--once", *extra]
    out = io.StringIO()
    with mock.patch.object(intake, "preapproval_warning"), mock.patch.object(intake.Intake, "poll", return_value=[]), mock.patch.object(payout.Payouts, "poll", return_value=[]), \
         mock.patch.dict(os.environ, {}, clear=False), contextlib.redirect_stdout(out):
        for name in ("CZE_INTAKE", "CZE_PAYOUT_OFFERS", "CZE_WORK_DIR", "CZE_MAX_OFFERS"):
            os.environ.pop(name, None)
        intake.main(args + (["--work-dir", work] if work else []))
    path = Path(work or "/nonexistent") / limits.FILE
    return out.getvalue(), (json.loads(path.read_text()) if path.exists() else None)


class AmountText(unittest.TestCase):
    def test_a_least_amount_is_plain_decimal_text(self):
        for amount, text in ((Fraction(10), "10"), (Fraction(1), "1"), (Fraction(0), "0"), (Fraction(1, 4), "0.25"), (Fraction("10.5"), "10.5"), (Fraction("0.0000000001"), "0.0000000001"), (Fraction("12345678901234567890.12"), "12345678901234567890.12")):
            with self.subTest(amount=amount):
                self.assertEqual(limits.amount_text(amount), text)


class Document(unittest.TestCase):
    def test_each_part_lists_its_instruments_and_a_part_that_is_off_is_null(self):
        doc = limits.document(NOW, 10.0, {(ISSUER, "TKB"): Fraction(1), (DSO, "Amulet"): Fraction(10)}, {(DSO, "Amulet"): Fraction(10)}, 3)
        self.assertEqual(doc, {
            "version": 1, "updatedAt": "2026-11-24T10:30:05Z", "pollSeconds": 10.0,
            "minDeposits": [{"instrumentAdmin": DSO, "instrumentId": "Amulet", "least": "10"}, {"instrumentAdmin": ISSUER, "instrumentId": "TKB", "least": "1"}],
            "minPayouts": [{"instrumentAdmin": DSO, "instrumentId": "Amulet", "least": "10"}], "maxOffers": 3})
        off = limits.document(NOW, 10.0)
        self.assertEqual((off["minDeposits"], off["minPayouts"], off["maxOffers"]), (None, None, None))

    def test_a_part_that_is_on_with_no_least_amount_has_an_empty_list(self):
        doc = limits.document(NOW, 10.0, {}, {}, 0)
        self.assertEqual((doc["minDeposits"], doc["minPayouts"], doc["maxOffers"]), ([], [], 0))

    def test_the_time_is_utc_whatever_the_clock_zone(self):
        from datetime import timedelta
        zone = timezone(timedelta(hours=2))
        self.assertEqual(limits.document(NOW.astimezone(zone), 10.0)["updatedAt"], "2026-11-24T10:30:05Z")


class Publish(unittest.TestCase):
    def test_the_file_is_replaced_whole_and_no_temporary_file_stays(self):
        with tempfile.TemporaryDirectory() as work:
            limits.publish(work, {"a": 1})
            limits.publish(work, {"a": 2})
            self.assertEqual(json.loads((Path(work) / limits.FILE).read_text()), {"a": 2})
            self.assertEqual(sorted(p.name for p in Path(work).iterdir()), [limits.FILE])


class Worker(unittest.TestCase):
    def test_the_intake_and_the_payouts_publish_what_they_enforce(self):
        with tempfile.TemporaryDirectory() as work:
            _, doc = run_once("--intake", "--gateway-address", "0x" + "ab" * 20, "--ostia-rpc", "http://127.0.0.1:1", "--min-deposit", f"{DSO}/Amulet=10", "--min-deposit", f"{ISSUER}/TKB=1",
                              "--payout-offers", "--min-payout", f"{DSO}/Amulet=10", "--min-payout", f"{ISSUER}/TKB=1", "--max-offers", "3", "--poll-seconds", "7", work=work)
        self.assertEqual(doc["minDeposits"], [{"instrumentAdmin": DSO, "instrumentId": "Amulet", "least": "10"}, {"instrumentAdmin": ISSUER, "instrumentId": "TKB", "least": "1"}])
        self.assertEqual(doc["minPayouts"], doc["minDeposits"])
        self.assertEqual((doc["maxOffers"], doc["pollSeconds"], doc["version"]), (3, 7.0, 1))
        self.assertRegex(doc["updatedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_the_intake_alone_has_no_payout_limits_and_the_payouts_alone_have_no_deposit_limits(self):
        with tempfile.TemporaryDirectory() as work:
            _, doc = run_once("--intake", "--gateway-address", "0x" + "ab" * 20, "--ostia-rpc", "http://127.0.0.1:1", "--min-deposit", f"{DSO}/Amulet=10", "--min-payout", f"{DSO}/Amulet=99", work=work)
        self.assertEqual((len(doc["minDeposits"]), doc["minPayouts"], doc["maxOffers"]), (1, None, None))
        with tempfile.TemporaryDirectory() as work:
            _, doc = run_once("--payout-offers", "--min-deposit", f"{DSO}/Amulet=99", "--min-payout", f"{DSO}/Amulet=10", work=work)
        self.assertEqual((doc["minDeposits"], len(doc["minPayouts"]), doc["maxOffers"]), (None, 1, 0))

    def test_no_setting_is_an_empty_list_not_a_missing_part(self):
        with tempfile.TemporaryDirectory() as work:
            _, doc = run_once("--payout-offers", work=work)
        self.assertEqual((doc["minPayouts"], doc["maxOffers"]), ([], 0))

    def test_every_round_writes_the_time_again(self):
        with tempfile.TemporaryDirectory() as work:
            args = intake.parser().parse_args(["--gateway-party", GATEWAY, "--ledger-user", "operator", "--intake", "--work-dir", work])
            settings, state = intake.settings_of(args), {"told": False}
            for moment in (NOW, NOW.replace(second=15)):
                with mock.patch.object(intake, "datetime", wraps=datetime) as clock:
                    clock.now.return_value = moment
                    intake.publish_limits(args, settings, None, state)
                self.assertEqual(json.loads((Path(work) / limits.FILE).read_text())["updatedAt"], moment.strftime("%Y-%m-%dT%H:%M:%SZ"))

    def test_without_a_work_folder_nothing_is_written_and_the_worker_goes_on(self):
        out, doc = run_once("--intake", "--gateway-address", "0x" + "ab" * 20, "--ostia-rpc", "http://127.0.0.1:1")
        self.assertEqual((out, doc), ("", None))

    def test_a_file_that_cannot_be_written_is_said_once_and_never_stops_the_worker(self):
        with tempfile.TemporaryDirectory() as work:
            args = intake.parser().parse_args(["--gateway-party", GATEWAY, "--ledger-user", "operator", "--intake", "--work-dir", str(Path(work) / "missing")])
            settings, state = intake.settings_of(args), {"told": False}
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                for _ in range(3):
                    intake.publish_limits(args, settings, None, state)
            lines = [json.loads(line) for line in out.getvalue().splitlines()]
            self.assertEqual(len(lines), 1)
            self.assertIn("limits file cannot be written", lines[0]["error"])
            self.assertNotIn(work, out.getvalue())


if __name__ == "__main__":
    unittest.main()
