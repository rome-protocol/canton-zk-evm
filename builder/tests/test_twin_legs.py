"""The twin legs (Daml 0.5.0): a payment into a registered vault is a LockLeg, with the parts of the lock's id from the twin registry service; a payment
whose id is the release id of a redeem request is a ReleaseLeg. Both name the twin pinned for the token in `ZkChain.twins`. Against the same fakes as
test_builder.py, and a fake registry service."""
import hashlib, json, sys, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import PAYMENT, Leg, tx

ALICE, TKA, PAYEE, named = tb.ALICE, tb.TKA, tb.PAYEE, tb.named
VAULT, OTHER_VAULT = "ca" * 20, "cb" * 20
RECEIVER, REF = "alice::1220abcd", "order-7"
RULES = "rules-1"
USDC_DECIMALS = 6


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


LOCK_ID = sha(f"lock,{RECEIVER},{REF}")
RELEASE_ID = sha(f"vault-release,{VAULT},{REF}")
VAULT_ENTRY = {"contractAddress": VAULT, "contractCodeHash": "c1" * 32, "contractKind": "Vault"}
PIN = {"twinToken": TKA, "twinDecimals": str(USDC_DECIMALS), "twinRules": RULES}
LOCK = Leg(PAYMENT, LOCK_ID, TKA, VAULT, 2_500_000)   # 2.5 of a 6-decimal token
RELEASE = Leg(PAYMENT, RELEASE_ID, TKA, PAYEE, 2_500_000)
REDEEM = ("redeem-1", {**named, "gateway": "gw", "holder": "alice::1220abcd", "token": TKA, "holdings": ["h-1"], "amount": "2.5", "recipient": PAYEE, "ref": REF})


class Registry:
    """A fake twin registry service: GET /twin/v1/lock-parts/<id>."""

    def __init__(self, parts=None, status=None):
        self.parts, self.status, self.asked = dict(parts or {}), status, []
        registry = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_GET(self):
                registry.asked.append(self.path)
                lock_id = self.path.rsplit("/", 1)[1]
                if registry.status:
                    code, body = registry.status, b"{}"
                elif lock_id in registry.parts:
                    code, body = 200, json.dumps({"lockId": lock_id, **registry.parts[lock_id]}).encode()
                else:
                    code, body = 404, b"{}"
                self.send_response(code)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        self.server = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()


class Twins(tb.LegCase):
    def setup_twin(self, leg, parts=True, pins=(PIN,), vaults=(VAULT_ENTRY,), redeems=(), registry=True, **k):
        s = self.setup({ALICE: []}, **k)
        s.ledger.chain_extra = {"contracts": list(vaults), "twins": list(pins) if pins is not None else None}
        s.ledger.redeems = list(redeems)
        t = self.leg_tx(s, leg)
        s.reth.pool[ALICE] = [t]
        if registry:
            s.registry = Registry({LOCK_ID: {"receiver": RECEIVER, "ref": REF}} if parts is True else parts or {})
            self.addCleanup(s.registry.close)
            s.cfg.twin_registry_url = s.registry.url
        return s, t

    # ---- the lock
    def test_a_payment_into_a_vault_is_a_lock_naming_the_pinned_rules(self):
        s, t = self.setup_twin(LOCK)
        result = self.build(s)
        self.assertEqual(self.attached(s, "LockLeg"), {"lockRules": RULES, "lockReceiver": RECEIVER, "lockRef": REF, "lockVault": VAULT, "lockAmount": f"{2_500_000:064x}"})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertEqual(s.registry.asked, [f"/twin/v1/lock-parts/{LOCK_ID}"])

    def test_a_lock_the_registry_has_no_parts_for_is_left_out(self):
        s, t = self.setup_twin(LOCK, parts={})
        self.assert_left_out(s, t, "no parts")

    def test_parts_that_do_not_make_the_id_leave_the_lock_out(self):
        s, t = self.setup_twin(LOCK, parts={LOCK_ID: {"receiver": "bob::1", "ref": REF}})
        self.assert_left_out(s, t, "do not make the lock's id")

    def test_a_failing_registry_leaves_the_lock_out(self):
        s, t = self.setup_twin(LOCK)
        s.registry.status = 500
        self.assert_left_out(s, t, "HTTP 500")

    def test_an_unreachable_registry_leaves_the_lock_out(self):
        s, t = self.setup_twin(LOCK)
        s.cfg.twin_registry_url = "http://127.0.0.1:1"
        self.assert_left_out(s, t, "cannot be read")

    def test_a_builder_with_no_registry_leaves_the_lock_out(self):
        s, t = self.setup_twin(LOCK, registry=False)
        self.assert_left_out(s, t, "no twin registry")

    def test_a_lock_of_an_unpinned_token_is_left_out(self):
        for pins in (None, [], [{**PIN, "twinToken": "44" * 20}]):
            s, t = self.setup_twin(LOCK, pins=pins)
            self.assert_left_out(s, t, "not pinned")

    def test_a_lock_finer_than_the_twin_is_left_out(self):
        s, t = self.setup_twin(LOCK, pins=[{**PIN, "twinDecimals": "18"}])   # 2_500_000 base units of 18 decimals: not a multiple of 10^8
        self.assert_left_out(s, t, "not exact")

    def test_an_18_decimal_lock_that_is_a_multiple_is_attached(self):
        s, t = self.setup_twin(Leg(PAYMENT, LOCK_ID, TKA, VAULT, 3 * 10**18), pins=[{**PIN, "twinDecimals": "18"}])
        self.build(s)
        self.assertEqual(self.attached(s, "LockLeg")["lockAmount"], f"{3 * 10**18:064x}")

    def test_a_payment_to_another_address_is_not_a_lock(self):
        s, t = self.setup_twin(Leg(PAYMENT, LOCK_ID, TKA, OTHER_VAULT, 10))
        self.assert_left_out(s, t, "no terms of this chain")

    # ---- the release
    def test_a_vault_payment_with_a_redeem_request_is_a_release(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM])
        result = self.build(s)
        self.assertEqual(self.attached(s, "ReleaseLeg"), {"releaseRequest": "redeem-1", "releaseRules": RULES, "releaseVault": VAULT})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))

    def test_a_release_with_no_request_is_left_out(self):
        s, t = self.setup_twin(RELEASE)
        self.assert_left_out(s, t, "no terms of this chain")

    def test_a_release_whose_request_differs_is_left_out(self):
        for field, value, words in (("token", "55" * 20, "another token"), ("recipient", "dd" * 20, "another recipient"), ("amount", "2.4", "amount"),
                                    ("operator", "other-op", "no terms")):
            s, t = self.setup_twin(RELEASE, redeems=[(REDEEM[0], {**REDEEM[1], field: value})])
            self.assert_left_out(s, t, words)

    def test_a_release_of_an_unpinned_token_is_left_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM], pins=None)
        self.assert_left_out(s, t, "not pinned")

    def test_the_second_release_of_one_request_is_left_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM])
        t2 = self.leg_tx(s, RELEASE, nonce=0, sender=tb.BOB)
        s.reth.pool[tb.BOB] = [t2]
        result = self.build(s)
        self.assertEqual(result["legs"], 1)
        self.assertEqual(len(result["leftOut"]), 1)

    def test_a_participant_without_the_redeem_template_leaves_the_release_out(self):
        s, t = self.setup_twin(RELEASE, redeems=[REDEEM])
        s.ledger.no_040 = True
        self.assert_left_out(s, t, "no terms of this chain")

    # ---- the readers
    def test_the_amount_conversions_are_exact(self):
        self.assertEqual(b.twin_units(2_500_000, 6), 25_000_000_000)
        self.assertEqual(b.twin_units(10**8, 18), 1)
        self.assertIsNone(b.twin_units(10**8 + 1, 18))
        self.assertIsNone(b.twin_units(0, 6))
        self.assertEqual(b.twin_base_units(25_000_000_000, 6), 2_500_000)
        self.assertEqual(b.twin_base_units(1, 18), 10**8)
        self.assertIsNone(b.twin_base_units(25_000_000_001, 6))

    def test_pinned_twins_reads_the_record_and_refuses_a_bad_entry(self):
        self.assertEqual(b.pinned_twins({}), {})
        self.assertEqual(b.pinned_twins({"twins": [PIN]}), {TKA: (RULES, 6)})
        for bad in ({"twinToken": "xx"}, {**PIN, "twinDecimals": "37"}, {**PIN, "twinRules": ""}):
            with self.assertRaises(b.BuilderError):
                b.pinned_twins({"twins": [bad]})


if __name__ == "__main__":
    unittest.main()
