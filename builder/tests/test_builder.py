"""The builder, against fakes only: a fake reth (builder-only WebSocket port and Engine port), a fake Canton JSON
Ledger API and a fake prover. No real Canton, GPU or reth. Run: python3 -m unittest discover -s builder/tests"""
import base64, contextlib, hashlib, hmac, io, json, os, re, shutil, sys, tempfile, unittest
from datetime import datetime, timezone
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
from keccak import keccak256
from fakes import (BUILDER, DEPOSIT, GATEWAY, HEAD_HASH, HEAD_NUMBER, JWT_SECRET, LEDGER_TOKEN, LEG_TOPIC, PAYMENT, WITHDRAWAL,
                   FakeLedger, FakeReth, Leg, Raw, raw_of, rlp, tx)

ALICE, BOB, CAROL = "0x" + "a1" * 20, "0x" + "b2" * 20, "0x" + "c4" * 20   # senders of EVM transactions
PAY_ID, DEP_ID, WD_ID = "ee" * 32, "dd" * 32, "ab" * 32
TKA, WTKB, WTKC = "11" * 20, "22" * 20, "33" * 20   # an ERC-20 that payments are made in, and two wrapped tokens
PAYEE = "c3" * 20
TKB = {"admin": "adm", "id": "TKB"}   # the Canton instrument that WTKB wraps
TKC = {"admin": "adm", "id": "TKC"}
UNIT = 10**10   # base units in one Canton unit

# What the chain's Canton contracts look like in the Ledger API's JSON, and the Leg events that go with each.
named = {"operator": "op", "confirmer": "co", "builder": BUILDER, "chainId": "770101"}
TERMS = ("terms-1", {**named, "u": "u::1", "v": "v::1", "label": "dvp-1", "dvpId": PAY_ID, "token": TKA, "payee": PAYEE,
                     "amount": "00" * 31 + "0a", "allocation": "alloc-1"})
REQUEST = ("req-1", {**named, "gateway": "gw", "depositor": "d::1", "depositId": DEP_ID, "recipient": PAYEE, "allocation": "alloc-d1"})
TOKEN = ("tok-1", {**named, "gateway": "gw", "evmToken": WTKB, "instrumentId": TKB, "factory": "fac-1"})
TOKEN_C = ("tok-2", {**named, "gateway": "gw", "evmToken": WTKC, "instrumentId": TKC, "factory": "fac-2"})
ACCEPTANCE = ("acc-1", {**named, "gateway": "gw", "party": "r::1"})
def holding(cid, amount, instrument=TKB, owner="gw", lock=None):
    return cid, {"owner": owner, "instrumentId": instrument, "amount": amount, "lock": lock, "meta": {"values": {}}}

PAY = Leg(PAYMENT, PAY_ID, TKA, PAYEE, 10)
DEP = Leg(DEPOSIT, DEP_ID, WTKB, PAYEE, 10 * UNIT)
WD = Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, 4 * UNIT, "r::1")


class Setup:
    def __init__(self, pool, gas_cap=30_000_000, terms=(), refuse=None, fail_but_commit=False, drop_but_commit=False, allocations=None, chains=1, bad_json=False, prover_fails=False, prover_writes_nothing=False, secret=JWT_SECRET):
        self.dir = tempfile.mkdtemp()
        self.reth = FakeReth(pool, gas_limit=gas_cap)
        self.ledger = FakeLedger(gas_cap, terms, refuse, fail_but_commit, drop_but_commit, allocations, chains, bad_json)
        self.log = Path(self.dir) / "log"
        os.environ["FAKE_LOG"] = str(self.log)
        os.environ["FAKE_PROVER_FAILS"] = "1" if prover_fails else ""
        os.environ["FAKE_PROVER_WRITES_NOTHING"] = "1" if prover_writes_nothing else ""
        genesis = Path(self.dir) / "genesis.json"
        genesis.write_text("{}")
        self.cfg = b.Config(ws_url=self.reth.ws_url, engine_url=self.reth.engine_url, jwt_secret=secret,
                            ledger_url=self.ledger.url, ledger_user="builder-user", ledger_token=LEDGER_TOKEN,
                            party=BUILDER, fee_recipient="0x" + "fe" * 20, genesis=str(genesis), work_dir=str(Path(self.dir) / "work"),
                            make_input_cmd=str(HERE / "fake-make-input.sh"), prove_cmd=str(HERE / "fake-prove.sh"))

    def close(self):
        self.reth.close(); self.ledger.close(); shutil.rmtree(self.dir)

    def engine(self, method=None):
        return [p for m, p in self.reth.engine_calls if method is None or m == method]

    def forkchoices(self):
        return [p[0] for m, p in self.reth.engine_calls if m == "engine_forkchoiceUpdatedV3"]

    def builds(self):
        """The transaction lists reth was asked to build blocks from, one per build."""
        return [p[2] for m, p in self.reth.ws_calls if m == "testing_buildBlockV1"]

    def advance_argument(self):
        (sub,) = self.ledger.submitted
        return sub["commands"][0]["ExerciseCommand"]["choiceArgument"]


class Case(unittest.TestCase):
    def setup(self, *a, **k):
        s = Setup(*a, **k)
        self.addCleanup(s.close)
        return s

    def build(self, s, **k):
        result = b.build_block(s.cfg, **k)
        self.assertTrue(result["committed"], result)
        return result

    def in_pool(self, s):
        return {t["hash"] for ts in s.reth.pool.values() for t in ts}

class OneBlock(Case):
    def test_one_good_block_end_to_end(self):
        t1, t2 = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [t1], BOB: [t2]}, terms=[TERMS])
        s.reth.tx_legs[t2["hash"]] = [PAY]
        result = self.build(s)
        self.assertEqual(result["number"], HEAD_NUMBER + 1)
        # reth: the explicit list, in price order, with Prague attributes and an empty withdrawals list
        (build,) = [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"]
        parent, attrs, raws, extra = build
        self.assertEqual((parent, raws, extra), (HEAD_HASH, [raw_of(t1), raw_of(t2)], None))
        self.assertEqual(attrs["withdrawals"], [])
        self.assertEqual(attrs["suggestedFeeRecipient"], "0x" + "fe" * 20)
        self.assertEqual(attrs["parentBeaconBlockRoot"], "0x" + "00" * 32)
        self.assertEqual(attrs["prevRandao"], "0x" + "00" * 32)
        self.assertGreater(int(attrs["timestamp"], 16), 1000)
        # the Engine API: back to Canton's head, the new payload, head = n and not final, then final
        n_hash = result["blockHash"]
        safe = {"headBlockHash": HEAD_HASH, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH}
        self.assertEqual(s.forkchoices(), [safe,
                         {"headBlockHash": n_hash, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH},
                         {"headBlockHash": n_hash, "safeBlockHash": n_hash, "finalizedBlockHash": n_hash}])
        payload, hashes, root, requests = s.engine("engine_newPayloadV4")[0]
        self.assertEqual((payload["blockHash"], hashes, root, requests), (n_hash, [], "0x" + "00" * 32, []))
        # the prover got the block and its witness through the input tool, and its proof went into Advance
        self.assertEqual([l.split()[0] for l in s.log.read_text().splitlines()], ["make-input", "prove"])
        self.assertEqual([m for m, _ in s.reth.ws_calls if m in ("debug_executionWitness", "debug_getRawBlock")],
                         ["debug_getRawBlock", "debug_executionWitness"])
        # Advance: as the builder, with the proof, the gateway's two proofs and the leg
        (sub,) = s.ledger.submitted
        self.assertEqual(sub["userId"], "builder-user")
        self.assertEqual(sub["actAs"], [BUILDER])
        (cmd,) = sub["commands"]
        ex = cmd["ExerciseCommand"]
        self.assertEqual((ex["contractId"], ex["choice"]), ("chain-cid", "Advance"))
        self.assertTrue(ex["templateId"].endswith(":Zk.Chain:ZkChain"))
        arg = ex["choiceArgument"]
        self.assertEqual(arg["proofHex"], "ab" * 1344)
        self.assertEqual(keccak256(bytes.fromhex(arg["headerHex"])).hex(), n_hash[2:])
        self.assertEqual(arg["txsHex"], rlp([bytes.fromhex(raw_of(t1)[2:]), bytes.fromhex(raw_of(t2)[2:])]).hex())
        self.assertEqual((arg["gatewayAccountNodes"], arg["gatewayStorageNodes"]), (["aa01", "aa02"], ["bb01"]))
        self.assertEqual(arg["legs"], [{"tag": "PaymentLeg", "value": {"terms": "terms-1"}}])
        self.assertEqual(sorted(arg), ["gatewayAccountNodes", "gatewayStorageNodes", "headerHex", "legs", "proofHex", "txsHex"])
        self.assertEqual(s.ledger.bad_auth, 0)

    def test_the_gateways_proofs_are_asked_for_at_the_new_block_and_nothing_else_is(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        self.build(s)
        n = HEAD_NUMBER + 1
        slot = "0x" + keccak256(n.to_bytes(32, "big") + bytes(32)).hex()   # Solidity's key for legs[n], the mapping at slot 0
        self.assertEqual([p for m, p in s.reth.ws_calls if m == "eth_getProof"], [["0x" + GATEWAY, [slot], hex(n)]])

    def test_the_legs_are_read_from_the_gateways_events_of_the_new_block(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        result = self.build(s)
        self.assertEqual([p for m, p in s.reth.ws_calls if m == "eth_getLogs"],
                         [[{"blockHash": result["blockHash"], "address": "0x" + GATEWAY, "topics": [LEG_TOPIC]}]])

    def test_an_empty_block_proves_it_needs_no_legs(self):
        s = self.setup({})
        result = self.build(s)
        arg = s.advance_argument()
        self.assertEqual((arg["txsHex"], arg["legs"]), ("", []))
        self.assertEqual((arg["gatewayAccountNodes"], arg["gatewayStorageNodes"]), (["aa01", "aa02"], ["bb01"]))
        self.assertEqual((result["legs"], result["leftOut"], result["legTransactions"]), (0, [], []))
        self.assertEqual(len(s.ledger.queries), 1)   # only the chain: a block with no legs needs nothing else from Canton

    def test_the_advance_argument_is_saved_in_the_blocks_work_folder(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, terms=[TERMS])
        s.reth.tx_legs[t["hash"]] = [PAY]
        self.build(s)
        saved = json.loads((Path(s.cfg.work_dir) / f"block-{HEAD_NUMBER + 1}" / "advance.json").read_text())
        self.assertEqual(saved, s.advance_argument())

    def test_the_argument_is_saved_also_when_canton_refuses_it(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="no")
        self.assertFalse(b.build_block(s.cfg)["committed"])
        saved = json.loads((Path(s.cfg.work_dir) / f"block-{HEAD_NUMBER + 1}" / "advance.json").read_text())
        self.assertEqual(saved, s.advance_argument())

    def test_a_balance_is_not_a_leg_and_no_token_is_asked_about(self):
        # A plain transfer to the payee makes no Leg event, so it settles nothing, whatever the terms say.
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, terms=[TERMS])
        result = self.build(s)
        self.assertEqual(result["legs"], 0)
        self.assertEqual(s.advance_argument()["legs"], [])
        self.assertEqual(result["leftOut"], [])

    def test_the_report_names_the_transactions_that_recorded_legs(self):
        t1, t2, t3 = tx(ALICE, 0), tx(BOB, 0, price=5), tx(CAROL, 0, price=1)
        s = self.setup({ALICE: [t1], BOB: [t2], CAROL: [t3]}, terms=[TERMS])
        s.ledger.requests, s.ledger.tokens = [REQUEST], [TOKEN]
        s.reth.tx_legs[t1["hash"]] = [PAY]
        s.reth.tx_legs[t2["hash"]] = [DEP]
        result = self.build(s)
        self.assertEqual(result["legs"], 2)
        self.assertEqual(result["legTransactions"], [t1["hash"], t2["hash"]])
        self.assertEqual(result["transactions"], [t1["hash"], t2["hash"], t3["hash"]])

    def test_an_empty_block_sends_empty_txs_hex(self):
        s = self.setup({})
        self.assertTrue(b.build_block(s.cfg)["committed"])
        self.assertEqual(s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["txsHex"], "")

    def test_a_late_commit_after_a_failed_reply_still_counts(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="timed out", fail_but_commit=True)
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"])
        self.assertEqual(s.forkchoices()[-1]["finalizedBlockHash"], result["blockHash"])

    def test_a_dropped_connection_after_a_commit_still_counts(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(s.forkchoices()[-1]["finalizedBlockHash"], result["blockHash"])

    def test_a_reply_that_is_not_http_is_a_lost_reply_and_a_commit_still_counts(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.garbage_reply = True   # http.client raises BadStatusLine, an HTTPException that is not an OSError
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(s.forkchoices()[-1]["finalizedBlockHash"], result["blockHash"])

    def test_a_reply_that_is_not_http_and_no_commit_is_a_refusal(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.garbage_reply, s.ledger.commit = True, False
        result = b.build_block(s.cfg)
        self.assertIs(result["committed"], False)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)

    def test_a_lost_reply_and_an_unreadable_head_is_unknown_and_reth_stays_where_it_is(self):
        for commit in (True, False):   # whether or not Canton committed, the builder cannot tell
            s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
            s.ledger.commit, s.ledger.head_fails_after_submit = commit, True
            result = b.build_block(s.cfg)
            self.assertIsNone(result["committed"], result)
            self.assertEqual(result["number"], HEAD_NUMBER + 1)
            self.assertIn("no usable reply from Canton", result["reason"])
            self.assertIn("Canton's head", result["reason"])
            self.assertEqual(len(s.ledger.submitted), 1)
            # reth is not moved: the last forkchoice is the one that made the new block its head
            n_hash = result["blockHash"]
            self.assertEqual(s.forkchoices()[-1], {"headBlockHash": n_hash, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH})

    def test_the_next_run_after_an_unknown_outcome_starts_from_canton_head(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.head_fails_after_submit = True
        first = b.build_block(s.cfg)
        self.assertIsNone(first["committed"])
        s.ledger.head_fails_after_submit, s.ledger.drop_but_commit = False, False   # Canton is reachable again; it had committed
        second = b.build_block(s.cfg)
        self.assertEqual(second["number"], HEAD_NUMBER + 2)
        h = first["blockHash"]
        self.assertEqual(s.forkchoices()[2], {"headBlockHash": h, "safeBlockHash": h, "finalizedBlockHash": h})   # the second run's first move

    def test_a_dropped_connection_before_a_commit_is_a_refusal(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.commit = False   # the connection drops and Canton did not commit
        result = b.build_block(s.cfg)
        self.assertFalse(result["committed"])
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)


class LegCase(Case):
    """A block with legs: the builder reads them from reth, finds each one's Canton side, and either attaches it or
    builds the block again without the transaction that recorded it."""

    def leg_tx(self, s, leg, sender=ALICE, nonce=0, **k):
        t = tx(sender, nonce, **k)
        s.reth.tx_legs[t["hash"]] = [leg] if isinstance(leg, Leg) else leg
        return t

    def attached(self, s, tag):
        legs = s.advance_argument()["legs"]
        self.assertEqual([l["tag"] for l in legs], [tag])
        return legs[0]["value"]

    def assert_left_out(self, s, t, *words, builds=2):
        """The block was built again without t, committed with no leg, and the report says why t was left out."""
        result = self.build(s)
        self.assertEqual(result["legs"], 0)
        self.assertEqual(s.advance_argument()["legs"], [])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [t["hash"]])
        for w in words:
            self.assertIn(w, result["leftOut"][0]["reason"])
        self.assertEqual(len(s.builds()), builds)
        self.assertNotIn(raw_of(t), s.builds()[-1])
        self.assertNotIn(t["hash"], result["transactions"])
        return result


class Payments(LegCase):
    def setup_pay(self, terms=(TERMS,), **k):
        s = self.setup({ALICE: []}, terms=list(terms), **k)
        t = tx(ALICE, 0)
        s.reth.pool[ALICE] = [t]
        s.reth.tx_legs[t["hash"]] = [PAY]
        return s, t

    def test_a_payment_with_its_terms_is_attached(self):
        s, t = self.setup_pay()
        result = self.build(s)
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-1"})
        self.assertEqual((result["legs"], result["leftOut"], len(s.builds())), (1, [], 1))

    def test_no_terms_for_the_payment_means_it_is_left_out_and_the_block_is_built_again(self):
        s, t = self.setup_pay(terms=())
        self.assert_left_out(s, t, "no terms", "payment")
        # reth went back to Canton's head between the two builds, and the second block is the one that was proven and sent
        safe = {"headBlockHash": HEAD_HASH, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH}
        fcs = s.forkchoices()
        first, second = [p[0]["blockHash"] for p in s.engine("engine_newPayloadV4")]
        self.assertEqual(fcs, [safe,
                               {"headBlockHash": first, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH}, safe,
                               {"headBlockHash": second, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH},
                               {"headBlockHash": second, "safeBlockHash": second, "finalizedBlockHash": second}])
        self.assertEqual(s.log.read_text().count("prove"), 1)   # nothing was proven for the first block
        self.assertEqual(keccak256(bytes.fromhex(s.advance_argument()["headerHex"])).hex(), second[2:])

    def test_terms_for_another_payment_do_not_match(self):
        other = ("terms-2", {**TERMS[1], "dvpId": "ff" * 32})
        s, t = self.setup_pay(terms=[other])
        self.assert_left_out(s, t, "no terms")

    def test_terms_that_name_another_token_payee_or_amount_do_not_match(self):
        for field, value, word in (("token", "44" * 20, "token"), ("payee", "55" * 20, "payee"), ("amount", "00" * 31 + "0b", "amount")):
            with self.subTest(field):
                s, t = self.setup_pay(terms=[("terms-2", {**TERMS[1], field: value})])
                self.assert_left_out(s, t, word)

    def test_terms_of_another_chain_operator_or_confirmer_do_not_match(self):
        for field, value in (("chainId", "1"), ("operator", "someone-else"), ("confirmer", "someone-else")):
            with self.subTest(field):
                s, t = self.setup_pay(terms=[("terms-2", {**TERMS[1], field: value})])
                self.assert_left_out(s, t, "no terms")

    def test_a_withdrawn_allocation_means_the_payment_is_left_out(self):
        s, t = self.setup_pay(allocations=[])
        self.assert_left_out(s, t, "allocation", "not active")

    def test_a_passed_settle_before_means_the_payment_is_left_out(self):
        s, t = self.setup_pay()
        s.ledger.views["alloc-1"] = {"settleBefore": "2020-01-01T00:00:00.123456Z"}
        self.assert_left_out(s, t, "settle-before")

    def test_the_deadline_is_judged_by_the_builders_clock(self):
        for now, legs in ((2029, 1), (2031, 0)):
            s, t = self.setup_pay()
            s.ledger.views["alloc-1"] = {"settleBefore": "2030-01-01T00:00:00Z"}
            with mock.patch.object(b, "utcnow", lambda now=now: datetime(now, 6, 1, tzinfo=timezone.utc)):
                self.assertEqual(b.build_block(s.cfg)["legs"], legs, now)

    def test_a_settle_before_that_cannot_be_read_means_the_payment_is_left_out(self):
        s, t = self.setup_pay()
        s.ledger.views["alloc-1"] = {"settleBefore": "tomorrow"}
        self.assert_left_out(s, t, "settle-before")

    def test_an_executor_that_is_not_the_chains_operator_means_the_payment_is_left_out(self):
        s, t = self.setup_pay()
        s.ledger.views["alloc-1"] = {"executor": "someone-else"}
        self.assert_left_out(s, t, "executor")

    def test_a_sender_that_is_not_u_means_the_payment_is_left_out(self):
        s, t = self.setup_pay()
        s.ledger.views["alloc-1"] = {"sender": "v::1", "receiver": "v::1"}
        self.assert_left_out(s, t, "sender", "u")

    def test_a_receiver_that_is_not_v_means_the_payment_is_left_out(self):
        s, t = self.setup_pay()
        s.ledger.views["alloc-1"] = {"receiver": "u::1"}
        self.assert_left_out(s, t, "receiver", "v")

    def test_an_allocation_without_a_visible_view_means_the_payment_is_left_out(self):
        s, t = self.setup_pay()
        s.ledger.views["alloc-1"] = None
        self.assert_left_out(s, t, "view")

    def test_the_interface_view_is_asked_for(self):
        s, t = self.setup_pay()
        self.build(s)
        asked = [q["eventFormat"]["filtersByParty"][BUILDER]["cumulative"][0]["identifierFilter"].get("InterfaceFilter") for q in s.ledger.queries]
        (asked,) = [i for i in asked if i]
        self.assertTrue(asked["value"]["includeInterfaceView"])
        self.assertEqual(asked["value"]["interfaceId"], "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation")

    def test_two_payments_for_one_allocation_leave_the_later_one_out(self):
        twin = ("terms-2", {**TERMS[1], "dvpId": "ff" * 32})   # the same allocation, alloc-1
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS, twin])
        t1, t2 = self.leg_tx(s, PAY, ALICE, price=9), self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), BOB, price=1)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [t1], [t2]
        result = self.build(s)
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [t2["hash"]])
        self.assertIn("same allocation", result["leftOut"][0]["reason"])
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-1"})

    def test_terms_left_for_another_payment_do_not_take_an_allocation(self):
        # terms-1 is for a payment nobody made; terms-2 is for the payment in the block and has the same allocation
        unused = ("terms-0", {**TERMS[1], "dvpId": "ff" * 32})
        s, t = self.setup_pay(terms=[unused, ("terms-2", TERMS[1])])
        self.build(s)
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-2"})

    def test_a_plain_transfer_in_the_same_block_changes_nothing(self):
        s, t = self.setup_pay()
        plain = tx(BOB, 0, price=1)   # a transfer to the payee: no Leg event
        s.reth.pool[BOB] = [plain]
        result = self.build(s)
        self.assertEqual(result["transactions"], [t["hash"], plain["hash"]])
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-1"})


class Deposits(LegCase):
    def setup_dep(self, requests=(REQUEST,), tokens=(TOKEN,), **k):
        s = self.setup({ALICE: []}, **k)
        s.ledger.requests, s.ledger.tokens = list(requests), list(tokens)
        t = self.leg_tx(s, DEP)
        s.reth.pool[ALICE] = [t]
        return s, t

    def test_a_claim_with_its_request_and_token_is_attached(self):
        s, t = self.setup_dep()
        result = self.build(s)
        self.assertEqual(self.attached(s, "DepositLeg"), {"request": "req-1", "token": "tok-1"})
        self.assertEqual((result["legs"], result["legTransactions"]), (1, [t["hash"]]))

    def test_no_request_for_the_claim_means_it_is_left_out(self):
        s, t = self.setup_dep(requests=())
        self.assert_left_out(s, t, "no deposit request")

    def test_a_request_for_another_id_or_recipient_does_not_match(self):
        for field, value in (("depositId", "ff" * 32), ("recipient", "55" * 20)):
            with self.subTest(field):
                s, t = self.setup_dep(requests=[("req-2", {**REQUEST[1], field: value})])
                self.assert_left_out(s, t, "no deposit request")

    def test_a_request_of_another_chain_operator_confirmer_or_gateway_does_not_match(self):
        for field, value in (("chainId", "1"), ("operator", "x"), ("confirmer", "x"), ("gateway", "x")):
            with self.subTest(field):
                s, t = self.setup_dep(requests=[("req-2", {**REQUEST[1], field: value})])
                self.assert_left_out(s, t, "no deposit request")

    def test_a_token_that_is_not_registered_means_the_claim_is_left_out(self):
        s, t = self.setup_dep(tokens=())
        self.assert_left_out(s, t, "not registered")

    def test_a_token_of_another_chain_or_gateway_does_not_count(self):
        for field, value in (("chainId", "1"), ("operator", "x"), ("confirmer", "x"), ("gateway", "x")):
            with self.subTest(field):
                s, t = self.setup_dep(tokens=[("tok-2", {**TOKEN[1], field: value})])
                self.assert_left_out(s, t, "not registered")

    def test_a_token_registered_for_another_evm_token_does_not_count(self):
        s, t = self.setup_dep(tokens=[TOKEN_C])
        self.assert_left_out(s, t, "not registered")

    def test_an_allocation_that_is_gone_or_hidden_means_the_claim_is_left_out(self):
        s, t = self.setup_dep(allocations=[])
        self.assert_left_out(s, t, "allocation", "not active")
        s, t = self.setup_dep()
        s.ledger.views["alloc-d1"] = None
        self.assert_left_out(s, t, "view")

    def test_a_passed_settle_before_an_executor_a_sender_or_a_receiver_that_do_not_fit(self):
        for over, word in (({"settleBefore": "2020-01-01T00:00:00Z"}, "settle-before"), ({"executor": "someone-else"}, "executor"),
                           ({"sender": "x::1"}, "sender"), ({"receiver": "x::1"}, "gateway")):
            with self.subTest(word):
                s, t = self.setup_dep()
                s.ledger.views["alloc-d1"] = over
                self.assert_left_out(s, t, word)

    def test_an_allocation_of_another_instrument_means_the_claim_is_left_out(self):
        for instrument in ({"admin": "adm", "id": "TKX"}, {"admin": "other", "id": "TKB"}):
            with self.subTest(instrument["id"] + instrument["admin"]):
                s, t = self.setup_dep()
                s.ledger.views["alloc-d1"] = {"instrument": instrument}
                self.assert_left_out(s, t, "instrument")

    def test_an_allocation_of_another_amount_means_the_claim_is_left_out(self):
        for amount in ("9.0", "10.0000000001", "100.0"):
            with self.subTest(amount):
                s, t = self.setup_dep()
                s.ledger.views["alloc-d1"] = {"amount": amount}
                self.assert_left_out(s, t, "amount")

    def test_an_amount_is_compared_as_a_number(self):
        s, t = self.setup_dep()
        s.ledger.views["alloc-d1"] = {"amount": "10.0000000000"}
        self.build(s)
        self.assertEqual(len(s.advance_argument()["legs"]), 1)

    def test_of_two_requests_for_one_id_the_one_that_can_settle_is_used(self):
        dead = ("req-0", {**REQUEST[1], "depositor": "e::1", "allocation": "alloc-dead"})
        s, t = self.setup_dep(requests=[dead, REQUEST], allocations=["alloc-d1"])
        self.build(s)
        self.assertEqual(self.attached(s, "DepositLeg"), {"request": "req-1", "token": "tok-1"})

    def test_one_allocation_is_used_by_one_leg_of_a_block(self):
        second = ("req-2", {**REQUEST[1], "depositId": "ff" * 32})   # the same allocation, claimed under another id
        s, t1 = self.setup_dep(requests=[REQUEST, second])
        t2 = self.leg_tx(s, Leg(DEPOSIT, "ff" * 32, WTKB, PAYEE, 10 * UNIT), BOB, price=1)
        s.reth.pool[BOB] = [t2]
        result = self.build(s)
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [t2["hash"]])
        self.assertIn("same allocation", result["leftOut"][0]["reason"])
        self.assertEqual(self.attached(s, "DepositLeg"), {"request": "req-1", "token": "tok-1"})


class Withdrawals(LegCase):
    def setup_wd(self, acceptances=(ACCEPTANCE,), tokens=(TOKEN,), holdings=(holding("h-1", "6.0"),), **k):
        s = self.setup({ALICE: []}, **k)
        s.ledger.acceptances, s.ledger.tokens, s.ledger.holdings = list(acceptances), list(tokens), list(holdings)
        t = self.leg_tx(s, WD)
        s.reth.pool[ALICE] = [t]
        return s, t

    def test_a_withdrawal_with_a_token_an_acceptance_and_holdings_is_attached(self):
        s, t = self.setup_wd()
        result = self.build(s)
        self.assertEqual(self.attached(s, "WithdrawalLeg"), {
            "id": WD_ID, "token": "tok-1", "from": PAYEE, "amount": "4.0", "acceptance": "acc-1", "inputs": ["h-1"]})
        self.assertEqual((result["legs"], result["legTransactions"]), (1, [t["hash"]]))

    def test_the_amount_is_the_wrapped_amount_in_canton_units(self):
        for base, text in ((1, "0.0000000001"), (123456789012, "12.3456789012"), (5 * UNIT, "5.0")):
            with self.subTest(base):
                s, t = self.setup_wd(holdings=[holding("h-1", "100.0")])
                s.reth.tx_legs[t["hash"]] = [Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, base, "r::1")]
                self.build(s)
                self.assertEqual(self.attached(s, "WithdrawalLeg")["amount"], text)

    def test_no_acceptance_means_the_withdrawal_is_left_out(self):
        s, t = self.setup_wd(acceptances=())
        self.assert_left_out(s, t, "acceptance")

    def test_an_acceptance_of_another_party_or_another_chain_does_not_count(self):
        for field, value in (("party", "x::9"), ("chainId", "1"), ("operator", "x"), ("confirmer", "x"), ("gateway", "x")):
            with self.subTest(field):
                s, t = self.setup_wd(acceptances=[("acc-2", {**ACCEPTANCE[1], field: value})])
                self.assert_left_out(s, t, "acceptance")

    def test_a_party_text_that_is_not_a_party_means_the_withdrawal_is_left_out(self):
        s, t = self.setup_wd()
        s.reth.tx_legs[t["hash"]] = [Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, 4 * UNIT, "not a party é")]
        self.assert_left_out(s, t, "acceptance")

    def test_a_token_that_is_not_registered_means_the_withdrawal_is_left_out(self):
        s, t = self.setup_wd(tokens=[TOKEN_C])
        self.assert_left_out(s, t, "not registered")

    def test_holdings_that_do_not_cover_the_amount_mean_the_withdrawal_is_left_out(self):
        s, t = self.setup_wd(holdings=[holding("h-1", "1.0"), holding("h-2", "2.5")])
        self.assert_left_out(s, t, "holdings", "cover")

    def test_locked_holdings_and_other_owners_and_other_instruments_are_not_counted(self):
        lock = {"holders": ["x"], "expiresAt": None, "expiresAfter": None, "context": None}
        s, t = self.setup_wd(holdings=[holding("h-1", "6.0", lock=lock), holding("h-2", "6.0", owner="someone"), holding("h-3", "6.0", instrument=TKC)])
        self.assert_left_out(s, t, "holdings")

    def test_the_largest_holdings_are_used_first_and_no_more_than_needed(self):
        holdings = [holding("h-1", "1.0"), holding("h-5", "5.0"), holding("h-2", "2.0")]
        for amount, inputs in ((4 * UNIT, ["h-5"]), (5 * UNIT, ["h-5"]), (7 * UNIT, ["h-5", "h-2"]), (7 * UNIT + UNIT // 2, ["h-5", "h-2", "h-1"]), (8 * UNIT, ["h-5", "h-2", "h-1"])):
            with self.subTest(amount):
                s, t = self.setup_wd(holdings=holdings)
                s.reth.tx_legs[t["hash"]] = [Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, amount, "r::1")]
                self.build(s)
                self.assertEqual(self.attached(s, "WithdrawalLeg")["inputs"], inputs)

    def test_holdings_are_summed_in_whole_base_units_and_one_that_cannot_be_read_is_not_counted(self):
        big, one = "1234567890123456789.0000000001", "1.0"
        holdings = [holding("h-1", one), holding("h-big", big), holding("h-bad", "1e30"), holding("h-neg", "-5.0")]
        s, t = self.setup_wd(holdings=holdings)
        s.reth.tx_legs[t["hash"]] = [Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, b.base_units("1234567890123456790.0000000001"), "r::1")]
        self.build(s)
        self.assertEqual(self.attached(s, "WithdrawalLeg")["inputs"], ["h-big", "h-1"])

    def test_holdings_are_asked_for_with_their_interface_view(self):
        s, t = self.setup_wd()
        self.build(s)
        asked = [q["eventFormat"]["filtersByParty"][BUILDER]["cumulative"][0]["identifierFilter"].get("InterfaceFilter") for q in s.ledger.queries]
        ids = {i["value"]["interfaceId"]: i["value"]["includeInterfaceView"] for i in asked if i}
        self.assertEqual(ids, {"#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding": True})

    def test_one_withdrawal_of_an_instrument_goes_into_a_block_and_the_next_waits(self):
        s, t1 = self.setup_wd(holdings=[holding("h-1", "50.0")])
        t2 = self.leg_tx(s, Leg(WITHDRAWAL, "cd" * 32, WTKB, PAYEE, UNIT, "r::1"), BOB, price=1)
        s.reth.pool[BOB] = [t2]
        result = self.build(s)
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [t2["hash"]])
        self.assertIn("same token", result["leftOut"][0]["reason"])
        self.assertEqual(self.attached(s, "WithdrawalLeg")["id"], WD_ID)

    def test_withdrawals_of_two_instruments_both_go_in(self):
        s, t1 = self.setup_wd(tokens=[TOKEN, TOKEN_C], holdings=[holding("h-1", "50.0"), holding("h-2", "50.0", instrument=TKC)])
        t2 = self.leg_tx(s, Leg(WITHDRAWAL, "cd" * 32, WTKC, PAYEE, UNIT, "r::1"), BOB, price=1)
        s.reth.pool[BOB] = [t2]
        result = self.build(s)
        self.assertEqual([l["value"]["inputs"] for l in s.advance_argument()["legs"]], [["h-1"], ["h-2"]])
        self.assertEqual(result["leftOut"], [])


class Rebuilding(LegCase):
    def test_legs_go_in_the_order_of_the_events_across_and_within_transactions(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS])
        s.ledger.requests, s.ledger.tokens, s.ledger.acceptances, s.ledger.holdings = [REQUEST], [TOKEN], [ACCEPTANCE], [holding("h-1", "6.0")]
        t1 = self.leg_tx(s, [WD, PAY], ALICE, price=9)   # two legs from one transaction
        t2 = self.leg_tx(s, DEP, BOB, price=5)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [t1], [t2]
        result = self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["WithdrawalLeg", "PaymentLeg", "DepositLeg"])
        self.assertEqual(result["legTransactions"], [t1["hash"], t2["hash"]])

    def test_a_transaction_with_a_leg_left_out_takes_its_senders_later_ones_with_it_and_not_others(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS, ("terms-2", {**TERMS[1], "dvpId": "fe" * 32, "allocation": "alloc-2"})])
        bad = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), ALICE, 0, price=9)   # no terms for this one
        later = self.leg_tx(s, PAY, ALICE, 1, price=9)   # would have terms, but waits behind it
        other = self.leg_tx(s, Leg(PAYMENT, "fe" * 32, TKA, PAYEE, 10), BOB, 0, price=1)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [bad, later], [other]
        result = self.build(s)
        self.assertEqual(s.builds(), [[raw_of(bad), raw_of(later), raw_of(other)], [raw_of(other)]])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [bad["hash"]])
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-2"})

    def test_a_rebuilt_block_keeps_the_honest_transactions_although_reth_has_dropped_them_from_its_pool(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS])
        honest = self.leg_tx(s, PAY, ALICE, price=9)
        bad = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), BOB, price=1)   # no terms
        s.reth.pool[ALICE], s.reth.pool[BOB] = [honest], [bad]
        s.reth.refuse_resend = True   # the rebuilt block must not depend on the pool taking them back
        result = self.build(s)
        self.assertEqual(s.builds(), [[raw_of(honest), raw_of(bad)], [raw_of(honest)]])
        self.assertEqual((result["legs"], result["transactions"]), (1, [honest["hash"]]))
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-1"})

    def test_a_transaction_that_is_left_out_does_not_take_an_allocation_from_another(self):
        twin = ("terms-2", {**TERMS[1], "dvpId": "fe" * 32})
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS, twin])
        doomed = self.leg_tx(s, [PAY, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10)], ALICE, price=9)
        other = self.leg_tx(s, Leg(PAYMENT, "fe" * 32, TKA, PAYEE, 10), BOB, price=1)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [doomed], [other]
        result = self.build(s)
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [doomed["hash"]])
        self.assertEqual(self.attached(s, "PaymentLeg"), {"terms": "terms-2"})

    def test_a_transaction_that_is_left_out_waits_in_the_pool_and_the_ones_in_the_block_do_not(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS])
        honest = self.leg_tx(s, PAY, ALICE, price=9)
        bad = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), BOB, 0, price=1)
        later = tx(BOB, 1, price=1)   # waits behind it
        s.reth.pool[ALICE], s.reth.pool[BOB] = [honest], [bad, later]
        self.build(s)
        self.assertEqual(self.in_pool(s), {bad["hash"], later["hash"]})

    def test_two_refused_runs_in_a_row_leave_the_transaction_in_the_pool_once(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, refuse="no")
        b.build_block(s.cfg)
        b.build_block(s.cfg)
        self.assertEqual(self.in_pool(s), {t["hash"]})
        self.assertEqual(len(s.reth.pool[ALICE]), 1)

    def test_the_transactions_of_a_refused_block_are_in_the_pool_again(self):
        a, c = tx(ALICE, 0), tx(BOB, 0)
        s = self.setup({ALICE: [a], BOB: [c]}, refuse="the block is over the gas cap")
        result = b.build_block(s.cfg)
        self.assertFalse(result["committed"])
        self.assertEqual(self.in_pool(s), {a["hash"], c["hash"]})
        s.ledger.refuse = None
        self.assertEqual(self.build(s)["transactions"], [a["hash"], c["hash"]])

    def test_the_transactions_are_in_the_pool_again_when_the_run_fails(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.reth.tx_legs[t["hash"]] = [PAY]
        s.reth.bad_log_data = b"\x01" * 10
        with self.assertRaises(b.BuilderError):
            b.build_block(s.cfg)
        self.assertEqual(self.in_pool(s), {t["hash"]})

    def test_a_committed_block_is_not_sent_to_the_pool_again_when_the_last_forkchoice_fails(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.reth.sync_on_final = True
        with self.assertRaises(b.BuilderError):
            b.build_block(s.cfg)
        self.assertEqual(self.in_pool(s), set())

    def test_a_committed_block_leaves_its_transactions_out_of_the_pool(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        self.build(s)
        self.assertEqual(self.in_pool(s), set())

    def test_every_leg_without_a_canton_side_is_found_in_one_pass(self):
        s = self.setup({ALICE: [], BOB: []})
        a, c = self.leg_tx(s, PAY, ALICE), self.leg_tx(s, PAY, BOB)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [a], [c]
        result = self.build(s)
        self.assertEqual(len(s.builds()), 2)
        self.assertEqual(sorted(x["transaction"] for x in result["leftOut"]), sorted([a["hash"], c["hash"]]))

    def test_a_leg_that_shows_up_only_without_another_transaction_is_found_by_building_again(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS])
        first = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), ALICE, price=9)   # no terms: left out in the first pass
        second = tx(BOB, 0, price=1)
        # the second transaction pays against real terms while the first is in the block, and against nothing once it is gone
        s.reth.tx_legs[second["hash"]] = lambda in_block: [PAY] if first["hash"] in in_block else [Leg(PAYMENT, "fe" * 32, TKA, PAYEE, 10)]
        s.reth.pool[ALICE], s.reth.pool[BOB] = [first], [second]
        result = self.build(s)
        self.assertEqual(s.builds(), [[raw_of(first), raw_of(second)], [raw_of(second)], []])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [first["hash"], second["hash"]])
        self.assertEqual(s.advance_argument()["legs"], [])

    def test_a_transaction_with_two_legs_that_have_no_side_is_left_out_once(self):
        s = self.setup({ALICE: []})
        t = self.leg_tx(s, [PAY, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10)])
        s.reth.pool[ALICE] = [t]
        result = self.build(s)
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [t["hash"]])

    def test_a_transaction_named_with_exclude_is_not_reported_as_left_out(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        self.assertEqual(self.build(s, exclude={t["hash"]})["leftOut"], [])

    def test_a_refused_advance_lists_the_transactions_that_recorded_legs_and_the_next_run_looks_again(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, terms=[TERMS], refuse="the allocation was withdrawn")
        s.reth.tx_legs[t["hash"]] = [PAY]
        result = b.build_block(s.cfg)
        self.assertFalse(result["committed"])
        self.assertEqual((result["legTransactions"], result["keptTransactions"]), ([t["hash"]], [t["hash"]]))
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)
        s.ledger.refuse, s.ledger.allocations = None, []   # the allocation really is gone now
        again = self.build(s)
        self.assertEqual([x["transaction"] for x in again["leftOut"]], [t["hash"]])

    def test_an_unknown_outcome_lists_the_legs_too(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, terms=[TERMS], drop_but_commit=True)
        s.ledger.head_fails_after_submit = True
        s.reth.tx_legs[t["hash"]] = [PAY]
        result = b.build_block(s.cfg)
        self.assertIsNone(result["committed"])
        self.assertEqual((result["legTransactions"], result["leftOut"]), ([t["hash"]], []))

    def test_a_log_that_cannot_be_read_stops_the_run_and_moves_reth_back(self):
        for bad in (b"\x01" * 10, bytes(32 * 7), bytes(32 * 5)):
            with self.subTest(len(bad)):
                t = tx(ALICE, 0)
                s = self.setup({ALICE: [t]})
                s.reth.tx_legs[t["hash"]] = [PAY]
                s.reth.bad_log_data = bad
                with self.assertRaises(b.BuilderError):
                    b.build_block(s.cfg)
                self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)
                self.assertEqual(s.ledger.submitted, [])


class ChainRecord(Case):
    def test_a_gateway_address_that_is_not_forty_lowercase_hex_digits_stops_the_run_before_anything_is_built(self):
        for bad in ("0x" + GATEWAY, GATEWAY.upper(), GATEWAY[:-2], GATEWAY + "00", ""):
            with self.subTest(bad):
                s = self.setup({ALICE: [tx(ALICE, 0)]})
                good = s.ledger.chain_args
                s.ledger.chain_args = lambda good=good, bad=bad: {**good(), "gatewayAddress": bad}
                with self.assertRaises(b.BuilderError):
                    b.build_block(s.cfg)
                self.assertEqual(s.builds(), [])


class Visibility(Case):
    """--read-as and --disclosed: the operator-hosted builder sees what the operator sees, and passes the contracts
    the token registry discloses. Without them nothing changes."""

    def test_by_default_only_the_builder_reads_and_nothing_is_disclosed(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, terms=[TERMS])
        s.reth.tx_legs[t["hash"]] = [PAY]
        b.build_block(s.cfg)
        for q in s.ledger.queries:
            self.assertEqual(list(q["eventFormat"]["filtersByParty"]), [BUILDER])
        (sub,) = s.ledger.submitted
        self.assertEqual(sub["readAs"], [BUILDER])
        self.assertNotIn("disclosedContracts", sub)

    def test_read_as_parties_are_added_to_every_read_and_to_advance(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]}, terms=[TERMS])
        s.reth.tx_legs[t["hash"]] = [PAY]
        s.cfg.read_as = ("operator::1220cc", "other::1220dd")
        self.assertTrue(b.build_block(s.cfg)["committed"])
        self.assertEqual(len(s.ledger.queries), 3)   # the chain, the terms, the allocations
        for q in s.ledger.queries:
            self.assertEqual(list(q["eventFormat"]["filtersByParty"]), [BUILDER, "operator::1220cc", "other::1220dd"])
        (sub,) = s.ledger.submitted
        self.assertEqual(sub["actAs"], [BUILDER])   # only the builder acts
        self.assertEqual(sub["readAs"], [BUILDER, "operator::1220cc", "other::1220dd"])

    def test_disclosed_contracts_are_passed_with_advance(self):
        disclosed = [{"templateId": "pkg:Some.Token:Registry", "contractId": "reg-1", "createdEventBlob": "abcd", "synchronizerId": "sync::1"}]
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.cfg.disclosed = disclosed
        self.assertTrue(b.build_block(s.cfg)["committed"])
        self.assertEqual(s.ledger.submitted[0]["disclosedContracts"], disclosed)


class Refusal(Case):
    def test_refusal_moves_reth_back_to_the_parent_and_says_why(self):
        t1 = tx(ALICE, 0)
        s = self.setup({ALICE: [t1]}, refuse="the block is over the gas cap")
        result = b.build_block(s.cfg)
        self.assertFalse(result["committed"])
        self.assertIn("the block is over the gas cap", result["reason"])
        self.assertEqual(result["keptTransactions"], [t1["hash"]])
        safe = {"headBlockHash": HEAD_HASH, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH}
        self.assertEqual(s.forkchoices()[-1], safe)
        n_hash = [p for m, p in s.reth.engine_calls if m == "engine_newPayloadV4"][0][0]["blockHash"]
        self.assertNotIn(n_hash, [f["finalizedBlockHash"] for f in s.forkchoices()])

    def test_a_failing_prover_also_moves_reth_back(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        with self.assertRaises(b.BuilderError):
            b.build_block(s.cfg)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)
        self.assertEqual(s.ledger.submitted, [])

    def test_a_proof_left_by_an_earlier_run_is_never_used(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_writes_nothing=True)
        stale = Path(s.cfg.work_dir) / f"block-{HEAD_NUMBER + 1}" / "out" / "wrapped-proof.hex"
        stale.parent.mkdir(parents=True)
        stale.write_text("cd" * 1344)
        with self.assertRaises(b.BuilderError):
            b.build_block(s.cfg)
        self.assertEqual(s.ledger.submitted, [])
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)

    def test_a_proof_from_an_earlier_run_is_replaced_by_this_runs(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        stale = Path(s.cfg.work_dir) / f"block-{HEAD_NUMBER + 1}" / "out" / "wrapped-proof.hex"
        stale.parent.mkdir(parents=True)
        stale.write_text("cd" * 1344)
        self.assertTrue(b.build_block(s.cfg)["committed"])
        self.assertEqual(s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["proofHex"], "ab" * 1344)

    def test_excluded_transaction_and_its_followers_are_left_out(self):
        t0, t1, other = tx(ALICE, 0), tx(ALICE, 1), tx(BOB, 0)
        s = self.setup({ALICE: [t0, t1], BOB: [other]})
        b.build_block(s.cfg, exclude={t0["hash"]})
        raws = [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"][0][2]
        self.assertEqual(raws, [raw_of(other)])


class Jwt(Case):
    def test_token_is_hs256_over_the_secret_with_a_current_iat(self):
        h, c, sig = b.jwt_token(JWT_SECRET, now=1_700_000_000).split(".")
        enc = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
        self.assertEqual(json.loads(base64.urlsafe_b64decode(h + "==")), {"alg": "HS256", "typ": "JWT"})
        self.assertEqual(json.loads(base64.urlsafe_b64decode(c + "==")), {"iat": 1_700_000_000})
        self.assertEqual(sig, enc(hmac.new(JWT_SECRET, f"{h}.{c}".encode(), hashlib.sha256).digest()))

    def test_every_engine_call_carries_a_valid_token(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        b.build_block(s.cfg)
        self.assertEqual(s.reth.jwt_failures, 0)
        self.assertEqual(len(s.reth.engine_calls), 4)

    def test_a_wrong_secret_gets_nowhere(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, secret=bytes.fromhex("22" * 32))
        with self.assertRaises(b.BuilderError):
            b.build_block(s.cfg)
        self.assertGreater(s.reth.jwt_failures, 0)
        self.assertEqual([m for m, _ in s.reth.ws_calls if m == "testing_buildBlockV1"], [])
        self.assertEqual(s.ledger.submitted, [])


class Transactions(Case):
    def test_an_empty_pool_gives_an_empty_list_never_null(self):
        s = self.setup({})
        b.build_block(s.cfg)
        raws = [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"][0][2]
        self.assertEqual(raws, [])
        self.assertIsNotNone(raws)

    def test_gas_cap_is_respected(self):
        pool = {ALICE: [tx(ALICE, n, gas=21000, price=9) for n in range(5)], BOB: [tx(BOB, 0, gas=30000, price=1)]}
        first_three = [raw_of(t) for t in pool[ALICE][:3]]   # the fake pool loses the block's transactions once it is head
        s = self.setup(pool, gas_cap=70_000)
        b.build_block(s.cfg)
        raws = [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"][0][2]
        self.assertEqual(raws, first_three)   # 63,000; the 4th would make 84,000
        self.assertLessEqual(21000 * len(raws), 70_000)

    def test_a_transaction_that_does_not_fit_stops_its_sender_not_the_others(self):
        big, after, small = tx(ALICE, 0, gas=60000, price=9), tx(ALICE, 1, price=9), tx(BOB, 0, price=1)
        picked = b.choose_txs({ALICE: {"0": big, "1": after}, BOB: {"0": small}}, budget=50_000, exclude=set())
        self.assertEqual(picked, [small])

    def test_nonces_stay_in_order_per_sender(self):
        ts = [tx(ALICE, n, price=10 - n) for n in range(3)]
        picked = b.choose_txs({ALICE: {str(n): t for n, t in enumerate(ts)}}, budget=10**9, exclude=set())
        self.assertEqual(picked, ts)

    def test_budget_is_the_lower_of_the_cap_and_the_parents_gas_limit(self):
        s = self.setup({ALICE: [tx(ALICE, n) for n in range(3)]})
        s.reth.blocks[HEAD_HASH]["gasLimit"] = 45_000   # parent limit below the chain's cap
        b.build_block(s.cfg)
        self.assertEqual(len([p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"][0][2]), 2)


class CommandLine(Case):
    def run_main(self, s, *extra, drop=(), jwt=JWT_SECRET.hex()):
        state = Path(s.dir) / "state"
        state.mkdir(exist_ok=True)
        if jwt is not None:
            (state / "jwt.hex").write_text(jwt)
        env = {"CZE_STATE_DIR": str(state), "RETH_WS_PORT": s.reth.ws_url.rsplit(":", 1)[1], "RETH_ENGINE_PORT": s.reth.engine_url.rsplit(":", 1)[1],
               "CZE_LEDGER_URL": s.ledger.url, "CZE_LEDGER_USER": "builder-user", "CZE_LEDGER_TOKEN": LEDGER_TOKEN, "CZE_BUILDER_PARTY": BUILDER,
               "CZE_FEE_RECIPIENT": "0x" + "fe" * 20, "CZE_GENESIS": s.cfg.genesis, "CZE_MAKE_INPUT_CMD": s.cfg.make_input_cmd,
               "CZE_PROVE_CMD": s.cfg.prove_cmd}
        out = io.StringIO()
        with mock.patch.dict(os.environ, env), mock.patch.object(sys, "argv", ["builder.py", "once", *extra]), contextlib.redirect_stdout(out):
            for name in drop:
                os.environ.pop(name, None)
            code = b.main()
        self.assertEqual(len(out.getvalue().splitlines()), 1, out.getvalue())   # one line, and it is JSON
        return code, json.loads(out.getvalue())

    def test_exit_status_says_committed_or_refused(self):
        code, out = self.run_main(self.setup({ALICE: [tx(ALICE, 0)]}))
        self.assertEqual((code, out["committed"]), (0, True))
        code, out = self.run_main(self.setup({ALICE: [tx(ALICE, 0)]}, refuse="no"))
        self.assertEqual((code, out["committed"], "no" in out["reason"]), (2, False, True))

    def test_unknown_outcome_exits_2_with_committed_null(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.head_fails_after_submit = True
        code, out = self.run_main(s)
        self.assertEqual(code, 2)
        self.assertIn("committed", out)
        self.assertIsNone(out["committed"])
        self.assertIn("reason", out)

    def test_exit_status_says_failed_when_reth_is_unreachable(self):
        s = self.setup({})
        s.reth.close()
        code, out = self.run_main(s)
        self.assertEqual(code, 1)
        self.assertIn("error", out)

    def assert_failure(self, code_and_out, *words):
        code, out = code_and_out
        self.assertEqual(code, 1)
        self.assertIs(out["committed"], False)
        for w in words:
            self.assertIn(w, out["error"])

    def test_read_as_and_disclosed_come_from_the_command_line(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        file = Path(s.dir) / "disclosed.json"
        disclosed = [{"templateId": "pkg:Some.Token:Registry", "contractId": "reg-1", "createdEventBlob": "abcd", "synchronizerId": "sync::1"}]
        file.write_text(json.dumps(disclosed))
        code, out = self.run_main(s, "--read-as", "op::1", "--read-as", "op2::2", "--read-as", "op::1", "--disclosed", str(file))
        self.assertEqual((code, out["committed"]), (0, True))
        (sub,) = s.ledger.submitted
        self.assertEqual(sub["readAs"], [BUILDER, "op::1", "op2::2"])   # the builder first, no party twice
        self.assertEqual(sub["disclosedContracts"], disclosed)

    def test_a_bad_disclosed_file_is_one_json_line_before_anything_moves(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        for content in (None, "not json", '{"contractId": "x"}', '["x"]'):
            file = Path(s.dir) / "d.json"
            file.unlink(missing_ok=True)
            if content is not None:
                file.write_text(content)
            self.assert_failure(self.run_main(s, "--disclosed", str(file)), "disclosed")
        self.assertEqual(s.reth.engine_calls, [])
        self.assertEqual(s.ledger.submitted, [])

    def test_a_missing_setting_is_one_json_line(self):
        for name in ("CZE_LEDGER_USER", "CZE_BUILDER_PARTY", "CZE_FEE_RECIPIENT"):
            self.assert_failure(self.run_main(self.setup({}), drop=[name]), name)

    def test_a_missing_or_bad_jwt_secret_is_one_json_line(self):
        self.assert_failure(self.run_main(self.setup({}), jwt=None), "jwt.hex")
        self.assert_failure(self.run_main(self.setup({}), jwt="not hex"), "jwt.hex")

    def test_bad_arguments_are_one_json_line(self):
        self.assert_failure(self.run_main(self.setup({}), "--bogus"))

    def test_no_zkchain_contract_is_one_json_line(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, chains=0)
        self.assert_failure(self.run_main(s), "ZkChain")
        self.assertEqual([m for m, _ in s.reth.ws_calls if m == "testing_buildBlockV1"], [])

    def test_two_zkchain_contracts_are_one_json_line(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, chains=2)
        self.assert_failure(self.run_main(s), "ZkChain", "2")
        self.assertEqual([m for m, _ in s.reth.ws_calls if m == "testing_buildBlockV1"], [])

    def test_only_chains_built_by_this_builder_count(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.ledger.other_chains = [{"builder": "someone-else::9", "chainId": "5"}]   # seen through --read-as, built by another party
        s.cfg.read_as = ("operator::1220cc",)
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["contractId"], "chain-cid")

    def test_two_chains_built_by_this_builder_are_one_json_line_that_says_so(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, chains=2)
        s.ledger.other_chains = [{"builder": "someone-else::9"}]
        out = self.run_main(s)
        self.assert_failure(out, "ZkChain", "built by", "found 2")

    def test_a_reply_that_is_not_json_is_one_json_line(self):
        self.assert_failure(self.run_main(self.setup({}, bad_json=True)))

    def test_a_failing_prover_is_one_json_line(self):
        self.assert_failure(self.run_main(self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)), "prove")


class Pieces(unittest.TestCase):
    def test_keccak256_known_answers(self):
        self.assertEqual(keccak256(b"").hex(), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        self.assertEqual(keccak256(b"abc").hex(), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45")
        real = json.loads((HERE.parent.parent / "sidecar/tests/fixtures/block.json").read_text())   # a real header, 605 bytes
        self.assertEqual(keccak256(bytes.fromhex(real["header"])).hex(), real["hash"])

    def test_blocks_are_split_into_header_and_transaction_list(self):
        header, t = rlp([b"x" * 40, b"y"]), [b"\x02" + b"z" * 60]
        raw = rlp([Raw(header), t, [], []])
        self.assertEqual(b.split_block(raw), (header, rlp(t)))

    def test_the_leg_event_is_the_one_the_contract_declares(self):
        source = (HERE.parent.parent / "gateway" / "Gateway.sol").read_text()
        (params,) = re.findall(r"event Leg\(([^)]*)\);", source)
        signature = "Leg(" + ",".join(p.split()[0] for p in params.split(",")) + ")"
        self.assertEqual(signature, "Leg(uint8,bytes32,address,address,uint256,string)")
        self.assertEqual(b.LEG_TOPIC, "0x" + keccak256(signature.encode()).hex())

    def test_a_leg_event_is_read_back_as_it_was_written(self):
        for leg in (PAY, DEP, WD, Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, 1, "x" * 100 + "\u00e9")):
            log = {"address": "0x" + GATEWAY, "topics": [LEG_TOPIC], "data": "0x" + leg.data().hex(), "transactionHash": "0x" + "99" * 32}
            got = b.decode_leg(log)
            self.assertEqual((got.kind, got.id, got.token, got.account, got.amount, got.party, got.tx),
                             (leg.kind, leg.id, leg.token, leg.account, leg.amount, leg.party, "0x" + "99" * 32))

    def test_a_leg_event_that_is_not_well_formed_is_refused(self):
        good = PAY.data()
        for bad in (good[:-1], good + b"\x00", bytes(32) + good[32:], good[:160] + (7).to_bytes(32, "big") + good[192:],
                    (9).to_bytes(32, "big") + good[32:], good[:96] + b"\x01" + good[97:], WD.data()[:-1] + b"\x01"):
            with self.subTest(len(bad)), self.assertRaises(b.BuilderError):
                b.decode_leg({"data": "0x" + bad.hex(), "transactionHash": "0x" + "99" * 32})

    def test_wrapped_amounts_and_canton_amounts_convert_exactly(self):
        for base, text in ((0, "0.0"), (1, "0.0000000001"), (UNIT, "1.0"), (123456789012, "12.3456789012"), (10**30, "100000000000000000000.0")):
            self.assertEqual(b.canton_amount(base), text)
            self.assertEqual(b.base_units(text), base)
        self.assertEqual(b.base_units("10.0000000000"), 10 * UNIT)
        self.assertEqual(b.base_units("7"), 7 * UNIT)
        for bad in ("0.00000000001", "1.00000000005", "abc", "", "-1.0", None):
            self.assertIsNone(b.base_units(bad), bad)


if __name__ == "__main__":
    unittest.main()
