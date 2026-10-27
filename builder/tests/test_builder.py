"""The builder, against fakes only: a fake reth (builder-only WebSocket port and Engine port), a fake Canton JSON
Ledger API and a fake prover. No real Canton, GPU or reth. Run: python3 -m unittest discover -s builder/tests"""
import base64, contextlib, stat, time, urllib.error, hashlib, hmac, io, json, os, re, shutil, sys, tempfile, unittest
from datetime import datetime, timezone
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
from keccak import keccak256
from fakes import (BUILDER, DEPOSIT, GATEWAY, HEAD_HASH, HEAD_NUMBER, JWT_SECRET, LEDGER_TOKEN, LEG_TOPIC, PAYMENT, WITHDRAWAL,
                   FakeLedger, FakeReth, Leg, Raw, hash_of, raw_of, rlp, tx)

ALICE, BOB, CAROL = "0x" + "a1" * 20, "0x" + "b2" * 20, "0x" + "c4" * 20   # senders of EVM transactions
PAY_ID, DEP_ID, WD_ID = "ee" * 32, "dd" * 32, "ab" * 32
TKA, WTKB, WTKC = "11" * 20, "22" * 20, "33" * 20   # an ERC-20 that payments are made in, and two wrapped tokens
PAYEE = "c3" * 20
OTHER = "d5" * 20   # another recipient on Canton's chain
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

TRADE_ID, CLAIM_ID = "ff" * 32, "cc" * 32
DISCLOSED_ALLOCATION = {"templateId": "pkg:Some.Token:Allocation", "contractId": "alloc-t1", "createdEventBlob": "beef", "synchronizerId": "sync::1"}
TRADE = ("trade-1", {**named, "venue": "venue::1", "sender": "s::1", "gateway": "gw", "label": "t1", "payId": TRADE_ID, "token": TKA, "payee": PAYEE,
                     "amount": "00" * 31 + "0a", "allocation": "alloc-t1", "allocationDisclosed": json.dumps(DISCLOSED_ALLOCATION),
                     "gatewayToken": "tok-1", "claimId": CLAIM_ID, "recipient": PAYEE})
CLAIM = ("claim-1", {**named, "gateway": "gw", "claimId": CLAIM_ID, "recipient": PAYEE, "gatewayToken": "tok-1", "amount": "10.0"})

PAY = Leg(PAYMENT, PAY_ID, TKA, PAYEE, 10)
TRADE_PAY = Leg(PAYMENT, TRADE_ID, TKA, PAYEE, 10)
CLAIM_DEP = Leg(DEPOSIT, CLAIM_ID, WTKB, PAYEE, 10 * UNIT)
DEP = Leg(DEPOSIT, DEP_ID, WTKB, PAYEE, 10 * UNIT)
WD = Leg(WITHDRAWAL, WD_ID, WTKB, PAYEE, 4 * UNIT, "r::1")


class Setup:
    def __init__(self, pool, gas_cap=30_000_000, terms=(), refuse=None, fail_but_commit=False, drop_but_commit=False, allocations=None, chains=1, bad_json=False, prover_fails=False, prover_writes_nothing=False, secret=JWT_SECRET, skip_invalid=True, max_request=15_000_000):
        self.dir = tempfile.mkdtemp()
        self.reth = FakeReth(pool, gas_limit=gas_cap, skip_invalid=skip_invalid, max_request=max_request)
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
        self.assertEqual(arg["proofHex"][:1664], "ab" * 832)
        self.assertEqual(b.committed_hash(arg["proofHex"]), n_hash)   # the proof's public values carry this block's hash
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

    def test_a_lost_reply_with_no_completion_yet_is_unknown_and_reth_stays_where_it_is(self):
        for commit in (True, False):   # whether or not Canton commits, the builder cannot tell yet
            s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
            s.ledger.commit, s.ledger.no_completion = commit, True
            result = b.build_block(s.cfg)
            self.assertIsNone(result["committed"], result)
            self.assertEqual(result["number"], HEAD_NUMBER + 1)
            self.assertIn("no usable reply from Canton", result["reason"])
            self.assertIn("no completion yet", result["reason"])
            self.assertEqual(result["resolve"]["begin"], 42)   # the ledger end read before the submit
            self.assertEqual(len(s.ledger.submitted), 1)
            # reth is not moved: the last forkchoice is the one that made the new block its head
            n_hash = result["blockHash"]
            self.assertEqual(s.forkchoices()[-1], {"headBlockHash": n_hash, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH})

    def test_the_next_run_after_an_unknown_outcome_starts_from_canton_head(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.no_completion = True
        first = b.build_block(s.cfg)
        self.assertIsNone(first["committed"])
        s.ledger.no_completion, s.ledger.drop_but_commit = False, False   # Canton is reachable again; it had committed
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


class VenueLegs(LegCase):
    """A payment settles a venue's trade and a deposit redeems the claim that trade made, besides the terms and the requests of before."""

    def setup_leg(self, leg, trades=(), claims=(), terms=(), requests=(), tokens=(TOKEN,), **k):
        s = self.setup({ALICE: []}, terms=list(terms), **k)
        s.ledger.trades, s.ledger.claims, s.ledger.requests, s.ledger.tokens = list(trades), list(claims), list(requests), list(tokens)
        t = self.leg_tx(s, leg)
        s.reth.pool[ALICE] = [t]
        return s, t

    def sent_disclosed(self, s):
        return s.ledger.submitted[0].get("disclosedContracts")

    def test_a_payment_with_a_venue_trade_is_attached_as_a_trade_leg(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE])
        result = self.build(s)
        self.assertEqual(self.attached(s, "TradeLeg"), {"tradeCid": "trade-1"})
        self.assertEqual((result["legs"], result["leftOut"], len(s.builds())), (1, [], 1))

    def test_a_deposit_with_a_funded_claim_is_attached_as_a_claim_leg_with_the_claims_token(self):
        s, t = self.setup_leg(CLAIM_DEP, claims=[CLAIM])
        result = self.build(s)
        self.assertEqual(self.attached(s, "ClaimLeg"), {"claimCid": "claim-1", "tokenCid": "tok-1"})
        self.assertEqual((result["legs"], result["leftOut"], len(s.builds())), (1, [], 1))

    def test_the_trades_disclosed_allocation_goes_with_the_static_list(self):
        static = {"templateId": "pkg:Some.Token:Registry", "contractId": "reg-1", "createdEventBlob": "abcd", "synchronizerId": "sync::1"}
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE], allocations=[])
        s.cfg.venues = ("venue::1",)
        s.cfg.disclosed = [static]
        self.build(s)
        self.assertEqual(self.sent_disclosed(s), [static, DISCLOSED_ALLOCATION])

    def test_a_disclosed_allocation_already_in_the_static_list_is_not_sent_twice(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE], allocations=[])
        s.cfg.venues = ("venue::1",)
        s.cfg.disclosed = [DISCLOSED_ALLOCATION]
        self.build(s)
        self.assertEqual(self.sent_disclosed(s), [DISCLOSED_ALLOCATION])

    def test_a_trade_without_a_disclosed_allocation_adds_nothing(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[("trade-1", {**TRADE[1], "allocationDisclosed": None})])
        self.build(s)
        self.assertEqual(self.attached(s, "TradeLeg"), {"tradeCid": "trade-1"})
        self.assertNotIn("disclosedContracts", s.ledger.submitted[0])

    def test_a_disclosed_allocation_that_is_not_a_json_object_leaves_the_payment_out(self):
        for bad in ("not json", "[1]"):
            s, t = self.setup_leg(TRADE_PAY, trades=[("trade-1", {**TRADE[1], "allocationDisclosed": bad})])
            self.assert_left_out(s, t, "disclosed")

    def test_a_participant_without_040_leaves_an_unmatched_payment_and_deposit_out_with_their_old_reasons(self):
        s, t = self.setup_leg(PAY)
        s.ledger.no_040 = True
        self.assert_left_out(s, t, "no terms", "payment")
        s, t = self.setup_leg(DEP)
        s.ledger.no_040 = True
        self.assert_left_out(s, t, "no deposit request")

    def test_another_refusal_of_the_trade_query_is_raised(self):
        def refused(code, text):
            class Ledger:
                def active(self, template):
                    raise urllib.error.HTTPError("http://x", code, "refused", {}, io.BytesIO(text.encode()))
            return b.Canton(Ledger(), {}, datetime.now(timezone.utc))
        self.assertEqual(refused(404, '{"code":"NOT_FOUND","cause":"PACKAGE_NAMES_NOT_FOUND(11,0)"}').trades, [])
        for code, text in ((500, '{"cause":"the participant is down"}'), (404, '{"code":"NOT_FOUND","cause":"another thing"}')):
            with self.assertRaises(urllib.error.HTTPError):
                refused(code, text).claims

    def test_a_deposit_leg_adds_no_disclosure(self):
        s, t = self.setup_leg(CLAIM_DEP, claims=[CLAIM])
        self.build(s)
        self.assertNotIn("disclosedContracts", s.ledger.submitted[0])

    def test_an_id_that_no_trade_has_is_left_out_as_before(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[("trade-1", {**TRADE[1], "payId": "aa" * 32})])
        self.assert_left_out(s, t, "no terms", "payment")

    def test_an_id_that_no_claim_has_is_left_out_as_before(self):
        s, t = self.setup_leg(CLAIM_DEP, claims=[("claim-1", {**CLAIM[1], "claimId": "aa" * 32})])
        self.assert_left_out(s, t, "no deposit request")

    def test_a_trade_that_names_another_payee_token_or_amount_is_not_used(self):
        for change, word in (({"payee": "d4" * 20}, "payee"), ({"token": "44" * 20}, "token"), ({"amount": "00" * 31 + "0b"}, "amount")):
            s, t = self.setup_leg(TRADE_PAY, trades=[("trade-1", {**TRADE[1], **change})])
            self.assert_left_out(s, t, word)

    def test_a_trade_whose_allocation_is_not_the_venues_to_the_gateway_is_not_used(self):
        for view, word in (({"executor": "other::1"}, "executor"), ({"receiver": "x::1"}, "receiver"), ({"sender": "x::1"}, "sender")):
            s, t = self.setup_leg(TRADE_PAY, trades=[TRADE])
            s.ledger.views["alloc-t1"] = view
            self.assert_left_out(s, t, word)

    def test_a_trade_whose_allocation_is_gone_and_not_disclosed_is_not_used(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[("trade-1", {**TRADE[1], "allocationDisclosed": None})], allocations=[])
        self.assert_left_out(s, t, "allocation")

    def test_a_trade_whose_allocation_reaches_the_builder_only_by_disclosure_is_used_and_the_disclosure_goes_with_the_advance(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE], allocations=[])
        s.cfg.venues = ("venue::1",)
        result = self.build(s)
        self.assertEqual(self.attached(s, "TradeLeg"), {"tradeCid": "trade-1"})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertEqual(self.sent_disclosed(s), [DISCLOSED_ALLOCATION])

    def test_an_unseen_disclosed_allocation_of_a_venue_that_is_not_trusted_leaves_the_payment_out(self):
        for venues in ((), ("other-venue::1",)):
            s, t = self.setup_leg(TRADE_PAY, trades=[TRADE], allocations=[])
            s.cfg.venues = venues
            self.assert_left_out(s, t, "not visible", "--venue")

    def test_a_visible_allocation_of_a_venue_that_is_not_trusted_is_checked_and_used(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE])
        result = self.build(s)
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))
        self.assertIsNone(self.sent_disclosed(s))   # the builder sees it, so the trade's unchecked disclosure does not go with the Advance
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE])
        s.ledger.views["alloc-t1"] = {"settleBefore": "2020-01-01T00:00:00Z"}
        self.assert_left_out(s, t, "settle-before")

    def test_a_disclosed_contract_that_is_not_the_trades_allocation_leaves_the_payment_out(self):
        other = {**DISCLOSED_ALLOCATION, "contractId": "alloc-other"}
        for active in (None, []):   # whether or not the builder sees the allocation itself
            s, t = self.setup_leg(TRADE_PAY, trades=[("trade-1", {**TRADE[1], "allocationDisclosed": json.dumps(other)})], allocations=active)
            self.assert_left_out(s, t, "disclosed contract")

    def test_a_trade_whose_token_is_not_a_token_of_this_chain_is_not_used(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[("trade-1", {**TRADE[1], "gatewayToken": "tok-x"})])
        self.assert_left_out(s, t, "token of this chain")
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE], tokens=[("tok-1", {**TOKEN[1], "gateway": "other"})])
        self.assert_left_out(s, t, "token of this chain")

    def test_a_trade_whose_allocation_is_of_another_instrument_than_its_token_is_not_used(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE])
        s.ledger.views["alloc-t1"] = {"instrument": TKC}
        self.assert_left_out(s, t, "instrument")

    def test_a_payment_whose_terms_cannot_settle_still_finds_its_trade(self):
        dead = ("terms-x", {**TERMS[1], "dvpId": TRADE_ID, "token": TKA, "allocation": "alloc-gone"})
        s, t = self.setup_leg(TRADE_PAY, trades=[TRADE], terms=[dead], allocations=["alloc-t1"])
        self.build(s)
        self.assertEqual(self.attached(s, "TradeLeg"), {"tradeCid": "trade-1"})

    def test_a_deposit_request_that_cannot_settle_does_not_hold_back_the_claim(self):
        # any party can sign a request that names a claim's id and recipient, and point it at an allocation that does not exist
        grief = ("req-x", {**REQUEST[1], "depositId": CLAIM_ID, "allocation": "alloc-gone"})
        s, t = self.setup_leg(CLAIM_DEP, claims=[CLAIM], requests=[grief], allocations=[])
        result = self.build(s)
        self.assertEqual(self.attached(s, "ClaimLeg"), {"claimCid": "claim-1", "tokenCid": "tok-1"})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))

    def test_a_request_cannot_take_the_id_of_a_funded_claim(self):
        # the id of a claim is public: another party's valid request with the same id and its own recipient must not settle first
        steal = ("req-x", {**REQUEST[1], "depositId": CLAIM_ID, "recipient": OTHER})
        s, t = self.setup_leg(Leg(DEPOSIT, CLAIM_ID, WTKB, OTHER, 10 * UNIT), claims=[CLAIM], requests=[steal])
        self.assert_left_out(s, t, "this id belongs to a venue trade's funded claim")
        s, t = self.setup_leg(CLAIM_DEP, claims=[CLAIM], requests=[steal])
        result = self.build(s)
        self.assertEqual(self.attached(s, "ClaimLeg"), {"claimCid": "claim-1", "tokenCid": "tok-1"})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))

    def test_a_request_with_the_claims_recipient_does_not_settle_the_claims_id_either(self):
        both = ("req-x", {**REQUEST[1], "depositId": CLAIM_ID})
        s, t = self.setup_leg(CLAIM_DEP, claims=[CLAIM], requests=[both])
        self.build(s)
        self.assertEqual(self.attached(s, "ClaimLeg"), {"claimCid": "claim-1", "tokenCid": "tok-1"})

    def test_a_request_cannot_take_the_claim_id_of_a_venue_trade_with_no_claim_yet(self):
        steal = ("req-x", {**REQUEST[1], "depositId": CLAIM_ID, "recipient": OTHER})
        s, t = self.setup_leg(Leg(DEPOSIT, CLAIM_ID, WTKB, OTHER, 10 * UNIT), trades=[TRADE], requests=[steal])
        self.assert_left_out(s, t, "this id belongs to a venue trade's funded claim")

    def test_the_payment_and_a_stealing_deposit_in_one_block_keep_the_payment_and_leave_the_deposit_out(self):
        steal = ("req-x", {**REQUEST[1], "depositId": CLAIM_ID, "recipient": OTHER})
        s = self.setup({ALICE: [], BOB: []})
        s.ledger.trades, s.ledger.requests, s.ledger.tokens = [TRADE], [steal], [TOKEN]
        pay = self.leg_tx(s, TRADE_PAY, ALICE)
        grab = self.leg_tx(s, Leg(DEPOSIT, CLAIM_ID, WTKB, OTHER, 10 * UNIT), BOB)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [pay], [grab]
        result = self.build(s)
        self.assertEqual(self.attached(s, "TradeLeg"), {"tradeCid": "trade-1"})
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [grab["hash"]])
        self.assertIn("belongs to a venue trade", result["leftOut"][0]["reason"])

    def test_a_trade_of_another_chain_does_not_reserve_its_claim_id(self):
        req = ("req-x", {**REQUEST[1], "depositId": CLAIM_ID, "recipient": OTHER})
        s, t = self.setup_leg(Leg(DEPOSIT, CLAIM_ID, WTKB, OTHER, 10 * UNIT), trades=[("trade-1", {**TRADE[1], "gateway": "other"})], requests=[req])
        self.build(s)
        self.assertEqual(self.attached(s, "DepositLeg"), {"request": "req-x", "token": "tok-1"})

    def test_a_plain_deposit_is_unchanged_beside_a_trade_and_a_claim_with_other_ids(self):
        s, t = self.setup_leg(DEP, trades=[TRADE], claims=[CLAIM], requests=[REQUEST])
        result = self.build(s)
        self.assertEqual(self.attached(s, "DepositLeg"), {"request": "req-1", "token": "tok-1"})
        self.assertEqual((result["legs"], result["leftOut"]), (1, []))

    def test_a_request_that_cannot_settle_and_no_claim_keeps_the_requests_reason(self):
        grief = ("req-x", {**REQUEST[1], "depositId": CLAIM_ID, "allocation": "alloc-gone"})
        s, t = self.setup_leg(CLAIM_DEP, requests=[grief], allocations=[])
        self.assert_left_out(s, t, "allocation")

    def test_a_claim_whose_token_is_not_a_token_of_this_chain_is_not_used(self):
        s, t = self.setup_leg(CLAIM_DEP, claims=[CLAIM], tokens=[("tok-1", {**TOKEN[1], "gateway": "other"})])
        self.assert_left_out(s, t, "another token")

    def test_only_the_disclosures_of_the_legs_that_are_attached_go_with_the_advance(self):
        # two trades that name the same allocation: one settles, the other is left out, and the disclosure goes once
        other_id = "ee" * 32
        trade2 = ("trade-2", {**TRADE[1], "payId": other_id})
        s = self.setup({ALICE: [], BOB: []})
        s.cfg.venues = ("venue::1",)
        s.ledger.trades, s.ledger.tokens, s.ledger.allocations = [TRADE, trade2], [TOKEN], []
        a, c = self.leg_tx(s, TRADE_PAY), self.leg_tx(s, Leg(PAYMENT, other_id, TKA, PAYEE, 10), sender=BOB)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [a], [c]
        result = self.build(s)
        self.assertEqual((result["legs"], len(result["leftOut"])), (1, 1))
        self.assertEqual(self.sent_disclosed(s), [DISCLOSED_ALLOCATION])

    def test_a_claim_for_another_recipient_token_or_amount_is_not_used(self):
        for change, word in (({"recipient": "d4" * 20}, "belongs to a venue trade"), ({"amount": "11.0"}, "amount"), ({"gatewayToken": "tok-2"}, "token")):
            s, t = self.setup_leg(CLAIM_DEP, claims=[("claim-1", {**CLAIM[1], **change})], tokens=[TOKEN, TOKEN_C])
            self.assert_left_out(s, t, word)

    def test_a_claim_of_another_chain_is_not_used(self):
        s, t = self.setup_leg(CLAIM_DEP, claims=[("claim-1", {**CLAIM[1], "operator": "other"})])
        self.assert_left_out(s, t, "no deposit request")

    def test_a_trade_of_another_chain_is_not_used(self):
        s, t = self.setup_leg(TRADE_PAY, trades=[("trade-1", {**TRADE[1], "gateway": "other"})])
        self.assert_left_out(s, t, "no terms")

    def test_two_deposits_of_one_claim_use_it_once(self):
        s = self.setup({ALICE: [], BOB: []})
        s.ledger.claims, s.ledger.tokens = [CLAIM], [TOKEN]
        a, c = self.leg_tx(s, CLAIM_DEP), self.leg_tx(s, CLAIM_DEP, sender=BOB)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [a], [c]
        result = self.build(s)
        self.assertEqual(result["legs"], 1)
        self.assertEqual(len(result["leftOut"]), 1)

    def test_terms_and_requests_still_win_their_own_ids(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS])
        s.ledger.trades, s.ledger.claims, s.ledger.requests, s.ledger.tokens = [TRADE], [CLAIM], [REQUEST], [TOKEN]
        s.reth.pool[ALICE] = [self.leg_tx(s, PAY)]
        s.reth.pool[BOB] = [self.leg_tx(s, DEP, sender=BOB)]
        self.build(s)
        self.assertEqual([l["tag"] for l in s.advance_argument()["legs"]], ["PaymentLeg", "DepositLeg"])
        self.assertNotIn("disclosedContracts", s.ledger.submitted[0])


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

    def test_a_pool_that_refuses_the_resend_still_leaves_out_the_left_out_senders_later_transactions(self):
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS])
        bad = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), ALICE, 0, price=9)   # no terms
        later = self.leg_tx(s, PAY, ALICE, 1, price=9)   # waits behind it: never offered without it
        other = self.leg_tx(s, PAY, BOB, price=1)
        s.reth.pool[ALICE], s.reth.pool[BOB] = [bad, later], [other]
        s.reth.refuse_resend = True
        result = self.build(s)
        self.assertEqual(s.builds(), [[raw_of(bad), raw_of(later), raw_of(other)], [raw_of(other)]])
        self.assertEqual(result["transactions"], [other["hash"]])

    def test_a_broken_connection_while_putting_left_out_transactions_back_keeps_the_saved_copy(self):
        """The left-out rebuild empties nothing before the resend has returned: when the resend dies at the transport level, the
        failure handler sends everything again and clears the copy only if that works; here the connection is gone for good."""
        s = self.setup({ALICE: [], BOB: []}, terms=[TERMS])
        honest = self.leg_tx(s, PAY, ALICE, price=9)
        bad = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), BOB, price=1)   # no terms: left out, then put back
        s.reth.pool[ALICE], s.reth.pool[BOB] = [honest], [bad]
        s.reth.crash_on_send = True
        with self.assertRaises(Exception) as raised:
            self.build(s)
        self.assertNotIsInstance(raised.exception, b.BuilderError)
        self.assertFalse(hasattr(raised.exception, "lost_transactions"))
        self.assertFalse(hasattr(raised.exception, "rewind_error"))
        self.assertTrue(b.saved_path(s.cfg).exists())   # the transactions are on disk although the pool has none
        found = b.recover_saved(s.cfg)
        self.assertEqual((found["recovered"], found["lostTransactions"]), (2, []))
        self.assertEqual(self.in_pool(s), {honest["hash"], bad["hash"]})
        self.assertFalse(b.saved_path(s.cfg).exists())

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
        s.ledger.no_completion = True
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
        self.assertNotIn("packageIdSelectionPreference", sub)   # no --package-id: Canton picks the version by package name, as before
        self.assertEqual(set(sub), {"commands", "commandId", "userId", "actAs", "readAs"})   # the unpinned body keeps exactly its old shape

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


PACKAGE_ID = "ea89dbab" + "0" * 56


class PackagePin(Case):
    """--package-id: Advance is submitted with packageIdSelectionPreference [id], so that vetting a newer version of the package never
    switches the version Advance runs under by itself. Without it the command is exactly as before."""
    def test_advance_carries_the_package_id_it_is_pinned_to(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        s.cfg.package_id = PACKAGE_ID
        self.assertTrue(b.build_block(s.cfg)["committed"])
        (sub,) = s.ledger.submitted
        self.assertEqual(sub["packageIdSelectionPreference"], [PACKAGE_ID])
        self.assertEqual(sub["commands"][0]["ExerciseCommand"]["templateId"], b.CHAIN)   # the template is still named by package name


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

    def test_a_failed_move_back_does_not_hide_the_error_that_made_it_necessary(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        s.reth.no_state_for_genesis = True
        with self.assertRaises(b.ProvingError) as raised:
            b.build_block(s.cfg)
        self.assertIn("prove", str(raised.exception))
        self.assertNotIn("no state found", str(raised.exception))
        self.assertIn("no state found", raised.exception.rewind_error)
        report = b.failure_report(raised.exception)
        self.assertIn("prove", report["error"])
        self.assertNotIn("no state found", report["error"])
        self.assertIn("no state found", report["rewindError"])

    def test_a_refusal_keeps_canton_reason_when_moving_reth_back_fails(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="the sidecar refused the proof: wrong program key")
        s.reth.no_state_for_genesis = True
        result = b.build_block(s.cfg)
        self.assertIs(result["committed"], False)
        self.assertIn("wrong program key", result["reason"])
        self.assertNotIn("no state found", result["reason"])
        self.assertIn("no state found", result["rewindError"])
        self.assertEqual(len(result["keptTransactions"]), 1)

    def test_a_refusal_without_a_failed_move_back_has_no_rewind_error(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="no")
        self.assertNotIn("rewindError", b.build_block(s.cfg))

    def test_a_report_without_a_failed_move_back_has_no_rewind_error(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        with self.assertRaises(b.BuilderError) as raised:
            b.build_block(s.cfg)
        self.assertNotIn("rewindError", b.failure_report(raised.exception))

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
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"])
        proof = s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["proofHex"]
        self.assertEqual((proof[:1664], b.committed_hash(proof)), ("ab" * 832, result["blockHash"]))
        self.assertNotEqual(stale.read_text(), "cd" * 1344)   # every attempt has a folder of its own; the accepted one becomes `out`
        self.assertEqual(stale.read_text(), proof)
        self.assertEqual([x.name for x in stale.parent.parent.glob("out*")], ["out"])

    def test_a_proof_of_another_block_is_never_submitted(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        os.environ["FAKE_PROVER_WRONG_BLOCK"] = "1"   # the prover hands back a proof of some other block
        self.addCleanup(os.environ.pop, "FAKE_PROVER_WRONG_BLOCK", None)
        with self.assertRaises(b.ProvingError) as raised:
            b.build_block(s.cfg)
        self.assertIn("not this block's", str(raised.exception))
        self.assertEqual(len(raised.exception.kept), 1)
        self.assertEqual(s.ledger.submitted, [])
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)

    def test_each_attempt_has_a_folder_of_its_own(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        work = Path(s.cfg.work_dir) / f"block-{HEAD_NUMBER + 1}"
        outs = []
        for _ in range(2):
            with self.assertRaises(b.BuilderError):
                b.build_block(s.cfg)
            outs.append([x for x in (log.split()[2] for log in s.log.read_text().splitlines() if log.startswith("prove"))][-1])
        self.assertNotEqual(outs[0], outs[1])   # the prover is given a new folder each time
        self.assertTrue(all(Path(o).name == "out" and Path(o).parent.parent == work and Path(o).parent.name.startswith("attempt-") for o in outs))

    def test_the_committed_hash_reads_the_public_values(self):
        h = "11" * 32
        words = (bytes([0x20]) + bytes.fromhex(h)).ljust(256, b"\0")
        public = b"".join(words[i:i + 4] + b"\0" * 4 for i in range(0, 256, 4))
        proof = (b"\xab" * 832 + public).hex()
        self.assertEqual(b.committed_hash(proof), "0x" + h)
        self.assertIsNone(b.committed_hash("ab" * 1344))   # not the layout
        self.assertIsNone(b.committed_hash(proof[:-2] + "01"))   # a non-zero byte in a slot's padding

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


def sender(n: int) -> str:
    return "0x%040x" % (n + 1)


class Attempts(b.Attempt):
    """An attempt that keeps its events, in place of a journal file."""
    def __init__(self):
        super().__init__(None, 1)
        self.events = []

    def event(self, name, at=None, **fields):
        super().event(name, at=at, **fields)
        self.events.append((name, fields))


class PackedByGasUsed(Case):
    """A block is filled by the gas its transactions use, by Ethereum's rule: a transaction fits if the gas used so far plus its own gas
    limit is at most the block's gas limit. A wallet that declares three times what it uses no longer cuts the block to a third."""

    def pack(self, pool, **k):
        """Builds one block from the pool and returns (setup, the hashes of the transactions in the block, the Engine payload)."""
        s = self.setup(pool, **k)
        attempt = Attempts()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            b.build_block(s.cfg, journal=attempt)
        s.attempt, s.stderr = attempt, err.getvalue()
        (payload,) = s.engine("engine_newPayloadV4")[0][:1]
        return s, [hash_of(r) for r in payload["transactions"]], payload

    def test_limits_above_use_fill_the_block_by_use(self):
        pool = {sender(i): [tx(sender(i), 0, gas=90_000, used=30_000, price=100 - i)] for i in range(10)}
        hashes = [pool[sender(i)][0]["hash"] for i in range(10)]   # the fake pool loses the transactions that go into the block
        s, got, payload = self.pack(pool, gas_cap=300_000)
        # 30,000 used each: the 8th still fits (7 * 30,000 + 90,000 = 300,000), the 9th does not. By limits only 3 would fit.
        self.assertEqual(got, hashes[:8])
        self.assertEqual(int(payload["gasUsed"], 16), 240_000)
        self.assertLessEqual(int(payload["gasUsed"], 16), 300_000)
        built = [f for n, f in s.attempt.events if n == "built"][0]
        self.assertEqual(built["packed"], "gas_used")

    def test_best_price_first_and_each_senders_nonces_in_order(self):
        a = [tx(ALICE, n, gas=90_000, used=30_000, price=100 - 2 * n) for n in range(3)]
        bob = [tx(BOB, 0, gas=90_000, used=30_000, price=99)]
        want = [a[0]["hash"], bob[0]["hash"], a[1]["hash"], a[2]["hash"]]
        s, got, _ = self.pack({ALICE: a, BOB: bob}, gas_cap=300_000)
        self.assertEqual(got, want)

    def test_the_boundary_is_in(self):
        # 40,000 used by the first; the second's limit 60,000 makes exactly 100,000: it fits. The third's 21,000 then does not.
        one, two, three = (tx(sender(i), 0, gas=g, used=u, price=9 - i) for i, (g, u) in enumerate([(60_000, 40_000), (60_000, 40_000), (21_000, 21_000)]))
        pool = {t["from"]: [t] for t in (one, two, three)}
        _, got, _ = self.pack(pool, gas_cap=100_000)
        self.assertEqual(got, [one["hash"], two["hash"]])

    def test_one_gas_over_the_boundary_is_out(self):
        one, two, three = (tx(sender(i), 0, gas=g, used=u, price=9 - i) for i, (g, u) in enumerate([(60_000, 40_000), (60_001, 40_000), (21_000, 21_000)]))
        _, got, _ = self.pack({t["from"]: [t] for t in (one, two, three)}, gas_cap=100_000)
        self.assertEqual(got, [one["hash"], three["hash"]])   # the one that does not fit does not stop other senders

    def test_a_transaction_that_does_not_fit_ends_its_senders_turn(self):
        first = tx(BOB, 0, gas=60_000, used=60_000, price=9)
        big, after = tx(ALICE, 0, gas=50_000, price=8), tx(ALICE, 1, gas=21_000, price=7)   # 60,000 + 50,000 is over: Alice's turn is over
        other = tx(CAROL, 0, gas=21_000, price=1)
        s, got, _ = self.pack({BOB: [first], ALICE: [big, after], CAROL: [other]}, gas_cap=100_000)
        self.assertEqual(got, [first["hash"], other["hash"]])
        self.assertIn(raw_of(big), s.builds()[0])   # it was offered: reth, not the builder, found that it does not fit

    def test_an_excluded_transaction_ends_its_senders_turn(self):
        a0, a1, b0 = tx(ALICE, 0, gas=90_000, used=30_000, price=9), tx(ALICE, 1, gas=90_000, used=30_000, price=8), tx(BOB, 0, gas=90_000, used=30_000, price=1)
        s = self.setup({ALICE: [a0, a1], BOB: [b0]}, gas_cap=300_000)
        b.build_block(s.cfg, exclude={a0["hash"]})
        self.assertEqual(s.builds()[0], [raw_of(b0)])

    def test_the_candidates_stay_few_when_the_pool_is_deep(self):
        # 100 transactions that each use all of their 30,000 gas, cap 100,000: the block holds 3. Only the transactions that could fit if each
        # earlier one used the least gas a transaction can (4 of them) are offered to reth, or fetched from the pool one by one.
        pool = {sender(i): [tx(sender(i), 0, gas=30_000, used=30_000, price=500 - i)] for i in range(100)}
        want = [pool[sender(i)][0]["hash"] for i in range(3)]
        s, got, _ = self.pack(pool, gas_cap=100_000)
        self.assertEqual(got, want)
        self.assertEqual(len(s.builds()), 1)
        self.assertEqual(len(s.builds()[0]), 4)
        self.assertEqual(len([p for m, p in s.reth.ws_calls if m == "eth_getRawTransactionByHash"]), 4)
        self.assertEqual(s.reth.batches, [4])   # in one JSON-RPC batch

    def test_without_the_flag_reth_refuses_and_the_block_is_packed_by_limits(self):
        first, over, small = tx(BOB, 0, gas=60_000, used=60_000, price=9), tx(ALICE, 0, gas=50_000, used=21_000, price=8), tx(CAROL, 0, gas=21_000, price=7)
        s, got, _ = self.pack({BOB: [first], ALICE: [over], CAROL: [small]}, gas_cap=100_000, skip_invalid=False)
        self.assertEqual(len(s.builds()), 2)   # the offered list failed, then the list by gas limits was built
        self.assertEqual(s.builds()[1], [raw_of(first), raw_of(small)])
        self.assertEqual(got, [first["hash"], small["hash"]])
        built = [f for n, f in s.attempt.events if n == "built"][0]
        self.assertEqual(built["packed"], "gas_limits")
        self.assertIn("more than blocks available gas", built["pack_reason"])
        self.assertIn("gas limits", s.stderr)

    def packed_pool(self):
        return {sender(i): [tx(sender(i), 0, gas=90_000, used=30_000, price=100 - i)] for i in range(10)}

    def test_a_build_with_a_foreign_transaction_falls_back(self):
        s = self.setup(self.packed_pool(), gas_cap=300_000)
        s.reth.tamper = ["extra"]
        b.build_block(s.cfg)
        self.assertEqual(len(s.builds()), 2)
        self.assertEqual(len(s.builds()[1]), 3)   # by limits: 3 * 90,000 is under 300,000, a 4th is over
        built = [r for r in s.engine("engine_newPayloadV4")]
        self.assertEqual(len(built), 1)
        self.assertEqual(built[0][0]["transactions"], s.builds()[1])

    def test_a_build_in_another_order_falls_back(self):
        s = self.setup(self.packed_pool(), gas_cap=300_000)
        s.reth.tamper = ["reorder"]
        b.build_block(s.cfg)
        self.assertEqual(len(s.builds()), 2)
        self.assertEqual(s.engine("engine_newPayloadV4")[0][0]["transactions"], s.builds()[1])

    def test_a_build_over_the_cap_falls_back_and_is_never_imported(self):
        s = self.setup(self.packed_pool(), gas_cap=300_000)
        s.reth.tamper = ["over_cap"]
        b.build_block(s.cfg)
        self.assertEqual(len(s.builds()), 2)
        for (payload, *_rest) in s.engine("engine_newPayloadV4"):
            self.assertLessEqual(int(payload["gasUsed"], 16), 300_000)
        self.assertEqual(len(s.engine("engine_newPayloadV4")), 1)

    def test_a_fallback_that_is_also_wrong_is_an_error_and_nothing_is_imported(self):
        for how in ("extra", "over_cap"):
            s = self.setup(self.packed_pool(), gas_cap=300_000)
            s.reth.tamper_always = how
            with self.assertRaisesRegex(b.BuilderError, "other than the one asked for, or over the gas cap"):
                b.build_block(s.cfg)
            self.assertEqual(s.engine("engine_newPayloadV4"), [])

    def test_the_kept_copy_is_of_the_transactions_that_went_into_the_block(self):
        pool = self.packed_pool()
        s = self.setup(pool, gas_cap=300_000)
        s.reth.tamper = ["extra"]   # the first build is refused: nothing of it may be kept
        with mock.patch.object(b, "save_kept", wraps=b.save_kept) as kept:
            b.build_block(s.cfg)
        (call,) = kept.call_args_list
        self.assertEqual([h for h, _ in call.args[1]], [hash_of(r) for r in s.engine("engine_newPayloadV4")[0][0]["transactions"]])

    def test_the_cap_is_never_passed_and_every_sender_stays_in_order(self):
        import random
        for seed in range(12):
            rnd = random.Random(seed)
            cap = rnd.choice([100_000, 250_000, 600_000])
            pool, k = {}, 0
            for i in range(rnd.randint(2, 7)):
                nonces = []
                for n in range(rnd.randint(1, 5)):
                    limit = rnd.randint(21_000, cap)
                    nonces.append(tx(sender(i), n, gas=limit, used=rnd.randint(21_000, limit), price=1000 - k))
                    k += 1
                pool[sender(i)] = nonces
            order = {t["hash"]: (int(t["from"], 16), int(t["nonce"], 16)) for ts in pool.values() for t in ts}
            _, got, payload = self.pack({k_: list(v) for k_, v in pool.items()}, gas_cap=cap)
            self.assertLessEqual(int(payload["gasUsed"], 16), cap, f"seed {seed}")
            self.assertLessEqual(int(payload["gasLimit"], 16), cap, f"seed {seed}")
            self.assertEqual(len(got), len(set(got)))
            by_sender = {}
            for h in got:
                by_sender.setdefault(order[h][0], []).append(order[h][1])
            for nonces in by_sender.values():
                self.assertEqual(nonces, list(range(len(nonces))), f"seed {seed}")   # a sender's transactions are its first ones, in order

    def test_choosing_with_a_least_gas_per_transaction(self):
        t1, t2, t3 = tx(ALICE, 0, gas=58_000, price=1), tx(BOB, 0, gas=79_000, price=9), tx(CAROL, 0, gas=79_001, price=8)
        picked = b.choose_txs({ALICE: {"0": t1}, BOB: {"0": t2}, CAROL: {"0": t3}}, budget=100_000, exclude=set(), used_each=21_000)
        # BOB first (price 9): 79,000 fits; 21,000 taken off; CAROL's 79,001 is 1 over what is left (79,000); ALICE's 58,000 fits
        self.assertEqual(picked, [t2, t1])
        picked = b.choose_txs({BOB: {"0": t2}, CAROL: {"0": tx(CAROL, 0, gas=79_000, price=8)}}, budget=100_000, exclude=set(), used_each=21_000)
        self.assertEqual(len(picked), 2)   # 79,000 equals what is left: the boundary fits


class PackedWithLegsAndSizes(LegCase):
    """The block packed by gas used, a transaction left out for its leg, and the size of what reth is asked to build from."""

    def bump_use_after_the_first_read(self, s, to):
        """What a leg's transaction leaving the block does to the others: after the first block's logs are read, every transaction uses `to` gas."""
        real, seen = b.read_legs, []

        def read(*a, **k):
            out = real(*a, **k)
            if not seen:
                seen.append(1)
                for ts in s.reth.pool.values():
                    for t in ts:
                        t["_used"] = to
                for t in s.reth.mined.values():
                    t["_used"] = to
            return out
        return mock.patch.object(b, "read_legs", read)

    def test_a_left_out_leg_and_limits_above_the_cap_rebuild_from_the_pool_less_the_left_out(self):
        # Declared limits of 90,000 against a cap of 300,000 and 30,000 used: 8 of the 10 fit. Transaction 5 has a leg without a Canton side. On
        # the new state the others use 40,000 each, so the 9 offered do not all fit: reth runs 6 of them and the rest wait in the pool.
        pool = {sender(i): [tx(sender(i), 0, gas=90_000, used=30_000, price=100 - i)] for i in range(10)}
        s = self.setup(pool, gas_cap=300_000, terms=[TERMS])
        bad = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), sender(5), gas=90_000, used=30_000, price=95)   # no terms
        pool[sender(5)] = [bad]
        everyone = [pool[sender(i)][0] for i in range(10)]
        attempt, err = Attempts(), io.StringIO()
        with self.bump_use_after_the_first_read(s, 40_000), contextlib.redirect_stderr(err):
            result = b.build_block(s.cfg, journal=attempt)
        self.assertTrue(result["committed"], result)
        first, second = s.builds()
        self.assertEqual(first, [raw_of(t) for t in everyone])
        self.assertEqual(second, [raw_of(t) for t in everyone[:5] + everyone[6:]])   # chosen again from the pool less the left-out one: 9 offered, reth runs 6
        (payload,) = [p[0] for p in s.engine("engine_newPayloadV4")][-1:]
        want = everyone[:5] + everyone[6:7]   # reth ran 6 of the 7: 5 * 40,000 used, the 7th's 90,000 limit is over the 60,000 left
        self.assertEqual([hash_of(r) for r in payload["transactions"]], [t["hash"] for t in want])
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [bad["hash"]])
        built = [f for n, f in attempt.events if n == "built"][0]
        self.assertEqual(built["packed"], "gas_used")
        self.assertEqual(built["rebuilds"], 1)
        self.assertIn("packed by", err.getvalue())
        self.assertEqual(self.in_pool(s), {bad["hash"], everyone[7]["hash"], everyone[8]["hash"], everyone[9]["hash"]})   # not lost: in the pool for a later block

    def stuck_pool(self, **k):
        """A top-priced transaction whose Payment leg has no Canton side (a made-up id: no terms), and small ones from other senders."""
        pool = {sender(i): [tx(sender(i), 0, price=100 - i, size=967, name="small")] for i in range(1, 71)}
        s = self.setup(pool, terms=[TERMS], gas_cap=k.pop("gas_cap", 30_000_000))
        bad = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), sender(0), price=1000, **k)
        pool[sender(0)] = [bad]
        return s, bad, pool

    def test_a_top_priced_transaction_over_the_byte_cap_with_no_canton_side_does_not_stall_the_chain(self):
        # 70 KB against the 64 KiB cap, offered alone (the first transaction always is), left out for its leg: the next block choice is made again
        # from the pool and holds the small transactions.
        s, bad, pool = self.stuck_pool(size=70_000)
        small = [pool[sender(i)][0]["hash"] for i in range(1, 71)]
        result = self.build(s)
        first, second = s.builds()
        self.assertEqual(first, [raw_of(bad)])
        self.assertEqual([hash_of(r) for r in second], small[:65])   # 65 of 1,000 bytes fit 65,536
        self.assertLessEqual(sum((len(r) - 2) // 2 for r in second), s.cfg.max_block_tx_bytes)
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [bad["hash"]])
        self.assertEqual(len(result["transactions"]), 65)
        self.assertNotIn(bad["hash"], result["transactions"])

    def test_a_left_out_transaction_of_60_kb_leaves_the_rest_of_the_cap_to_others(self):
        s, bad, pool = self.stuck_pool(size=60_000 - 33)
        result = self.build(s)
        first, second = s.builds()
        self.assertEqual(first[0], raw_of(bad))
        self.assertEqual(len(first), 6)   # 60,000 + 5 * 1,000 is under 65,536, a 6th is not
        self.assertEqual(len(second), 65)   # the 60 KB the left-out one held is refilled
        self.assertEqual(len(result["transactions"]), 65)
        self.assertLessEqual(sum((len(r) - 2) // 2 for r in second), s.cfg.max_block_tx_bytes)

    def test_a_cap_sized_gas_limit_with_no_canton_side_stays_fixed(self):
        s, bad, pool = self.stuck_pool(gas=30_000_000)
        result = self.build(s)
        first, second = s.builds()
        self.assertEqual(first[0], raw_of(bad))
        self.assertNotIn(raw_of(bad), second)
        self.assertGreaterEqual(len(second), 60)
        self.assertEqual([x["transaction"] for x in result["leftOut"]], [bad["hash"]])
        self.assertEqual(len(result["transactions"]), len(second))

    def test_every_left_out_round_adds_an_exclusion_and_the_last_block_is_what_reth_built(self):
        # Two fit a block (limit 100,000 against 130,000, 21,000 used). The first four senders have no Canton side: two are found in each of
        # the first two blocks, so there are two rebuilds, each chosen from the pool with more excluded, and the third block is the good one.
        pool = {sender(i): [tx(sender(i), 0, gas=100_000, price=100 - i)] for i in range(6)}
        s = self.setup(pool, gas_cap=130_000, terms=[TERMS])
        for i in range(4):
            pool[sender(i)] = [self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), sender(i), gas=100_000, price=100 - i)]
        good = [pool[sender(i)][0]["hash"] for i in (4, 5)]
        attempt = Attempts()
        result = b.build_block(s.cfg, journal=attempt)
        self.assertTrue(result["committed"], result)
        self.assertEqual([len(x) for x in s.builds()], [2, 2, 2])
        built = [f for n, f in attempt.events if n == "built"][0]
        self.assertEqual((built["rebuilds"], built["packed"]), (2, "gas_used"))
        self.assertEqual(len(result["leftOut"]), 4)
        self.assertEqual(result["transactions"], good)

    def test_the_kept_copy_after_a_rebuild_is_what_reth_built(self):
        pool = {sender(i): [tx(sender(i), 0, gas=90_000, used=30_000, price=100 - i)] for i in range(10)}
        s = self.setup(pool, gas_cap=300_000, terms=[TERMS])
        bad = self.leg_tx(s, Leg(PAYMENT, "ff" * 32, TKA, PAYEE, 10), sender(5), gas=90_000, used=30_000, price=95)
        pool[sender(5)] = [bad]
        saved = []
        real = b.save_kept
        with self.bump_use_after_the_first_read(s, 40_000), mock.patch.object(b, "save_kept", lambda cfg, pairs, number, attempt=None: (saved.append([h for h, _ in pairs]), real(cfg, pairs, number, attempt))):
            self.build(s)
        (payload,) = [p[0] for p in s.engine("engine_newPayloadV4")][-1:]
        self.assertEqual(saved[-1], [hash_of(r) for r in payload["transactions"]])

    def test_raw_transactions_come_in_one_batch_split_only_by_size(self):
        pool = {sender(i): [tx(sender(i), 0, price=100 - i)] for i in range(6)}
        s = self.setup(pool)
        with b.connect(s.cfg.ws_url, max_size=None) as ws:
            reth = b.Reth(s.cfg, ws)
            hashes = [pool[sender(i)][0]["hash"] for i in range(6)]
            self.assertEqual(reth.call_many("eth_getRawTransactionByHash", [[h] for h in hashes]), ["0x02" + h[2:] for h in hashes])
            self.assertEqual(s.reth.batches, [6])
            frame = s.reth.ws_frames[-1]
            s.reth.batches.clear()
            got = reth.call_many("eth_getRawTransactionByHash", [[h] for h in hashes], limit=frame // 2 + 50)   # too big for one request
            self.assertEqual(got, ["0x02" + h[2:] for h in hashes])
            self.assertGreater(len(s.reth.batches), 1)
            self.assertEqual(sum(s.reth.batches), 6)
            self.assertEqual(reth.call_many("eth_getRawTransactionByHash", []), [])

    def test_what_is_offered_stops_at_about_ten_megabytes_of_raw_hex_in_nonce_order(self):
        # 60 transactions of 128 KB (256 KB of hex each, 15 MB all told, over what reth takes in one request); the first sender has three.
        pool = {sender(0): [tx(sender(0), n, price=1000 - n, size=128_000, name="big") for n in range(3)]}
        for i in range(1, 58):
            pool[sender(i)] = [tx(sender(i), 0, price=500 - i, size=128_000, name="big")]
        s = self.setup(pool, max_request=15_000_000)
        s.cfg.max_block_tx_bytes = 20_000_000   # the byte cap of a block is out of the way: this is the offer cap
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertIn("packed by gas used", err.getvalue())
        (offered,) = s.builds()
        self.assertGreater(sum(len(r) for r in offered), 9_500_000)
        self.assertLessEqual(sum(len(r) for r in offered), 10_000_000)
        self.assertEqual(len(offered), 39)
        self.assertLess(max(s.reth.ws_frames), 15_000_000)
        hashes = [hash_of(r) for r in offered]
        by_sender = {}
        for h in hashes:
            t = next(t for ts in [*s.reth.pool.values(), *([t] for t in s.reth.mined.values())] for t in ts if t["hash"] == h)
            by_sender.setdefault(t["from"], []).append(int(t["nonce"], 16))
        self.assertEqual(by_sender[sender(0)], [0, 1, 2])
        for nonces in by_sender.values():
            self.assertEqual(nonces, list(range(len(nonces))))
        built = [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"]
        self.assertEqual(len(built), 1)   # not a fallback: the build was within what reth takes
        self.assertEqual(s.engine("engine_newPayloadV4")[0][0]["transactions"], offered)


class ByteCap(Case):
    """The block's raw transactions are capped in bytes (--max-block-tx-bytes, 64 KiB by default): our participant's Daml work grows with the
    size of the Advance argument. The cap is applied as a prefix per sender: a transaction that does not fit ends its sender's turn."""
    BODY = 1000 - 33   # padding that makes a fake raw transaction exactly 1,000 bytes (33 are its type byte and hash)

    def offered(self, pool, cap, **k):
        s = self.setup(pool, **k)
        s.cfg.max_block_tx_bytes = cap
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            b.build_block(s.cfg)
        return s, s.builds()[0]

    def test_the_default_is_64_kib(self):
        self.assertEqual(b.Config.__dataclass_fields__["max_block_tx_bytes"].default, 65536)

    def test_the_boundary_is_in(self):
        pool = {sender(i): [tx(sender(i), 0, price=100 - i, size=self.BODY)] for i in range(8)}
        _, offered = self.offered(pool, 5000)
        self.assertEqual(len(offered), 5)
        self.assertEqual(sum((len(r) - 2) // 2 for r in offered), 5000)

    def test_one_byte_under_the_boundary_is_out(self):
        pool = {sender(i): [tx(sender(i), 0, price=100 - i, size=self.BODY)] for i in range(8)}
        _, offered = self.offered(pool, 4999)
        self.assertEqual(len(offered), 4)

    def test_a_transaction_that_does_not_fit_ends_its_senders_turn_and_others_go_on(self):
        a0 = tx(ALICE, 0, price=90, size=self.BODY)
        a1 = tx(ALICE, 1, price=89, size=3000)       # does not fit in what is left
        a2 = tx(ALICE, 2, price=88)                  # small, but it cannot run without a1
        b0 = tx(BOB, 0, price=10)                    # small: fits
        _, offered = self.offered({ALICE: [a0, a1, a2], BOB: [b0]}, 2000)
        self.assertEqual(offered, [raw_of(a0), raw_of(b0)])

    def test_the_first_transaction_is_offered_even_when_over_the_cap_so_none_waits_for_ever(self):
        big, small = tx(ALICE, 0, price=90, size=5000), tx(BOB, 0, price=10)
        _, offered = self.offered({ALICE: [big], BOB: [small]}, 2000)
        self.assertEqual(offered, [raw_of(big)])

    def test_the_block_is_filled_by_gas_used_inside_the_cap(self):
        pool = {sender(i): [tx(sender(i), 0, gas=90_000, used=30_000, price=100 - i, size=self.BODY)] for i in range(20)}
        s, offered = self.offered(pool, 12_000, gas_cap=3_000_000)
        self.assertEqual(len(offered), 12)
        (payload,) = s.engine("engine_newPayloadV4")[0][:1]
        self.assertEqual(payload["transactions"], offered)

    def test_the_fallback_by_gas_limits_is_capped_too(self):
        pool = {sender(i): [tx(sender(i), 0, price=100 - i, size=self.BODY)] for i in range(8)}
        s, offered = self.offered(pool, 3000, skip_invalid=False)
        self.assertEqual(len(offered), 3)
        self.assertEqual(s.builds()[-1], offered)

    def test_the_built_line_names_the_cap_and_the_bytes(self):
        pool = {sender(i): [tx(sender(i), 0, price=100 - i, size=self.BODY)] for i in range(8)}
        s = self.setup(pool)
        s.cfg.max_block_tx_bytes = 3500
        attempt = Attempts()
        with contextlib.redirect_stderr(io.StringIO()):
            b.build_block(s.cfg, journal=attempt)
        built = [f for n, f in attempt.events if n == "built"][0]
        self.assertEqual((built["max_tx_bytes"], built["tx_bytes"]), (3500, 3000))

    def test_a_transaction_that_vanished_from_the_pool_is_not_offered_nor_its_senders_later_ones(self):
        a0, a1, b0 = tx(ALICE, 0, price=90), tx(ALICE, 1, price=89), tx(BOB, 0, price=10)
        s = self.setup({ALICE: [a0, a1], BOB: [b0]})
        s.reth.vanished.add(a0["hash"])   # replaced or evicted between txpool_content and the fetch
        with contextlib.redirect_stderr(io.StringIO()):
            result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(s.builds()[0], [raw_of(b0)])

    def test_a_pool_where_every_transaction_vanished_builds_an_empty_block(self):
        a0 = tx(ALICE, 0)
        s = self.setup({ALICE: [a0]})
        s.reth.vanished.add(a0["hash"])
        with contextlib.redirect_stderr(io.StringIO()):
            result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(s.builds()[0], [])


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
        s.ledger.no_completion, s.ledger.head_fails_after_submit = True, True   # no completion, and the window over with no head to read
        s.ledger.record_time = "2100-01-01T00:00:00.000000Z"
        with mock.patch.object(b, "builder_now", lambda: YEAR_2100):
            code, out = self.run_main(s)
        self.assertEqual(code, 2)
        self.assertIn("committed", out)
        self.assertIsNone(out["committed"])
        self.assertIn("could not be settled", out["reason"])
        self.assertEqual(s.forkchoices()[-1]["finalizedBlockHash"], HEAD_HASH)   # reth is left where it is

    def test_once_settles_an_advance_with_no_answer_by_the_head_when_the_window_is_over(self):
        for commit in (True, False):
            s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
            s.ledger.no_completion, s.ledger.commit = True, commit
            s.ledger.record_time = "2100-01-01T00:00:00.000000Z"   # Canton's time is past the window
            with mock.patch.object(b, "builder_now", lambda: YEAR_2100):   # the builder's clock agrees with Canton's
                code, out = self.run_main(s)
            self.assertEqual((code, out["committed"], out["resolved"]), (0 if commit else 2, commit, "head" if commit else "window"))
            self.assertNotIn("resolve", out)

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

    def test_venue_comes_from_the_command_line(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        seen = []
        real = b.build_block

        def spy(cfg, *args, **kwargs):
            seen.append(cfg.venues)
            return real(cfg, *args, **kwargs)

        with mock.patch.object(b, "build_block", spy):
            code, out = self.run_main(s, "--venue", "v::1", "--venue", "v::1")
        self.assertEqual((code, out["committed"]), (0, True))
        self.assertEqual(seen, [("v::1",)])   # no party twice

    def test_the_package_id_comes_from_the_command_line(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        code, out = self.run_main(s, "--package-id", PACKAGE_ID)
        self.assertEqual((code, out["committed"]), (0, True))
        (sub,) = s.ledger.submitted
        self.assertEqual(sub["packageIdSelectionPreference"], [PACKAGE_ID])

    def test_a_command_line_without_it_sends_no_preference(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        code, out = self.run_main(s)
        self.assertEqual((code, out["committed"]), (0, True))
        self.assertNotIn("packageIdSelectionPreference", s.ledger.submitted[0])
        self.assertEqual(set(s.ledger.submitted[0]), {"commands", "commandId", "userId", "actAs", "readAs"})

    def test_a_bad_package_id_is_one_json_line_before_anything_moves(self):
        for bad in ("", "xyz", "ea89dbab", "G" * 64, PACKAGE_ID + "00"):
            s = self.setup({ALICE: [tx(ALICE, 0)]})
            self.assert_failure(self.run_main(s, "--package-id", bad), "package-id")
            self.assertEqual(s.reth.engine_calls, [])
            self.assertEqual(s.ledger.submitted, [])

    def test_the_block_byte_cap_comes_from_the_command_line_and_a_bad_one_is_one_json_line(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        with mock.patch.object(b, "build_block", wraps=b.build_block) as built:
            code, out = self.run_main(s, "--max-block-tx-bytes", "1234")
        self.assertEqual((code, out["committed"]), (0, True))
        self.assertEqual(built.call_args.args[0].max_block_tx_bytes, 1234)
        for bad in ("0", "-5", "abc"):
            self.assert_failure(self.run_main(self.setup({}), "--max-block-tx-bytes", bad), "max-block-tx-bytes")

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

    def test_once_reports_what_became_of_an_earlier_unanswered_block(self):
        for ok in (True, False):
            t = tx(ALICE, 0)
            s = self.setup({ALICE: [t]})
            s.ledger.late = True
            earlier = b.build_block(s.cfg)
            self.assertIsNone(earlier["committed"])
            s.ledger.land(ok=ok)
            s.ledger.late = False
            with mock.patch.dict(os.environ, {"CZE_WORK_DIR": s.cfg.work_dir}):   # the work folder the first block was made in
                code, out = self.run_main(s)
            settled = out["settledEarlier"]
            self.assertEqual((settled["number"], settled["blockHash"], settled["committed"], settled["resolved"]), (HEAD_NUMBER + 1, earlier["blockHash"], ok, "completion"))
            self.assertEqual(out["number"], HEAD_NUMBER + (2 if ok else 1))   # a committed block is built upon; a failed one is built again

    def test_a_failing_prover_is_one_json_line(self):
        self.assert_failure(self.run_main(self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)), "prove")

    def test_once_reports_the_original_error_and_the_failed_move_back(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, prover_fails=True)
        s.reth.no_state_for_genesis = True
        code, out = self.run_main(s)
        self.assert_failure((code, out), "prove")
        self.assertNotIn("no state found", out["error"])
        self.assertIn("no state found", out["rewindError"])

    def test_once_reports_the_refusal_and_the_failed_move_back(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, refuse="the sidecar refused the proof: wrong program key")
        s.reth.no_state_for_genesis = True
        code, out = self.run_main(s)
        self.assertEqual((code, out["committed"]), (2, False))
        self.assertIn("wrong program key", out["reason"])
        self.assertNotIn("no state found", out["reason"])
        self.assertIn("no state found", out["rewindError"])


YEAR_2100 = 4102444800.0


class NoAnswer(Case):
    """An Advance whose answer did not arrive is settled by its own command id before anything else happens (README.md, "Outcomes")."""

    def first(self, s):
        """A block whose Advance timed out (a 503) and is still in progress at Canton: nothing is decided."""
        s.ledger.late = True
        result = b.build_block(s.cfg)
        self.assertIsNone(result["committed"], result)
        return result

    def settle(self, s, result, pairs=None):
        u = {**result["resolve"], "since": result["resolve"]["submittedAt"]}
        return b.resolve_unknown(s.cfg, u, pairs if pairs is not None else b.read_saved(s.cfg) or [])

    def canton_time(self, s, result, after_window: float):
        """Canton's time (the record time of the checkpoints it shows) is `after_window` seconds after the end of the command's window."""
        at = result["resolve"]["submittedAt"] + s.cfg.resolve_seconds + after_window
        s.ledger.record_time = datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        patch = mock.patch.object(b, "builder_now", lambda: at)   # the clocks agree: only the skew test lets them differ
        patch.start()
        self.addCleanup(patch.stop)

    def test_a_submit_that_times_out_but_commits_later_is_not_rewound_and_the_next_block_goes_on_top(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        result = self.first(s)
        self.assertEqual(result["resolve"]["begin"], 42)   # the ledger end before the submit
        self.assertEqual(s.ledger.head["headHash"], HEAD_HASH[2:])   # Canton's head is still the old one: reading it now would say "not committed"
        # reth stays on the block it built: no move back, the transactions are not given to the pool again
        self.assertEqual(s.forkchoices()[-1], {"headBlockHash": result["blockHash"], "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH})
        self.assertEqual(self.in_pool(s), set())
        with self.assertRaises(b.Unresolved):   # no completion yet, and the window is not over: still nothing decided
            self.settle(s, result)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], result["blockHash"])
        self.assertTrue(b.unresolved_path(s.cfg).exists())
        s.ledger.land(ok=True)   # the command commits
        committed, lost, how, info = self.settle(s, result)
        self.assertEqual((committed, lost, how, info), (True, [], "completion", {"updateId": "u1", "completionOffset": 43}))
        h = result["blockHash"]
        self.assertEqual(s.forkchoices()[-1], {"headBlockHash": h, "safeBlockHash": h, "finalizedBlockHash": h})
        self.assertFalse(b.unresolved_path(s.cfg).exists() or b.saved_path(s.cfg).exists())
        s.ledger.late = False
        s.reth.pool[ALICE] = [tx(ALICE, 1)]
        second = b.build_block(s.cfg)
        self.assertEqual((second["committed"], second["number"]), (True, HEAD_NUMBER + 2))
        numbers = [int(x["commandId"].split("-")[2]) for x in s.ledger.submitted]
        self.assertEqual(numbers, [HEAD_NUMBER + 1, HEAD_NUMBER + 2])   # never two different blocks at one height

    def test_a_submit_that_times_out_and_is_rejected_later_is_refused_and_reth_goes_to_canton_head(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        result = self.first(s)
        s.ledger.land(ok=False, message="UNKNOWN_CONTRACT_SYNCHRONIZERS")
        committed, lost, how, info = self.settle(s, result)
        self.assertEqual((committed, lost, how), (False, [], "completion"))
        self.assertEqual(s.forkchoices()[-1], {"headBlockHash": HEAD_HASH, "safeBlockHash": HEAD_HASH, "finalizedBlockHash": HEAD_HASH})
        self.assertEqual(self.in_pool(s), {t["hash"]})   # the transactions go in a later block
        self.assertFalse(b.unresolved_path(s.cfg).exists() or b.saved_path(s.cfg).exists())

    def test_the_window_passing_by_canton_time_with_no_completion_lets_the_head_decide(self):
        for commit in (True, False):
            s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
            s.ledger.no_completion, s.ledger.commit = True, commit
            result = b.build_block(s.cfg)
            if not commit:
                with self.assertRaises(b.Unresolved):   # Canton's time is still before the end of the window: the head says nothing
                    self.settle(s, result)
                self.canton_time(s, result, -1)
                with self.assertRaises(b.Unresolved):
                    self.settle(s, result)
                self.assertEqual(s.forkchoices()[-1]["headBlockHash"], result["blockHash"])   # reth is untouched
                self.assertTrue(b.unresolved_path(s.cfg).exists())
            self.canton_time(s, result, 1)
            committed, lost, how, info = self.settle(s, result)
            self.assertEqual((committed, how), (commit, "head" if commit else "window"))
            self.assertEqual(s.forkchoices()[-1]["headBlockHash"], result["blockHash"] if commit else HEAD_HASH)

    def test_the_builders_clock_past_the_window_decides_nothing_while_canton_time_is_before_it(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        result = self.first(s)
        result["resolve"]["submittedAt"] -= 10 * s.cfg.resolve_seconds   # our clock says the window ended long ago
        self.canton_time(s, result, -1)   # Canton's checkpoints say the participant has not got there (it lags, or it reconnected)
        with self.assertRaises(b.Unresolved):
            self.settle(s, result)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], result["blockHash"])   # reth is untouched
        self.assertTrue(b.unresolved_path(s.cfg).exists())
        s.ledger.land(ok=True)   # the command commits after all
        committed, _, how, _ = self.settle(s, result)
        self.assertEqual((committed, how), (True, "completion"))
        self.assertEqual(s.forkchoices()[-1]["finalizedBlockHash"], result["blockHash"])

    def test_canton_time_far_ahead_of_the_builders_clock_does_not_settle_by_the_window_and_says_why(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.no_completion, s.ledger.commit = True, False
        result = self.first(s)
        s.ledger.record_time = datetime.fromtimestamp(time.time() + s.cfg.resolve_seconds + 3600, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        with self.assertRaises(b.Unresolved) as raised:   # past the window by Canton's time, but Canton's clock is an hour ahead of ours
            self.settle(s, result)
        self.assertIn("clock", str(raised.exception))
        self.assertIn("ahead", str(raised.exception))
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], result["blockHash"])   # reth is untouched
        self.assertTrue(b.unresolved_path(s.cfg).exists())
        reached = time.time() + s.cfg.resolve_seconds + 3600
        with mock.patch.object(b, "builder_now", lambda: reached):   # the clocks agree again: the window decides
            committed, _, how, _ = self.settle(s, result)
        self.assertEqual((committed, how), (False, "window"))

    def test_canton_time_a_few_seconds_ahead_of_the_builders_clock_still_settles_by_the_window(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.no_completion, s.ledger.commit = True, False
        result = self.first(s)
        at = result["resolve"]["submittedAt"] + s.cfg.resolve_seconds + 1
        s.ledger.record_time = datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        with mock.patch.object(b, "builder_now", lambda: at - 10):   # Canton is 10 s ahead: inside the minute the README assumes
            committed, _, how, _ = self.settle(s, result)
        self.assertEqual((committed, how), (False, "window"))

    def test_the_head_showing_the_block_settles_it_before_the_window_is_over(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.no_completion, s.ledger.commit = True, True
        result = b.build_block(s.cfg)
        committed, _, how, _ = self.settle(s, result)   # Canton's time is long before the end of the window
        self.assertEqual((committed, how), (True, "head"))

    def test_completions_that_cannot_be_read_leave_everything_as_it_is_while_the_head_does_not_show_the_block(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        s.ledger.completions_fail, s.ledger.commit = True, False
        result = b.build_block(s.cfg)
        self.assertIsNone(result["committed"])
        self.assertIn("could not be read", result["reason"])
        self.canton_time(s, result, 1)   # unread completions say nothing about Canton's time, whatever the checkpoints would show
        with self.assertRaises(b.Unresolved):
            self.settle(s, result)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], result["blockHash"])
        s.ledger.head = {"headNumber": str(HEAD_NUMBER + 1), "headHash": result["blockHash"][2:]}   # the head shows the block
        committed, _, how, _ = self.settle(s, result)
        self.assertEqual((committed, how), (True, "head"))

    def test_the_record_names_its_chain_and_a_record_from_another_chain_is_refused(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        result = self.first(s)
        self.assertEqual(result["resolve"]["genesis"], s.reth.genesis)
        self.assertEqual(json.loads(b.unresolved_path(s.cfg).read_text())["genesis"], s.reth.genesis)
        s.ledger.land(ok=True)
        before = len(s.forkchoices())
        s.reth.genesis = "0x" + "77" * 32   # a new chain was started on this machine, and the old record was left behind
        for settle in (lambda: self.settle(s, result), lambda: b.recover_saved(s.cfg)):
            with self.assertRaises(b.BuilderError) as e:
                settle()
            self.assertNotIsInstance(e.exception, b.Unresolved)
            self.assertIn("another chain", str(e.exception))
            self.assertIn(str(b.unresolved_path(s.cfg)), str(e.exception))
        self.assertEqual(len(s.forkchoices()), before)   # reth is not moved
        self.assertTrue(b.unresolved_path(s.cfg).exists() and b.saved_path(s.cfg).exists())   # and nothing is removed
        s.reth.genesis = result["resolve"]["genesis"]
        self.assertEqual(self.settle(s, result)[0], True)

    def test_a_restart_settles_the_command_before_it_moves_reth(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        result = self.first(s)
        with self.assertRaises(b.Unresolved):   # a new process: the command has no completion yet, so reth is not moved to Canton's head
            b.recover_saved(s.cfg)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], result["blockHash"])
        self.assertEqual(self.in_pool(s), set())
        s.ledger.land(ok=True)
        found = b.recover_saved(s.cfg)   # settled as committed: nothing to give back
        self.assertEqual((found["recovered"], found["settled"]["committed"]), (0, True))
        self.assertEqual(s.forkchoices()[-1]["finalizedBlockHash"], result["blockHash"])
        self.assertEqual(self.in_pool(s), set())

    def test_a_restart_after_a_failed_command_gives_the_transactions_back(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        self.first(s)
        s.ledger.land(ok=False)
        found = b.recover_saved(s.cfg)
        self.assertEqual((found["recovered"], found["settled"]["committed"]), (0, False))
        self.assertEqual(self.in_pool(s), {t["hash"]})
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)

    def test_once_waits_for_the_command_and_reports_it_as_if_canton_had_answered(self):
        for ok in (True, False):
            t = tx(ALICE, 0)
            s = self.setup({ALICE: [t]})
            result = self.first(s)
            waited = []
            def sleep(seconds):   # Canton decides while `once` waits
                waited.append(seconds)
                s.ledger.land(ok=ok)
            settled = b.settle_once(s.cfg, result, sleep)
            self.assertEqual(waited, [2])
            self.assertEqual((settled["committed"], settled["resolved"]), (ok, "completion"))
            self.assertNotIn("resolve", settled)
            if ok:
                self.assertEqual((settled["transactions"], settled["updateId"]), ([t["hash"]], "u1"))
            else:
                self.assertEqual(self.in_pool(s), {t["hash"]})

    def interrupted_after_the_post(self):
        """advance() as a process killed during the submit sees it: the POST went out, no answer comes, and the call is cut short."""
        real = b.Ledger.advance
        def advance(ledger, chain, argument, command_id=None, disclosed=None):
            try:
                real(ledger, chain, argument, command_id, disclosed)
            except Exception:
                pass
            raise KeyboardInterrupt
        return mock.patch.object(b.Ledger, "advance", advance)

    def test_the_command_is_recorded_before_it_is_submitted_so_an_interrupt_during_the_submit_leaves_it(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        s.ledger.late = True
        with self.interrupted_after_the_post(), self.assertRaises(KeyboardInterrupt):
            b.build_block(s.cfg)
        (sent,) = s.ledger.submitted
        record = b.load_unresolved(s.cfg)
        self.assertEqual((record["commandId"], record["begin"], record["number"]), (sent["commandId"], 42, HEAD_NUMBER + 1))
        self.assertIsInstance(record["submittedAt"], float)
        # no move back and no put back: the command is in doubt, reth stays on the block it built
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], record["hash"])
        self.assertEqual(self.in_pool(s), set())
        with self.assertRaises(b.Unresolved):   # the restart settles it first: no completion yet, so nothing is rewound or built
            b.recover_saved(s.cfg)
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], record["hash"])
        s.ledger.land(ok=True)
        found = b.recover_saved(s.cfg)
        self.assertEqual((found["settled"]["committed"], found["settled"]["number"]), (True, HEAD_NUMBER + 1))
        self.assertEqual(s.forkchoices()[-1]["finalizedBlockHash"], record["hash"])
        self.assertEqual(len(s.ledger.submitted), 1)   # never a second block at that height

    def test_the_record_is_written_to_disk_and_so_is_its_name_in_the_work_folder(self):
        s = self.setup({})
        synced = []
        real = os.fsync
        def fsync(fd):
            synced.append(stat.S_ISDIR(os.fstat(fd).st_mode))
            real(fd)
        with mock.patch.object(os, "fsync", fsync):
            b.save_unresolved(s.cfg, {"commandId": "c", "hash": "0x1", "begin": 1, "submittedAt": 1.5})
        self.assertEqual(synced, [False, True])   # the file, then the folder that now holds it
        self.assertEqual(b.load_unresolved(s.cfg)["commandId"], "c")

    def test_a_record_with_no_finite_positive_number_for_submitted_at_is_not_an_unresolved_command(self):
        s = self.setup({})
        good = {"commandId": "c", "hash": "0x1", "begin": 1, "submittedAt": 1.5}
        for bad in ({k: v for k, v in good.items() if k != "submittedAt"}, {**good, "submittedAt": True}, {**good, "submittedAt": "1.5"}, {**good, "submittedAt": None}, {**good, "submittedAt": 0}, {**good, "submittedAt": -5}, {**good, "submittedAt": float("nan")}, {**good, "submittedAt": float("inf")}):   # json.loads reads NaN and Infinity: a window that never closes, or one already closed
            b.unresolved_path(s.cfg).parent.mkdir(parents=True, exist_ok=True)
            b.unresolved_path(s.cfg).write_text(json.dumps(bad))
            with self.assertRaises(b.BuilderError, msg=bad) as raised:
                b.load_unresolved(s.cfg)
            self.assertIn("is not an unresolved command", str(raised.exception))
        for ok in (1.5, 1700000000):   # a float, or an integer
            b.unresolved_path(s.cfg).write_text(json.dumps({**good, "submittedAt": ok}))
            self.assertEqual(b.load_unresolved(s.cfg)["submittedAt"], ok)

    def test_a_record_that_cannot_be_saved_means_nothing_is_submitted(self):
        t = tx(ALICE, 0)
        s = self.setup({ALICE: [t]})
        with mock.patch.object(b, "save_unresolved", side_effect=b.BuilderError("disk full")), self.assertRaises(b.BuilderError):
            b.build_block(s.cfg)
        self.assertEqual(s.ledger.submitted, [])
        self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH)   # nothing was sent: the usual move back
        self.assertEqual(self.in_pool(s), {t["hash"]})

    def test_the_record_is_cleared_by_every_definite_answer(self):
        for kwargs in ({}, {"refuse": "wrong program key"}):
            s = self.setup({ALICE: [tx(ALICE, 0)]}, **kwargs)
            result = b.build_block(s.cfg)
            self.assertEqual(result["committed"], not kwargs)
            self.assertFalse(b.unresolved_path(s.cfg).exists())

    def test_the_ledger_end_is_read_before_the_submitted_line_is_written(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        events = []
        attempt = b.Attempt(None, 1)
        attempt.event = lambda name, **kw: events.append(name)
        with mock.patch.object(b.Ledger, "end", side_effect=OSError("the ledger end cannot be read")), self.assertRaises(OSError):
            b.build_block(s.cfg, journal=attempt)
        self.assertNotIn("submitted", events)
        self.assertEqual(s.ledger.submitted, [])

    def test_a_submit_that_plainly_never_reached_the_command_service_is_settled_at_once_as_not_taken(self):
        refused_connection = [("refused", ConnectionRefusedError(61, "Connection refused")),
                              ("refused inside urllib", urllib.error.URLError(ConnectionRefusedError(61, "Connection refused")))]
        for name, error in refused_connection:
            t = tx(ALICE, 0)
            s = self.setup({ALICE: [t]})
            with mock.patch.object(b.Ledger, "advance", side_effect=error), mock.patch.object(b.Ledger, "completion", side_effect=AssertionError("waited")):
                result = b.build_block(s.cfg)
            self.assertEqual((result["committed"], result["rejected"]), (False, False), name)
            self.assertNotIn("resolve", result)
            self.assertFalse(b.unresolved_path(s.cfg).exists(), name)
            self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH, name)
            self.assertEqual(self.in_pool(s), {t["hash"]}, name)
        for status in (401, 403, 429):
            t = tx(ALICE, 0)
            s = self.setup({ALICE: [t]})
            s.ledger.reply_status = status
            result = b.build_block(s.cfg)
            self.assertEqual((result["committed"], result["rejected"]), (False, False), status)
            self.assertNotIn("resolve", result)
            self.assertFalse(b.unresolved_path(s.cfg).exists(), status)
            self.assertEqual(s.forkchoices()[-1]["headBlockHash"], HEAD_HASH, status)
            self.assertEqual(self.in_pool(s), {t["hash"]})

    def test_a_408_or_a_server_error_still_waits_for_the_completion_and_a_dropped_reply_reads_it(self):
        for status in (408, 500, 502, 503):
            s = self.setup({ALICE: [tx(ALICE, 0)]})
            s.ledger.reply_status = status
            result = b.build_block(s.cfg)
            self.assertIsNone(result["committed"], status)   # the command may have been taken: nothing is decided
            self.assertIn("resolve", result, status)
            self.assertTrue(b.unresolved_path(s.cfg).exists(), status)
        s = self.setup({ALICE: [tx(ALICE, 0)]}, drop_but_commit=True)
        self.assertTrue(b.build_block(s.cfg)["committed"])   # the connection was dropped after the commit: its completion says so

    def test_a_command_that_is_a_duplicate_or_already_in_flight_is_no_answer(self):
        for code, refused in (("DUPLICATE_COMMAND", False), ("SUBMISSION_ALREADY_IN_FLIGHT", False), ("INTERPRETATION_ERROR", True)):
            self.assertEqual(b.definite_rejection(409, json.dumps({"code": code, "cause": "x"})), refused, code)

    def test_a_completion_of_the_same_id_from_before_the_submit_is_ignored(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        result = self.first(s)
        s.ledger.earlier = [{"commandId": result["commandId"], "offset": 10, "status": {"code": 9, "message": "another run's"}}]
        with self.assertRaises(b.Unresolved):   # it is before `begin`: not this command's
            self.settle(s, result)
        s.ledger.land(ok=True)
        self.assertEqual(self.settle(s, result)[0], True)

    def test_a_full_page_of_other_completions_is_followed_to_the_commands_own(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        result = self.first(s)
        s.ledger.others = [{"commandId": f"other-{i}", "offset": 100 + i} for i in range(5)]
        s.ledger.land_offset = 200
        s.ledger.land(ok=True)
        before = len(s.ledger.completion_queries)
        with mock.patch.object(b, "COMPLETION_LIMIT", 2):
            self.assertEqual(self.settle(s, result)[:3], (True, [], "completion"))
        self.assertEqual(len(s.ledger.completion_queries) - before, 4)   # the checkpoint at 44 is one more item than the completions alone

    def test_the_completions_are_read_from_the_ledger_end_before_the_submit_for_the_builder_user(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        result = self.first(s)
        s.ledger.land(ok=True)
        self.settle(s, result)
        path, body = s.ledger.completion_queries[-1]
        self.assertEqual((body["beginExclusive"], body["userId"], body["parties"]), (42, "builder-user", [BUILDER]))


class CompletionReading(unittest.TestCase):
    def test_a_completion_is_committed_without_a_status_or_with_code_0_and_failed_otherwise(self):
        done = lambda **v: {"completionResponse": {"Completion": {"value": {"commandId": "c", "offset": 7, **v}}}}
        self.assertEqual(b.completion_in([done(status={}, updateId="u")], "c"), ({"committed": True, "updateId": "u", "completionOffset": 7}, 7, None))
        self.assertEqual(b.completion_in([done(status={"code": 0})], "c")[0]["committed"], True)
        found, last, _ = b.completion_in([done(status={"code": 14, "message": "UNAVAILABLE"})], "c")
        self.assertEqual((found["committed"], "14" in found["reason"], "UNAVAILABLE" in found["reason"]), (False, True, True))
        self.assertEqual(b.completion_in([done()], "other"), (None, 7, None))   # the offset reached, with no completion of this command
        self.assertEqual(b.completion_in([{"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 9}}}}, "nonsense"], "c"), (None, 9, None))
        checkpoint = lambda offset, *times: {"completionResponse": {"OffsetCheckpoint": {"value": {"offset": offset, "synchronizerTimes": [{"synchronizerId": "s", "recordTime": t} for t in times]}}}}
        self.assertEqual(b.completion_in([checkpoint(9, "2026-10-23T10:00:00.5Z")], "c")[2], 1792749600.5)   # Canton's time, in epoch seconds
        self.assertAlmostEqual(b.completion_in([checkpoint(9, "2026-10-23T10:00:00.123456789Z")], "c")[2], 1792749600.123457, places=5)
        self.assertEqual(b.completion_in([checkpoint(9, "2026-10-23T10:00:05Z"), checkpoint(10, "2026-10-23T10:00:01Z")], "c")[2], 1792749605)   # the latest checkpoint
        self.assertEqual(b.completion_in([checkpoint(9, "2026-10-23T10:00:05Z", "2026-10-23T10:00:02Z")], "c")[2], 1792749602)   # every synchronizer must have got there
        for bad in ("yesterday", "2026-10-23T10:00:00+03:00", 5, None):
            self.assertIsNone(b.completion_in([checkpoint(9, bad)], "c")[2], bad)
        self.assertIsNone(b.completion_in([checkpoint(9)], "c")[2])


class ResolveSeconds(unittest.TestCase):
    def config(self, seconds):
        with tempfile.TemporaryDirectory() as state:
            (Path(state) / "jwt.hex").write_text("ab" * 32)
            env = {"CZE_STATE_DIR": state, "CZE_LEDGER_USER": "u", "CZE_BUILDER_PARTY": "p", "CZE_FEE_RECIPIENT": "0x" + "11" * 20}
            if seconds is not None:
                env["CZE_RESOLVE_SECONDS"] = seconds
            with mock.patch.dict(os.environ, env, clear=True):
                return b.Config.from_env()

    def test_a_window_below_120_seconds_is_refused(self):
        for seconds in ("0", "119.9", "-5"):
            with self.assertRaises(b.BuilderError, msg=seconds) as raised:
                self.config(seconds)
            self.assertIn("CZE_RESOLVE_SECONDS", str(raised.exception))
        self.assertEqual(self.config("120").resolve_seconds, 120)
        self.assertEqual(self.config(None).resolve_seconds, 300)


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
