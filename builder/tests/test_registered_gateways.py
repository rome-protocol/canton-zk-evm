"""The chain's registry of EVM contracts (Daml 0.5.0, `ZkChain.contracts`): for every Gateway entry the builder reads the legs from the block's
receipts, fetches the proof of the gateway's `legs[number]` slot at the block and sends them in Advance's `extraGateways`; a Vault entry gives
nothing to send. Against the same fakes as test_builder.py."""
import sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from test_pipeline import Depth
from fakes import GATEWAY, PAYMENT, Leg, tx

ALICE, BOB, PAY, DEP, TERMS = tb.ALICE, tb.BOB, tb.PAY, tb.DEP, tb.TERMS
G2, G3, VAULT = "b8" * 20, "b9" * 20, "ca" * 20
HASH = "c1" * 32


def entry(address, kind="Gateway", code_hash=HASH):
    return {"contractAddress": address, "contractCodeHash": code_hash, "contractKind": kind}


class Registered(tb.LegCase):
    def chain(self, *entries, **k):
        s = self.setup({}, terms=[TERMS], **k)
        s.ledger.chain_extra = {"contracts": list(entries)}
        return s

    def extras(self, s):
        return s.advance_argument().get("extraGateways", [])

    def pay_at(self, s, address, leg=PAY, sender=BOB, **k):
        t = tx(sender, 0, **k)
        s.reth.other_gateway_legs.setdefault(address, {})[t["hash"]] = [leg]
        s.reth.pool[sender] = [t]
        return t

    def test_a_chain_with_no_registry_leaves_the_field_out(self):
        s = self.setup({ALICE: [tx(ALICE, 0)]})
        self.build(s)
        self.assertNotIn("extraGateways", s.advance_argument())   # the packages before 0.5.0 refuse a field they do not have

    def test_a_registry_that_is_none_or_empty_leaves_the_field_out(self):
        for registry in (None, []):
            s = self.setup({ALICE: [tx(ALICE, 0)]})
            s.ledger.chain_extra = {"contracts": registry}
            self.build(s)
            self.assertNotIn("extraGateways", s.advance_argument())

    def test_a_vault_gives_nothing_to_send_and_nothing_is_read_for_it(self):
        s = self.chain(entry(VAULT, "Vault"))
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.build(s)
        self.assertEqual(self.extras(s), [])
        self.assertEqual({p[0] for p in s.reth.proof_reads}, {"0x" + GATEWAY})

    def test_a_registered_gateway_gets_its_proofs_at_the_block_and_its_legs(self):
        s = self.chain(entry(G2), entry(VAULT, "Vault"))
        t = self.pay_at(s, G2)
        result = self.build(s)
        (extra,) = self.extras(s)
        self.assertEqual((extra["address"], result["legs"]), (G2, 1))
        self.assertEqual(extra["accountNodes"], ["aa01", "dd" + G2 + HASH])   # the last node ends in the code hash
        self.assertEqual(extra["storageNodes"], ["bb" + G2[:4]])
        self.assertEqual(extra["legs"], [{"tag": "PaymentLeg", "value": {"terms": "terms-1"}}])
        self.assertEqual(s.advance_argument()["legs"], [])   # the first gateway recorded none
        number = hex(tb.HEAD_NUMBER + 1)
        slot = "0x" + b.keccak256((tb.HEAD_NUMBER + 1).to_bytes(32, "big") + bytes(32)).hex()
        self.assertIn(["0x" + G2, [slot], number], s.reth.proof_reads)
        self.assertIn(t["hash"], result["transactions"])

    def test_the_first_gateways_legs_and_a_registered_ones_are_kept_apart(self):
        s = self.chain(entry(G2))
        first = tx(ALICE, 0)
        s.reth.tx_legs[first["hash"]] = [PAY]
        second = self.pay_at(s, G2, Leg(PAYMENT, "ef" * 32, tb.TKA, tb.PAYEE, 10))
        s.reth.pool[ALICE] = [first]
        s.ledger.terms = [TERMS, ("terms-2", {**TERMS[1], "dvpId": "ef" * 32, "allocation": "alloc-2"})]
        result = self.build(s)
        self.assertEqual(result["legs"], 2)
        self.assertEqual([l["value"] for l in s.advance_argument()["legs"]], [{"terms": "terms-1"}])
        (extra,) = self.extras(s)
        self.assertEqual([l["value"] for l in extra["legs"]], [{"terms": "terms-2"}])
        self.assertEqual(sorted(result["legTransactions"]), sorted([first["hash"], second["hash"]]))

    def test_every_registered_gateway_has_an_entry_in_the_registry_order_even_with_no_legs(self):
        s = self.chain(entry(G3), entry(VAULT, "Vault"), entry(G2))
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        self.build(s)
        extras = self.extras(s)
        self.assertEqual([e["address"] for e in extras], [G3, G2])
        self.assertTrue(all(e["legs"] == [] and e["accountNodes"] and e["storageNodes"] for e in extras))

    def test_a_leg_of_a_registered_gateway_with_no_canton_side_is_left_out_like_the_first_gateways(self):
        s = self.chain(entry(G2))
        s.ledger.terms = []
        t = self.pay_at(s, G2)
        result = self.assert_left_out(s, t, "no terms", "payment")
        self.assertEqual(self.extras(s)[0]["legs"], [])
        self.assertEqual(result["leftOut"][0]["transaction"], t["hash"])

    def test_a_deposit_of_a_registered_gateway_is_matched_on_canton_too(self):
        s = self.chain(entry(G2))
        t = self.pay_at(s, G2, DEP)
        self.assert_left_out(s, t, "deposit")

    def test_a_proof_that_cannot_be_read_stops_the_block(self):
        s = self.chain(entry(G2))
        s.reth.fail_proof_address = "0x" + G2   # the first gateway's proofs read fine; only the registered gateway's read fails
        s.reth.pool[ALICE] = [tx(ALICE, 0)]
        with self.assertRaises(b.BuilderError) as cm:
            b.build_block(s.cfg)
        self.assertIn(G2, str(cm.exception))
        self.assertIn("0x" + GATEWAY, {p[0] for p in s.reth.proof_reads})   # the first gateway's proof was read before
        self.assertNotIn("0x" + G2, {p[0] for p in s.reth.proof_reads})
        self.assertEqual(s.ledger.commit_count, 0)   # no Advance was sent

    def test_the_refusal_for_a_gateway_registered_since_the_read_is_nobodys_fault(self):
        text = f"the block carries no entry for the registered gateway {G2}"
        self.assertEqual(b.no_fault_refusal({"reason": f"INTERPRETATION_ERROR: {text}"}), "changed")
        self.assertIsNone(b.no_fault_refusal({"reason": "the block carries no entry for the registered gateway nothing"}))
        self.assertIsNone(b.no_fault_refusal({"reason": "the block's parent is not the chain's head"}))

    def test_an_entry_the_builder_cannot_read_stops_the_block(self):
        for bad in (entry("B8" * 20), entry("b8" * 19), entry(G2, "Pool"), {"contractAddress": G2}):
            with self.assertRaises(b.BuilderError):
                b.registered_gateways({"contracts": [bad]})

    def test_a_kind_written_as_a_tagged_value_is_read_too(self):
        self.assertEqual(b.registered_gateways({"contracts": [entry(G2, {"tag": "Gateway", "value": {}}), entry(VAULT, {"tag": "Vault"})]}), [G2])


class Pipelined(Depth, tb.LegCase):
    """With blocks in flight a Gateway entry can be accepted between the cut of a block and its submit: the Advance then names the new chain contract
    with no entry for that gateway, and Daml refuses it. That refusal is nobody's fault, and no transaction becomes a suspect."""

    def test_a_gateway_registered_between_the_cut_and_the_submit_holds_nobody_back(self):
        s = self.setup({}, terms=[TERMS])
        p = self.pipeline(s, 2)
        t = tx(ALICE, 0)
        s.reth.pool[ALICE] = [t]
        ledger, original, text = s.ledger, s.ledger.refusal, f"the block carries no entry for the registered gateway {G2}"
        def refusal(header, cid):
            ledger.refusal = original   # once
            ledger.consumed.append(cid)
            ledger.cids[ledger.cids.index(cid)] = f"{cid.split('@')[0]}#{len(ledger.consumed)}"
            ledger.chain_extra = {"contracts": [entry(G2)]}
            return 409, "INTERPRETATION_ERROR", text
        ledger.refusal = refusal
        self.drive(p, lambda: self.reports)
        self.assertFalse(self.reports[0]["committed"])
        self.assertIn(text, self.reports[0]["reason"])
        self.assertEqual(self.status()["excluded"], [])
        self.assertEqual((p.previous_kept, p.suspects, p.probe), (set(), [], None))
        self.drive(p, lambda: any(r["committed"] for r in self.reports))   # the next block is cut on the registry as it is now
        last = s.ledger.submitted[-1]["commands"][0]["ExerciseCommand"]["choiceArgument"]
        self.assertEqual([g["address"] for g in last["extraGateways"]], [G2])


if __name__ == "__main__":
    unittest.main()
