"""The builder, against fakes only: a fake reth (builder-only WebSocket port and Engine port), a fake Canton JSON
Ledger API and a fake prover. No real Canton, GPU or reth. Run: python3 -m unittest discover -s builder/tests"""
import base64, contextlib, hashlib, hmac, io, json, os, shutil, sys, tempfile, unittest
from unittest import mock
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
from keccak import keccak256
from fakes import (BUILDER, HEAD_HASH, HEAD_NUMBER, JWT_SECRET, LEDGER_TOKEN, FakeLedger, FakeReth, Raw, raw_of, rlp, tx)

ALICE, BOB = "0x" + "a1" * 20, "0x" + "b2" * 20
TERMS = ("terms-1", {"u": "u::1", "v": "v::1", "operator": "op", "confirmer": "co", "builder": BUILDER, "chainId": "770101", "token": "11" * 20, "holder": "22" * 20, "slot": "0", "allocation": "alloc-1", "expected": "00" * 31 + "0a"})


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


class Case(unittest.TestCase):
    def setup(self, *a, **k):
        s = Setup(*a, **k)
        self.addCleanup(s.close)
        return s


class OneBlock(Case):
    def test_one_good_block_end_to_end(self):
        t1, t2 = tx(ALICE, 0), tx(BOB, 0, price=5)
        s = self.setup({ALICE: [t1], BOB: [t2]}, terms=[TERMS])
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(result["number"], HEAD_NUMBER + 1)
        # reth: the explicit list, in price order, with Prague attributes and an empty withdrawals list
        build = [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"]
        self.assertEqual(len(build), 1)
        parent, attrs, raws, extra = build[0]
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
        # Advance: as the builder, in the line formats of daml/README.md, with the leg's two proofs
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
        self.assertEqual(arg["legs"], [{"terms": "terms-1", "accountNodes": ["aa01", "aa02"], "storageNodes": ["bb01"],
                                        "parentAccountNodes": ["cc01", "cc02"], "parentStorageNodes": ["dd01"]}])
        # reth is asked for the balance's proof at the new block and at the parent, which is Canton's head
        proof_call = [p for m, p in s.reth.ws_calls if m == "eth_getProof"]
        key = "0x" + keccak256(bytes(12) + bytes.fromhex("22" * 20) + bytes(32)).hex()
        self.assertEqual(proof_call, [["0x" + "11" * 20, [key], hex(HEAD_NUMBER + 1)], ["0x" + "11" * 20, [key], hex(HEAD_NUMBER)]])
        self.assertEqual(s.ledger.bad_auth, 0)

    def test_terms_of_another_chain_are_not_legs(self):
        other = ("terms-2", {**TERMS[1], "chainId": "1"})
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS, other])
        b.build_block(s.cfg)
        self.assertEqual([l["terms"] for l in s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"]], ["terms-1"])

    def test_terms_naming_another_operator_or_confirmer_are_skipped_with_a_reason(self):
        wrong_operator = ("terms-2", {**TERMS[1], "operator": "someone-else", "allocation": "alloc-2"})
        wrong_confirmer = ("terms-3", {**TERMS[1], "confirmer": "someone-else", "allocation": "alloc-3"})
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS, wrong_operator, wrong_confirmer])
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        legs = s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"]
        self.assertEqual([l["terms"] for l in legs], ["terms-1"])
        self.assertEqual(sorted(x["terms"] for x in result["skippedTerms"]), ["terms-2", "terms-3"])
        for x in result["skippedTerms"]:
            self.assertIn("operator or confirmer", x["reason"])

    def test_a_leg_is_attached_only_for_a_true_value_and_a_live_allocation(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        result = b.build_block(s.cfg)
        self.assertEqual((result["legs"], result["skippedTerms"]), (1, []))
        interface = [q["eventFormat"]["filtersByParty"][BUILDER]["cumulative"][0]["identifierFilter"].get("InterfaceFilter") for q in s.ledger.queries]
        (asked,) = [i for i in interface if i]
        self.assertEqual(asked["value"]["interfaceId"], "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation")

    def test_a_withdrawn_allocation_means_the_block_lands_without_that_leg(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS], allocations=[])
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(result["legs"], 0)
        (skipped,) = result["skippedTerms"]
        self.assertEqual(skipped["terms"], "terms-1")
        self.assertIn("allocation", skipped["reason"])
        self.assertEqual(s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"], [])
        self.assertEqual([m for m, _ in s.reth.ws_calls if m == "eth_getProof"], [])   # nothing to ask reth about

    def rise_is_not_expected(self, balance, parent_balance, word):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.reth.balance, s.reth.parent_balance = balance, parent_balance   # the terms expect a rise of 0x0a
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(result["legs"], 0)
        (skipped,) = result["skippedTerms"]
        self.assertEqual(skipped["terms"], "terms-1")
        self.assertIn(word, skipped["reason"])
        self.assertEqual(s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"], [])

    def test_a_rise_of_another_amount_means_the_leg_is_skipped(self):
        self.rise_is_not_expected("0x09", "0x00", "rose")   # 9, not 10
        self.rise_is_not_expected("0x0f", "0x03", "rose")   # 12

    def test_a_balance_that_was_already_true_before_this_block_is_not_a_payment(self):
        # The holder has the amount the terms name, but it was there in the parent too: nobody paid in this block.
        self.rise_is_not_expected("0x0a", "0x0a", "rose")

    def test_a_token_that_did_not_exist_in_the_parent_means_the_leg_is_skipped(self):
        # The parent has no account for the token (reth answers with the code hash of no code), so there is no proof of
        # a balance there: Canton's sidecar would refuse the whole block, so the terms wait for a later one.
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.reth.parent_code_hash = "0x" + keccak256(b"").hex()
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        (skipped,) = result["skippedTerms"]
        self.assertEqual(skipped["terms"], "terms-1")
        self.assertIn("did not exist", skipped["reason"])

    def test_a_balance_that_fell_means_the_leg_is_skipped(self):
        self.rise_is_not_expected("0x03", "0x0a", "fell")

    def test_one_skipped_leg_does_not_stop_the_others(self):
        terms = [TERMS, ("terms-3", {**TERMS[1], "allocation": "alloc-3", "holder": "33" * 20})]
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=terms, allocations=["alloc-3"])
        result = b.build_block(s.cfg)
        self.assertEqual([l["terms"] for l in s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"]], ["terms-3"])
        self.assertEqual([x["terms"] for x in result["skippedTerms"]], ["terms-1"])

    def test_a_rise_on_top_of_an_existing_balance_is_a_rise(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.reth.balance, s.reth.parent_balance = "0x0f", "0x05"
        self.assertEqual(b.build_block(s.cfg)["legs"], 1)

    def test_a_skipped_leg_is_reported_also_when_canton_refuses(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS], allocations=[], refuse="no")
        result = b.build_block(s.cfg)
        self.assertFalse(result["committed"])
        self.assertEqual([x["terms"] for x in result["skippedTerms"]], ["terms-1"])

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


class Visibility(Case):
    """--read-as and --disclosed: the operator-hosted builder sees what the operator sees, and passes the contracts
    the token registry discloses. Without them nothing changes."""

    def test_by_default_only_the_builder_reads_and_nothing_is_disclosed(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        b.build_block(s.cfg)
        for q in s.ledger.queries:
            self.assertEqual(list(q["eventFormat"]["filtersByParty"]), [BUILDER])
        (sub,) = s.ledger.submitted
        self.assertEqual(sub["readAs"], [BUILDER])
        self.assertNotIn("disclosedContracts", sub)

    def test_read_as_parties_are_added_to_every_read_and_to_advance(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.cfg.read_as = ("operator::1220cc", "other::1220dd")
        self.assertTrue(b.build_block(s.cfg)["committed"])
        self.assertEqual(len(s.ledger.queries), 3)   # the chain, the allocations, the terms
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


class LegChecks(Case):
    """What the builder checks about a leg's allocation before it attaches the leg. Terms that fail are left out,
    each with its reason, and the block still lands."""

    def skipped(self, s, reason_word):
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual(result["legs"], 0)
        (x,) = result["skippedTerms"]
        self.assertEqual(x["terms"], "terms-1")
        self.assertIn(reason_word, x["reason"])
        self.assertEqual(s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"], [])
        return x

    def test_the_interface_view_is_asked_for(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        b.build_block(s.cfg)
        asked = [q["eventFormat"]["filtersByParty"][BUILDER]["cumulative"][0]["identifierFilter"].get("InterfaceFilter") for q in s.ledger.queries]
        (asked,) = [i for i in asked if i]
        self.assertTrue(asked["value"]["includeInterfaceView"])

    def test_a_passed_settle_before_means_the_leg_is_skipped(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.ledger.views["alloc-1"] = {"settleBefore": "2020-01-01T00:00:00.123456Z"}
        self.skipped(s, "settle-before")
        self.assertEqual([m for m, _ in s.reth.ws_calls if m == "eth_getProof"], [])

    def test_the_deadline_is_judged_by_the_builders_clock(self):
        from datetime import datetime, timezone
        for now, legs in ((2029, 1), (2031, 0)):
            s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
            s.ledger.views["alloc-1"] = {"settleBefore": "2030-01-01T00:00:00Z"}
            with mock.patch.object(b, "utcnow", lambda now=now: datetime(now, 6, 1, tzinfo=timezone.utc)):
                self.assertEqual(b.build_block(s.cfg)["legs"], legs, now)

    def test_a_settle_before_that_cannot_be_read_means_the_leg_is_skipped(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.ledger.views["alloc-1"] = {"settleBefore": "tomorrow"}
        self.skipped(s, "settle-before")

    def test_an_executor_that_is_not_the_chains_operator_means_the_leg_is_skipped(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.ledger.views["alloc-1"] = {"executor": "someone-else"}
        self.skipped(s, "executor")

    def test_a_sender_that_is_not_u_means_the_leg_is_skipped(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.ledger.views["alloc-1"] = {"sender": "v::1", "receiver": "v::1"}
        self.skipped(s, "sender")

    def test_a_receiver_that_is_not_v_means_the_leg_is_skipped(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.ledger.views["alloc-1"] = {"receiver": "u::1"}
        self.skipped(s, "receiver")

    def test_an_allocation_without_a_visible_view_means_the_leg_is_skipped(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS])
        s.ledger.views["alloc-1"] = None
        self.skipped(s, "view")

    def test_two_terms_for_one_allocation_are_both_left_out_and_the_others_stay(self):
        twin = ("terms-2", {**TERMS[1], "holder": "33" * 20})   # the same allocation, alloc-1
        other = ("terms-3", {**TERMS[1], "allocation": "alloc-3", "holder": "44" * 20})
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS, twin, other])
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual([l["terms"] for l in s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"]], ["terms-3"])
        self.assertEqual(sorted(x["terms"] for x in result["skippedTerms"]), ["terms-1", "terms-2"])
        self.assertTrue(all("same allocation" in x["reason"] for x in result["skippedTerms"]))

    def test_terms_of_another_chain_do_not_count_as_a_second_term_for_an_allocation(self):
        elsewhere = ("terms-2", {**TERMS[1], "chainId": "1"})
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS, elsewhere])
        self.assertEqual(b.build_block(s.cfg)["legs"], 1)

    def test_a_term_whose_rise_is_not_true_does_not_block_its_twin(self):
        twin = ("terms-2", {**TERMS[1], "expected": "00" * 31 + "09", "allocation": "alloc-2"})   # reth proves a rise of 0x0a, not 9
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS, twin])
        result = b.build_block(s.cfg)
        self.assertEqual(result["legs"], 1)
        self.assertEqual([x["terms"] for x in result["skippedTerms"]], ["terms-2"])

    def test_one_payment_settles_one_terms_for_a_token_and_holder(self):
        # Two terms for the same token and holder, each with its own allocation, both true of the one payment: only the
        # first goes in, and the other is reported. A third, for another holder, is not affected.
        same = ("terms-2", {**TERMS[1], "allocation": "alloc-2"})
        other = ("terms-3", {**TERMS[1], "allocation": "alloc-3", "holder": "33" * 20})
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS, same, other])
        result = b.build_block(s.cfg)
        self.assertTrue(result["committed"], result)
        self.assertEqual([l["terms"] for l in s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"]], ["terms-1", "terms-3"])
        (x,) = result["skippedTerms"]
        self.assertEqual(x["terms"], "terms-2")
        self.assertIn("same token and holder", x["reason"])

    def test_terms_left_out_for_their_allocation_do_not_take_the_places_of_others(self):
        # terms-1 and terms-2 point at one allocation and are both left out; terms-3 (same token and holder) is the one that goes in.
        twin = ("terms-2", {**TERMS[1], "holder": "33" * 20})
        third = ("terms-3", {**TERMS[1], "allocation": "alloc-3", "holder": "33" * 20})
        s = self.setup({ALICE: [tx(ALICE, 0)]}, terms=[TERMS, twin, third])
        b.build_block(s.cfg)
        self.assertEqual([l["terms"] for l in s.ledger.submitted[0]["commands"][0]["ExerciseCommand"]["choiceArgument"]["legs"]], ["terms-3"])


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
        s = self.setup(pool, gas_cap=70_000)
        b.build_block(s.cfg)
        raws = [p for m, p in s.reth.ws_calls if m == "testing_buildBlockV1"][0][2]
        self.assertEqual(raws, [raw_of(t) for t in pool[ALICE][:3]])   # 63,000; the 4th would make 84,000
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


if __name__ == "__main__":
    unittest.main()
