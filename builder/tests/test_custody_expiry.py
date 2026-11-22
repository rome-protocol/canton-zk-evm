"""An instrument whose holdings run out (Canton Coin), named with --expiring-instrument: the floor on a deposit, what a withdrawal may leave behind, the order
and the number of its inputs, the custody check after a committed withdrawal, the status rows and the settings. The open rounds come from a fake validator scan
proxy through the instrument's registry; the rest runs against test_builder.py's fakes. Run: python3 -m unittest discover -s builder/tests"""
import http.server, json, sys, tempfile, threading, time, unittest
from fractions import Fraction
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import DEPOSIT, PAYMENT, WITHDRAWAL, Leg
from test_producer import Loop
from test_builder import ACCEPTANCE, ALICE, BOB, DEP, DEP_ID, PAY, PAYEE, REQUEST, TERMS, TKB, TOKEN, TRADE, TRADE_PAY, UNIT, WD_ID, WTKB, holding

ADMIN = "adm"            # the admin of TKB, the instrument the fake chain's token wraps: here it runs out
RATE = "0.0002588"       # coin per round: the scan proxy says dollars per round and a price, and the price here is 1
NOW = 1000               # the newest open round
CC = UNIT                # base units in one coin


def cc(text: str) -> int:
    return b.base_units(text)


FLOOR = cc("1.118016")   # 30 days of 144 rounds at 0.0002588
TOKEN_TEXT = "scan-token"
LEFT = "This withdrawal would leave {} CC of Canton Coin in the bridge, under its minimum of 1.118016 CC. {}"


def rounds_doc(numbers=(998, 999, 1000), rate=RATE, price="1.0", tick="600000000", inputs="100", create="0", transfer="0", lock="0", steps=()):
    """The answer of the scan proxy's open-and-issuing-mining-rounds: the amounts of transferConfigUsd are in dollars."""
    def one(n):
        return {"contract": {"payload": {"round": {"number": str(n)}, "amuletPrice": price, "tickDuration": {"microseconds": tick},
                "transferConfigUsd": {"createFee": {"fee": create}, "holdingFee": {"rate": rate}, "lockHolderFee": {"fee": lock},
                                      "transferFee": {"initialRate": transfer, "steps": list(steps)}, "maxNumInputs": inputs}}}}
    return {"open_mining_rounds": [one(n) for n in numbers], "issuing_mining_rounds": []}


EMPTY_CONTEXT = {"choiceContextData": {"values": {}}, "disclosedContracts": []}


class Scan:
    """A fake validator scan proxy: GET <prefix>/open-and-issuing-mining-rounds, and the registry's two POSTs with an empty choice context."""

    def __init__(self, doc=None, status=200, raw=None, prefix=""):
        self.doc, self.status, self.raw, self.prefix = rounds_doc() if doc is None else doc, status, raw, prefix
        self.asked = []   # (method, path, authorization)
        scan = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def reply(self, code, data):
                self.send_response(code)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                scan.asked.append(("GET", self.path, self.headers.get("authorization")))
                if self.path != scan.prefix + "/open-and-issuing-mining-rounds":
                    return self.reply(404, b"{}")
                self.reply(scan.status, scan.raw if scan.raw is not None else json.dumps(scan.doc).encode())

            def do_POST(self):
                self.rfile.read(int(self.headers.get("content-length", 0)))
                scan.asked.append(("POST", self.path, self.headers.get("authorization")))
                answer = {"factoryId": "fac-1", "transferKind": "direct", "choiceContext": EMPTY_CONTEXT} if "transfer-factory" in self.path else EMPTY_CONTEXT
                self.reply(200, json.dumps(answer).encode())
        self.server = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}{prefix}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()


def hold(cid, units, created=NOW, rate=RATE, prefix=""):
    """A gateway holding of TKB with its created round and rate in the view's meta (under `prefix` to the keys, as Splice writes them)."""
    cid, view = holding(cid, b.canton_amount(units))
    view["meta"] = {"values": {prefix + "created-in-round": str(created), prefix + "rate-per-round": rate}}
    return cid, view


def life(days):
    """The amount, in base units, whose holding fee takes `days` days (144 rounds each) to reach it."""
    return days * 144 * 2_588_000


class Rig(tb.LegCase):
    def setUp(self):
        b.REGISTRY_DOWN.clear()

    def rig(self, *held, k=50, **scan):
        """A chain whose token is the expiring instrument, the gateway holding `held`, and a scan proxy that answers `scan`."""
        s = self.setup({ALICE: []})
        s.scan = Scan(**scan)
        self.addCleanup(s.scan.close)
        token = Path(s.dir) / "scan.token"
        token.write_text(TOKEN_TEXT + "\n")
        s.cfg.registries, s.cfg.registry_tokens = {ADMIN: s.scan.url}, {ADMIN: str(token)}
        s.cfg.expiring, s.cfg.max_transfer_inputs = (ADMIN,), k
        s.ledger.tokens, s.ledger.acceptances, s.ledger.holdings = [TOKEN], [ACCEPTANCE], list(held)
        return s

    def custody_after(self, s, total):
        """Custody as the participant shows it at the offset of the commit (43): one holding of `total`; before it (42) the holdings the leg was built from."""
        s.ledger.holdings_at = {42: list(s.ledger.holdings), 43: [hold("after", total)] if total else []}

    def withdraw(self, s, units, sender=ALICE, nonce=0):
        t = self.leg_tx(s, Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, units, "r::1"), sender, nonce)
        s.reth.pool[sender] = [t]
        return t

    def deposit(self, s, units, sender=ALICE, nonce=0):
        s.ledger.requests = [REQUEST]
        s.ledger.views["alloc-d1"] = {"amount": b.canton_amount(units)}
        t = self.leg_tx(s, Leg(DEPOSIT, DEP_ID, WTKB, PAYEE, units), sender, nonce)
        s.reth.pool[sender] = [t]
        return t

    def inputs(self, s):
        legs = s.advance_argument()["legs"]
        self.assertEqual([l["tag"] for l in legs], ["WithdrawalLeg"])
        return legs[0]["value"]["inputs"]

    def reason(self, s, t, words):
        """The block is made again without `t`, and the whole sentence is the reason."""
        result = self.assert_left_out(s, t)
        self.assertEqual(result["leftOut"][0]["reason"], words)
        return result


class Floor(Rig):
    def test_a_deposit_under_the_floor_is_left_out_with_its_reason_and_one_at_the_floor_is_taken(self):
        s = self.rig()
        t = self.deposit(s, FLOOR - 1)
        self.reason(s, t, "Canton Coin deposits must be at least 1.118016 CC.")
        s = self.rig()
        self.deposit(s, FLOOR)
        result = self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["DepositLeg"])
        self.assertEqual(result["leftOut"], [])
        self.assertFalse(b.custody_check_path(s.cfg).exists())   # a deposit alone needs no custody check

    def test_the_leg_check_refuses_a_deposit_under_the_floor_with_the_whole_sentence(self):
        s = self.rig()
        self.deposit(s, FLOOR - 1)
        s.reth.trace_legs["0x" + "c9" * 20] = [Leg(DEPOSIT, DEP_ID, WTKB, PAYEE, FLOOR - 1)]
        checked = b.leg_check(s.cfg, {"from": "0x" + "a1" * 20, "to": "0x" + "c9" * 20, "data": "0x1234"})
        self.assertEqual((checked["ok"], checked["reason"]), (False, "Canton Coin deposits must be at least 1.118016 CC."))
        s.reth.trace_legs["0x" + "c9" * 20] = [Leg(DEPOSIT, DEP_ID, WTKB, PAYEE, FLOOR)]
        s.ledger.views["alloc-d1"] = {"amount": b.canton_amount(FLOOR)}
        self.assertEqual(b.leg_check(s.cfg, {"from": "0x" + "a1" * 20, "to": "0x" + "c9" * 20, "data": "0x1234"}), {"ok": True})

    def test_a_deposit_of_another_instrument_has_no_floor(self):
        s = self.rig()
        s.cfg.expiring = ("someone-else",)
        self.deposit(s, 1)
        self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["DepositLeg"])

    def test_a_claim_under_the_floor_is_still_redeemed(self):
        s = self.rig()
        claim = ("claim-1", {**tb.CLAIM[1], "amount": "0.5"})
        s.ledger.claims = [claim]
        t = self.leg_tx(s, Leg(DEPOSIT, tb.CLAIM_ID, WTKB, PAYEE, CC // 2))
        s.reth.pool[ALICE] = [t]
        self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["ClaimLeg"])

    def test_a_venue_trade_of_the_instrument_is_left_out_even_when_the_venue_is_trusted_and_its_allocation_unseen(self):
        s = self.rig()
        s.ledger.trades = [TRADE]
        s.cfg.venues = ("venue::1",)
        s.ledger.allocations = []   # the seller's allocation: the builder cannot see it
        t = self.leg_tx(s, TRADE_PAY)
        s.reth.pool[ALICE] = [t]
        self.reason(s, t, "Canton Coin is not taken through venue trades yet: the bridge cannot check its minimum on a trade.")

    def test_a_venue_trade_of_another_token_goes_on(self):
        s = self.rig()
        other = ("tok-9", {**TOKEN[1], "instrumentId": {"admin": "other", "id": "TKX"}})
        s.ledger.tokens += [other]
        s.ledger.trades = [("trade-1", {**TRADE[1], "gatewayToken": "tok-9"})]
        s.cfg.venues = ("venue::1",)
        s.ledger.allocations = []
        s.reth.pool[ALICE] = [self.leg_tx(s, TRADE_PAY)]
        self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["TradeLeg"])

    def test_without_the_setting_nothing_changes(self):
        s = self.rig()
        s.cfg.expiring = ()
        self.deposit(s, 1)
        self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["DepositLeg"])
        self.assertEqual(s.scan.asked, [("POST", "/registry/allocations/v1/alloc-d1/choice-contexts/execute-transfer", "Bearer " + TOKEN_TEXT)])   # the choice context only


class Rounds(Rig):
    def test_the_rounds_are_read_through_the_registry_with_its_token(self):
        s = self.rig()
        self.deposit(s, FLOOR)
        self.build(s)
        gets = [a for a in s.scan.asked if a[0] == "GET"]
        self.assertEqual(gets, [("GET", "/open-and-issuing-mining-rounds", "Bearer " + TOKEN_TEXT)])   # once for the block, however many legs ask

    def test_a_registry_under_a_path_keeps_it(self):
        s = self.rig(prefix="/api/validator/v0/scan-proxy")
        self.deposit(s, FLOOR)
        self.build(s)
        self.assertEqual([a[1] for a in s.scan.asked if a[0] == "GET"], ["/api/validator/v0/scan-proxy/open-and-issuing-mining-rounds"])

    def test_the_newest_round_gives_the_rate_and_the_floor_is_whole_base_units_rounded_up(self):
        r = b.parse_rounds(rounds_doc(numbers=(7, 9, 8), rate="0.00000001", price="3.0", tick="86400000000"))
        self.assertEqual((r.number, r.tick, r.max_inputs, r.fee), (9, 86_400_000_000, 100, False))
        self.assertEqual(r.rate, Fraction(1, 300_000_000))
        self.assertEqual(r.floor(30), 1000)   # 30 days at one round a day: 30 x 1/3e8 coin = 1e-7 coin = 1000 base units
        self.assertEqual(r.floor(1), 34)   # 1e10 / 3e8 = 33.3 base units: rounded up
        self.assertEqual(b.parse_rounds(rounds_doc()).floor(30), FLOOR)

    def test_a_round_that_cannot_be_read_makes_the_legs_wait_and_the_leg_check_says_unknown(self):
        cases = {"HTTP 500": dict(status=500), "too long": dict(raw=b"{" + b" " * 70_000 + b"}"), "not JSON": dict(raw=b"<html>"),
                 "no round": dict(doc={"open_mining_rounds": []}), "rate of zero": dict(doc=rounds_doc(rate="0")), "negative rate": dict(doc=rounds_doc(rate="-1")),
                 "tick of zero": dict(doc=rounds_doc(tick="0")), "price of zero": dict(doc=rounds_doc(price="0")), "no inputs allowed": dict(doc=rounds_doc(inputs="0")),
                 "not a number": dict(doc=rounds_doc(rate="NaN")), "an exponent": dict(doc=rounds_doc(rate="1e999999999")),
                 "a step with no rate": dict(doc=rounds_doc(steps=[[]]))}
        for name, scan in cases.items():
            for kind in ("deposit", "withdrawal"):
                with self.subTest(name, kind=kind):
                    s = self.rig(hold("h-1", 60 * CC), **scan)
                    t = self.deposit(s, FLOOR) if kind == "deposit" else self.withdraw(s, 4 * CC)
                    result = self.assert_left_out(s, t, "has no Canton side", "open round")
                    s.reth.trace_legs[tb.TKA] = []
                    s.reth.trace_legs["0x" + "c9" * 20] = [Leg(DEPOSIT, DEP_ID, WTKB, PAYEE, FLOOR)] if kind == "deposit" else [Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, 4 * CC, "r::1")]
                    checked = b.leg_check(s.cfg, {"from": "0x" + "a1" * 20, "to": "0x" + "c9" * 20, "data": "0x1234"})
                    self.assertTrue(checked["ok"], checked)
                    self.assertIn("open round", checked["unknown"])

    def test_other_tokens_go_on_while_the_round_cannot_be_read(self):
        s = self.rig(status=500)
        s.ledger.terms = [TERMS]
        t = self.leg_tx(s, PAY)
        s.reth.pool[ALICE] = [t]
        result = self.build(s)
        self.assertEqual(([l["tag"] for l in s.advance_argument()["legs"]], result["leftOut"]), (["PaymentLeg"], []))

    def test_a_create_transfer_or_lock_fee_keeps_withdrawals_out_but_not_deposits(self):
        for fee in (dict(create="0.01"), dict(transfer="0.001"), dict(lock="0.5"), dict(steps=[{"_1": "100.0", "_2": "0.0001"}])):
            with self.subTest(fee):
                s = self.rig(hold("h-1", 60 * CC), doc=rounds_doc(**fee))
                self.reason(s, self.withdraw(s, 4 * CC), "Canton Coin charges a create, transfer or lock fee, which this builder does not price.")
        s = self.rig(doc=rounds_doc(create="0.01"))
        self.deposit(s, FLOOR)
        self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["DepositLeg"])

    def test_a_holding_view_without_the_two_meta_keys_falls_back_to_the_contract(self):
        view = holding("h-1", "6.0")
        s = self.rig(view)
        s.ledger.amulets = [("h-1", {"amount": {"initialAmount": "6.0", "createdAt": {"number": str(NOW)}, "ratePerRound": {"rate": RATE}}})]
        self.withdraw(s, 4 * CC)
        self.custody_after(s, 2 * CC)
        self.build(s)
        self.assertEqual(self.inputs(s), ["h-1"])

    def test_a_holding_with_neither_makes_the_withdrawal_wait(self):
        s = self.rig(holding("h-1", "6.0"))
        self.assert_left_out(s, self.withdraw(s, 4 * CC), "life of a Canton Coin holding cannot be read")

    def test_the_meta_keys_may_carry_splices_prefix(self):
        s = self.rig(hold("h-1", 6 * CC, prefix="splice.lfdecentralizedtrust.org/"))
        self.withdraw(s, 4 * CC)
        self.custody_after(s, 2 * CC)
        self.build(s)
        self.assertEqual(self.inputs(s), ["h-1"])
        self.assertEqual(s.ledger.amulets, [])   # the view had them: no contract read


class Leaving(Rig):
    def test_dust_from_a_withdrawal_is_refused_with_its_sentence_and_the_leg_check_says_so_whole(self):
        s = self.rig(hold("h-1", cc("2.0")))
        t = self.withdraw(s, cc("1.9"))   # 1.9 of 2.0 would leave 0.1 CC, which runs out in about 2.7 days
        sentence = LEFT.format("0.1", "Withdraw at most 0.881984 CC, or exactly 2.0 CC (all that is left).")
        s.reth.trace_legs["0x" + "c9" * 20] = [Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, cc("1.9"), "r::1")]
        checked = b.leg_check(s.cfg, {"from": "0x" + "a1" * 20, "to": "0x" + "c9" * 20, "data": "0x1234"})
        self.assertEqual((checked["ok"], checked["reason"]), (False, sentence))
        self.reason(s, t, sentence)

    def test_another_holding_is_added_when_there_is_one(self):
        s = self.rig(hold("h-1", cc("2.0")), hold("h-2", cc("1.5")))
        self.withdraw(s, cc("1.9"))
        self.custody_after(s, cc("1.6"))
        self.build(s)
        self.assertEqual(sorted(self.inputs(s)), ["h-1", "h-2"])   # the change is 1.6 CC, not 0.1

    def test_custody_of_one_and_a_half_coins(self):
        total = cc("1.5")
        for name, units, refused in (("1.0 would leave 0.5", cc("1.0"), True),
                                     ("1.5 less the floor leaves exactly the floor", total - FLOOR, False),
                                     ("one base unit more would leave less than the floor", total - FLOOR + 1, True),
                                     ("all of it leaves nothing", total, False)):
            with self.subTest(name):
                s = self.rig(hold("h-1", total))
                t = self.withdraw(s, units)
                if refused:
                    self.reason(s, t, LEFT.format(b.canton_amount(total - units), "Withdraw at most 0.381984 CC, or exactly 1.5 CC (all that is left)."))
                else:
                    self.custody_after(s, total - units)
                    result = self.build(s)
                    self.assertEqual((self.inputs(s), result["leftOut"], result["custodyCheck"]), (["h-1"], [], "ok"))

    def test_when_the_floor_is_more_than_what_is_left_only_all_of_it_goes(self):
        s = self.rig(hold("h-1", life(20)))   # 0.745344 CC, under the floor of 1.118016
        t = self.withdraw(s, life(20) - 1)
        self.reason(s, t, "This withdrawal would leave 0.0000000001 CC of Canton Coin in the bridge, under its minimum of 1.118016 CC. Withdraw exactly 0.745344 CC (all that is left).")

    def test_an_old_holding_under_the_floor_cannot_be_left_alone(self):
        s = self.rig(hold("h-1", cc("1.0")), hold("h-2", cc("5.0")))   # 1.0 CC, under the floor, would stay behind
        t = self.withdraw(s, cc("5.0"))
        self.reason(s, t, LEFT.format("1.0", "Withdraw at most 4.881984 CC, or exactly 6.0 CC (all that is left)."))


class Inputs(Rig):
    def many(self, n, units=cc("1.2")):
        return [hold(f"h-{i:02d}", units, created=900 + i) for i in range(n)]   # the later the holding, the later it expires

    def test_with_more_than_the_cap_a_withdrawal_takes_the_nearest_expiry_and_the_next_takes_the_rest(self):
        s = self.rig(*self.many(8), k=3)
        self.withdraw(s, cc("3.6"))
        self.custody_after(s, cc("9.6") - cc("3.6"))
        self.build(s)
        self.assertEqual(self.inputs(s), ["h-00", "h-01", "h-02"])
        s.ledger.holdings = self.many(8)[3:]
        s.ledger.submitted.clear()
        self.withdraw(s, cc("3.6"), nonce=1)
        self.custody_after(s, cc("6.0") - cc("3.6"))
        self.build(s)
        self.assertEqual(self.inputs(s), ["h-03", "h-04", "h-05"])

    def test_a_round_that_allows_fewer_inputs_than_the_setting_wins(self):
        s = self.rig(*self.many(5), doc=rounds_doc(inputs="2"))
        self.withdraw(s, cc("2.4"))
        self.custody_after(s, cc("6.0") - cc("2.4"))
        self.build(s)
        self.assertEqual(self.inputs(s), ["h-00", "h-01"])

    def test_without_cover_in_the_cap_the_fewest_largest_first_and_the_free_slots_nearest_expiry_first(self):
        a, small, mid = hold("A", cc("10.0")), hold("B", cc("1.2"), created=900), hold("C", cc("1.3"))   # by expiry: B, C, A
        s = self.rig(a, small, mid, k=2)
        self.withdraw(s, cc("8.0"))
        self.custody_after(s, cc("12.5") - cc("8.0"))
        self.build(s)
        self.assertEqual(self.inputs(s), ["A", "B"])   # A covers it with change of 2.0; the free slot goes to B, the nearest to expiry

    def test_the_fill_stops_before_the_change_would_fall_under_the_floor(self):
        s = self.rig(hold("A", cc("8.0")), hold("B", cc("1.0"), created=900), hold("C", cc("1.3")), k=2)
        self.withdraw(s, cc("8.0"))   # A covers it exactly; B (1.0 CC) as change would be under the floor
        self.custody_after(s, cc("2.3"))
        self.build(s)
        self.assertEqual(self.inputs(s), ["A"])

    def test_a_withdrawal_that_needs_more_holdings_than_the_cap_is_left_out_with_the_most_it_can_take(self):
        s = self.rig(*self.many(5), k=2)
        t = self.withdraw(s, cc("3.6"))
        self.reason(s, t, "Covering this withdrawal takes more than 2 Canton Coin holdings. The most one withdrawal can take now is 2.4 CC.")

    def test_a_holding_at_or_past_its_expiry_round_is_never_an_input(self):
        gone = hold("gone", cc("0.2588"), created=0)   # expires at round 1000: the newest open round
        s = self.rig(gone, hold("h-1", 60 * CC))
        self.withdraw(s, 4 * CC)
        self.custody_after(s, 56 * CC)
        self.build(s)
        self.assertEqual(self.inputs(s), ["h-1"])
        row = b.custody_row(s.cfg, b.parse_rounds(rounds_doc()), [{"contractId": "gone", **gone[1]}], {"gone": (0, Fraction(RATE))}, 1000.0)
        self.assertEqual([h["level"] for h in row["holdings"]], ["expiring"])

    def test_the_holdings_are_merged_in_time_and_custody_never_falls_below_the_supply(self):
        """A small holding sits beside a large one over many withdrawals and rounds: the nearest expiry goes first, so the small one is merged at the first
        withdrawal and nothing ever reaches its expiry round."""
        rate, per_day = Fraction(RATE), 144
        held = {"big": (cc("50.0"), 0), "small": (cc("1.2"), 0)}   # amount, created round
        supply = sum(a for a, _ in held.values())
        for day in range(0, 90, 3):
            round_now = day * per_day
            for cid, (amount, created) in held.items():
                self.assertGreater(b.expiry_round(amount, created, rate), round_now + 1, f"{cid} ran out on day {day}")
            need = cc("0.5")
            picked, why = b.custody_inputs([(c, a, b.expiry_round(a, k, rate)) for c, (a, k) in held.items()], need, FLOOR, 50)
            self.assertIsNone(why)
            got = sum(held.pop(c)[0] for c in picked)
            held[f"change-{day}"] = (got - need, round_now)
            supply -= need
            self.assertEqual(sum(a for a, _ in held.values()), supply)
        self.assertEqual(len(held), 1)   # everything was merged into one holding


class Check(Rig):
    def block(self, withdrawn=4 * CC, held=60 * CC, after=None, **scan):
        s = self.rig(hold("h-1", held), **scan)
        self.withdraw(s, withdrawn)
        self.custody_after(s, held - withdrawn if after is None else after)
        return s

    def test_a_difference_of_nothing_passes_and_the_record_is_gone(self):
        s = self.block()
        result = self.build(s)
        self.assertEqual(result["custodyCheck"], "ok")
        self.assertEqual(s.ledger.holding_reads[-2:], [42, 43])   # the offset before the Advance's completion, and its completion offset
        self.assertFalse(b.custody_check_path(s.cfg).exists() or b.custody_stop_path(s.cfg).exists())

    def test_the_record_is_on_disk_before_the_advance_goes_out(self):
        s = self.block()
        seen = []
        real = b.Ledger.advance
        def spy(ledger, *a, **k):
            seen.append(json.loads(b.custody_check_path(s.cfg).read_text()))
            return real(ledger, *a, **k)
        with mock.patch.object(b.Ledger, "advance", spy):
            self.build(s)
        (rec,) = seen
        self.assertEqual((rec["begin"], rec["gateway"], rec["plan"]), (42, "gw", [{"instrument": TKB, "withdrawn": 4 * CC, "deposits": 0}]))
        self.assertEqual(rec["commandId"], s.ledger.submitted[0]["commandId"])

    def test_one_base_unit_more_or_less_writes_the_stop_and_only_canton_coin_withdrawals_wait(self):
        for off in (1, -1):
            with self.subTest(off):
                s = self.block(after=56 * CC + off)
                result = self.build(s)
                self.assertEqual(result["custodyCheck"], "stopped")
                stop = json.loads(b.custody_stop_path(s.cfg).read_text())
                self.assertEqual((stop["block"], stop["updateId"], stop["withdrawn"], stop["custodyBefore"], stop["custodyAfter"]),
                                 (HEAD_NEXT, "u1", "4.0", "60.0", b.canton_amount(56 * CC + off)))
                self.assertFalse(b.custody_check_path(s.cfg).exists())
                # the next block: its withdrawal is left out whole, the deposit and the payment of another token go on
                s.ledger.submitted.clear()
                s.ledger.terms = [TERMS]
                t_wd, t_dep, t_pay = self.withdraw(s, 4 * CC, nonce=1), self.deposit(s, FLOOR, BOB), self.leg_tx(s, PAY, tb.CAROL)
                s.reth.pool[ALICE], s.reth.pool[BOB], s.reth.pool[tb.CAROL] = [t_wd], [t_dep], [t_pay]
                result = self.build(s)
                self.assertEqual([x["reason"] for x in result["leftOut"]], [b.CUSTODY_STOPPED])
                self.assertEqual(sorted(l["tag"] for l in s.advance_argument()["legs"]), ["DepositLeg", "PaymentLeg"])

    def test_the_deposits_of_the_block_are_counted_and_a_claim_adds_nothing(self):
        s = self.block(after=60 * CC - 4 * CC + 10 * CC)   # the deposit's allocation is 10 CC
        s.ledger.requests = [REQUEST]
        t_dep = self.leg_tx(s, Leg(DEPOSIT, DEP_ID, WTKB, PAYEE, 10 * CC), BOB)
        s.reth.pool[BOB] = [t_dep]
        result = self.build(s)
        self.assertEqual((result["custodyCheck"], sorted(l["tag"] for l in s.advance_argument()["legs"])), ("ok", ["DepositLeg", "WithdrawalLeg"]))
        s = self.block()   # 56 after, with a claim redeemed in the same block: no false stop
        s.ledger.claims = [tb.CLAIM]
        s.reth.pool[BOB] = [self.leg_tx(s, tb.CLAIM_DEP, BOB)]
        result = self.build(s)
        self.assertEqual((result["custodyCheck"], sorted(l["tag"] for l in s.advance_argument()["legs"])), ("ok", ["ClaimLeg", "WithdrawalLeg"]))

    def test_a_restart_between_the_submit_and_the_check_finds_the_commit_by_its_command_id(self):
        s = self.block()
        with mock.patch.object(b, "run_custody_check", side_effect=OSError("the participant is down")):
            result = self.build(s)
        self.assertEqual(result["custodyCheck"], "pending")
        self.assertTrue(b.custody_check_path(s.cfg).exists())
        self.assertEqual(b.settle_custody(s.cfg), "ok")
        self.assertFalse(b.custody_check_path(s.cfg).exists())

    def test_until_the_record_is_cleared_withdrawals_wait_and_a_send_is_not_refused(self):
        s = self.block()
        with mock.patch.object(b, "run_custody_check", side_effect=OSError("the participant is down")):
            self.build(s)
        s.ledger.submitted.clear()
        t = self.withdraw(s, 4 * CC, nonce=1)
        self.assert_left_out(s, t, "custody check of the last Canton Coin withdrawal has not run yet", builds=3)
        s.reth.trace_legs["0x" + "c9" * 20] = [Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, 4 * CC, "r::1")]
        self.assertEqual(b.leg_check(s.cfg, {"from": "0x" + "a1" * 20, "to": "0x" + "c9" * 20, "data": "0x1234"}), {"ok": True})

    def test_a_command_that_never_committed_drops_the_record(self):
        s = self.block()
        b.write_json_file(b.custody_check_path(s.cfg), {"commandId": "never-sent", "begin": 42, "number": 5, "hash": "ab" * 32, "gateway": "gw", "plan": []})
        self.assertEqual(b.settle_custody(s.cfg), "dropped")
        self.assertFalse(b.custody_check_path(s.cfg).exists())
        self.assertIsNone(b.settle_custody(s.cfg))

    def test_a_block_canton_refused_leaves_no_record(self):
        s = self.block()
        s.ledger.refuse = "no"
        self.assertFalse(b.build_block(s.cfg)["committed"])
        self.assertFalse(b.custody_check_path(s.cfg).exists())

    def test_a_lost_reply_of_a_commit_is_still_checked(self):
        s = self.block()
        s.ledger.drop_but_commit = True
        result = self.build(s)
        self.assertEqual(result["custodyCheck"], "ok")

    def test_a_read_the_participant_refuses_writes_the_stop(self):
        s = self.block()
        s.ledger.refuse_offsets = {43}
        result = self.build(s)
        self.assertEqual(result["custodyCheck"], "stopped")
        self.assertIn("refused to show the holdings", json.loads(b.custody_stop_path(s.cfg).read_text())["reason"])

    def test_a_read_that_fails_for_a_while_keeps_the_record(self):
        s = self.block()
        calls = []   # the leg is built from a read at the ledger end; the two reads of the check name an offset and fail
        real = b.Ledger.active_holdings
        def flaky(ledger, offset=None):
            calls.append(offset)
            if offset is not None:
                raise OSError("down")
            return real(ledger, offset)
        with mock.patch.object(b.Ledger, "active_holdings", flaky):
            result = self.build(s)
        self.assertEqual((result["custodyCheck"], calls[-1]), ("pending", 42))
        self.assertTrue(b.custody_check_path(s.cfg).exists())

    def test_custody_clear_shows_and_removes_the_stop_and_nothing_else(self):
        s = self.block(after=1)
        self.build(s)
        with mock.patch.dict("os.environ", {"CZE_WORK_DIR": s.cfg.work_dir}):
            shown = b.custody_clear("dry-run")
            self.assertEqual((shown["dryRun"], shown["cleared"], shown["stopped"]["block"]), (True, False, HEAD_NEXT))
            self.assertTrue(b.custody_stop_path(s.cfg).exists())
            done = b.custody_clear("run")
            self.assertEqual((done["cleared"], done["stopped"]["block"]), (True, HEAD_NEXT))
            self.assertFalse(b.custody_stop_path(s.cfg).exists())
            self.assertEqual(b.custody_clear("run"), {"stopped": None, "cleared": False, "dryRun": False})
            with self.assertRaises(b.BuilderError):
                b.custody_clear(None)


HEAD_NEXT = tb.HEAD_NUMBER + 1


class Rows(Rig):
    def test_the_status_rows_carry_each_holdings_expiry_and_level(self):
        held = [hold("ok", life(20), created=NOW), hold("due", life(5), created=NOW), hold("alert", life(2), created=NOW), hold("gone", life(2), created=NOW - 288)]
        s = self.rig(*held)
        rows = b.custody_rows(s.cfg, 1_700_000_000.0)
        row = rows[ADMIN]
        self.assertEqual({k: row[k] for k in ("readAt", "floor", "floorDays", "dueDays", "alertDays", "maxInputs")},
                         {"readAt": "2023-11-14T22:13:20Z", "floor": "1.118016", "floorDays": 30, "dueDays": 7, "alertDays": 3, "maxInputs": 50})
        self.assertEqual([(h["contractId"], h["level"], h["daysLeft"], h["amount"]) for h in row["holdings"]],
                         [("gone", "expiring", 0.0, b.canton_amount(life(2))), ("alert", "alert", 2.0, b.canton_amount(life(2))),
                          ("due", "due", 5.0, b.canton_amount(life(5))), ("ok", "ok", 20.0, b.canton_amount(life(20)))])
        self.assertEqual(row["holdings"][1]["expiresAt"], "2023-11-16T22:13:20Z")
        self.assertEqual(row["holdings"][0]["expiresAt"], "2023-11-14T22:13:20Z")

    def test_the_producer_status_has_the_rows_and_the_stop(self):
        s = self.rig(hold("h-1", 20 * CC))
        stop = threading.Event()
        p = b.Producer(s.cfg, stop, status_file=str(Path(s.dir) / "status.json"))
        empty = p.status()["custody"][ADMIN]
        self.assertEqual((empty["readAt"], empty["holdings"], empty["stopped"], empty["floorDays"]), (None, [], None, 30))
        p.custody_step()
        row = p.status()["custody"][ADMIN]
        self.assertEqual((row["floor"], [h["contractId"] for h in row["holdings"]], row["stopped"]), ("1.118016", ["h-1"], None))
        b.write_json_file(b.custody_stop_path(s.cfg), {"reason": "x", "block": 7})
        self.assertEqual(p.status()["custody"][ADMIN]["stopped"], {"reason": "x", "block": 7})

    def test_the_loop_runs_a_kept_check_and_reads_the_rows_at_its_step(self):
        s = self.rig(hold("h-1", 20 * CC))
        p = b.Producer(s.cfg, threading.Event(), status_file=str(Path(s.dir) / "status.json"))
        b.write_json_file(b.custody_check_path(s.cfg), {"commandId": "never-sent", "begin": 42, "number": 5, "hash": "ab" * 32, "gateway": "gw", "plan": []})
        p.custody_step()
        self.assertFalse(b.custody_check_path(s.cfg).exists())   # no such command ever committed
        self.assertEqual(list(p.status()["custody"][ADMIN]["holdings"][0])[:2], ["contractId", "amount"])
        s.ledger.holdings = []
        p.custody_step()   # not due again yet
        self.assertEqual(len(p.status()["custody"][ADMIN]["holdings"]), 1)
        p.custody_dirty = True   # a block with legs committed
        p.custody_step()
        self.assertEqual(p.status()["custody"][ADMIN]["holdings"], [])

    def test_without_the_setting_the_status_has_no_custody(self):
        s = self.setup({})
        p = b.Producer(s.cfg, threading.Event(), status_file=str(Path(s.dir) / "status.json"))
        self.assertNotIn("custody", p.status())
        p.custody_step()   # does nothing


class Looped(Loop, Rig):
    """The loop, one block at a time and as the pipeline, makes the custody check and shows its outcome in the status file."""

    def setUp(self):
        Rig.setUp(self)

    def run_loop(self, engine, after):
        self.engine = engine
        s = self.rig(hold("h-1", 60 * CC))
        self.withdraw(s, 4 * CC)
        self.custody_after(s, after)
        p = self.producer(s, **({"max_in_flight": 1} if engine is b.Pipeline else {}))
        for _ in range(100):
            p.step()
            if any(r.get("committed") for r in self.reports):
                break
            time.sleep(0.01)
        self.assertTrue(any(r.get("committed") for r in self.reports), self.reports)
        p.custody_step()
        p.write_status()
        return s, p

    def test_a_commit_with_the_right_custody_leaves_no_stop(self):
        for engine in (b.Producer, b.Pipeline):
            with self.subTest(engine.__name__):
                s, p = self.run_loop(engine, 56 * CC)
                self.assertEqual([r["custodyCheck"] for r in self.reports if r.get("committed")], ["ok"])
                row = self.status()["custody"][ADMIN]
                self.assertEqual((row["stopped"], [h["contractId"] for h in row["holdings"]]), (None, ["h-1"]))

    def test_a_difference_stops_the_next_withdrawal_and_the_status_says_so(self):
        for engine in (b.Producer, b.Pipeline):
            with self.subTest(engine.__name__):
                s, p = self.run_loop(engine, 56 * CC + 1)
                self.assertEqual([r["custodyCheck"] for r in self.reports if r.get("committed")], ["stopped"])
                self.assertEqual(self.status()["custody"][ADMIN]["stopped"]["custodyAfter"], b.canton_amount(56 * CC + 1))
                self.assertTrue(b.custody_stop_path(s.cfg).exists())


class Settings(unittest.TestCase):
    DSO = "DSO::1220" + "ab" * 32

    def cfg(self, **k):
        cfg = mock.Mock(registries={self.DSO: "https://scan.example"}, registry_tokens={self.DSO: "/f"}, expiring=(), **k)
        return cfg

    def check(self, *flags, cfg=None):
        cfg = cfg or self.cfg()
        b.check_expiring(b.parser().parse_args(["run", *flags]), cfg)
        return cfg

    def test_the_defaults_and_what_is_set(self):
        cfg = self.check("--expiring-instrument", self.DSO)
        self.assertEqual((cfg.expiring, cfg.custody_floor_days, cfg.custody_due_days, cfg.custody_alert_days, cfg.max_transfer_inputs), ((self.DSO,), 30, 7, 3, 50))
        cfg = self.check("--expiring-instrument", self.DSO, "--custody-floor-days", "20", "--custody-due-days", "5", "--custody-alert-days", "1", "--max-transfer-inputs", "10")
        self.assertEqual((cfg.custody_floor_days, cfg.custody_due_days, cfg.custody_alert_days, cfg.max_transfer_inputs), (20, 5, 1, 10))

    def test_nothing_is_checked_or_set_without_an_instrument(self):
        cfg = self.cfg()
        cfg.expiring = ()
        self.check("--custody-due-days", "1", cfg=cfg)   # out of order, but no instrument is named
        self.assertEqual(cfg.expiring, ())

    def test_thresholds_out_of_order_are_refused(self):
        for flags in (("--custody-due-days", "3"), ("--custody-alert-days", "7"), ("--custody-due-days", "30"), ("--custody-floor-days", "7"),
                      ("--custody-alert-days", "-1"), ("--custody-floor-days", "inf"), ("--custody-due-days", "nan")):
            with self.subTest(flags), self.assertRaises(b.BuilderError):
                self.check("--expiring-instrument", self.DSO, *flags)

    def test_an_instrument_needs_its_registry_and_token_and_a_party_name(self):
        for cfg in (mock.Mock(registries={}, registry_tokens={}, expiring=()), mock.Mock(registries={self.DSO: "https://x"}, registry_tokens={}, expiring=())):
            with self.assertRaisesRegex(b.BuilderError, "needs its token registry"):
                self.check("--expiring-instrument", self.DSO, cfg=cfg)
        with self.assertRaisesRegex(b.BuilderError, "instrument admin party"):
            self.check("--expiring-instrument", "not-a-party")
        with self.assertRaises(b.BuilderError):
            self.check("--expiring-instrument", self.DSO, "--max-transfer-inputs", "0")

    def test_custody_clear_is_a_command_and_the_modes_are_for_it_alone(self):
        self.assertEqual(vars(b.parser().parse_args(["custody-clear", "dry-run"]))["mode"], "dry-run")
        self.assertIsNone(b.parser().parse_args(["run"]).mode)
        self.assertEqual(b.parser().parse_args(["custody-clear", "run"]).command, "custody-clear")


if __name__ == "__main__":
    unittest.main()
