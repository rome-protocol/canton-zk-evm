"""The fake Canton ledger holds an Advance to Canton's own checks (Chain.daml:137-138, 151), so a test cannot pass on a block that
Canton would refuse: a parent that is not the head, a number that is not the head's plus one, and a contract that is not the
current one (each commit archives the ZkChain contract and creates a new one with a new id). Run: python3 -m unittest discover -s builder/tests"""
import json, sys, unittest, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from keccak import keccak256
from fakes import BUILDER, HEAD_HASH, HEAD_NUMBER, LEDGER_TOKEN, FakeLedger, rlp, rlp_decode


def header(parent_hex: str, number: int, salt: int = 0) -> bytes:
    """A block header as the fake reth builds it: parent hash, number, gas used, timestamp."""
    return rlp([bytes.fromhex(parent_hex), number.to_bytes(4, "big"), salt.to_bytes(4, "big"), (1000 + number).to_bytes(8, "big")])


class FakeLedgerChecks(unittest.TestCase):
    def setUp(self):
        self.ledger = FakeLedger()
        self.addCleanup(self.ledger.close)
        self.head_hash = HEAD_HASH[2:]

    def post(self, path: str, body: dict):
        req = urllib.request.Request(self.ledger.url + path, json.dumps(body).encode(),
                                     {"content-type": "application/json", "authorization": f"Bearer {LEDGER_TOKEN}"})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            with e:
                return e.code, json.loads(e.read())

    def advance(self, hdr: bytes, cid: str, command_id: str):
        return self.post("/v2/commands/submit-and-wait", {"commandId": command_id, "commands": [{"ExerciseCommand": {
            "templateId": "pkg:Zk.Chain:ZkChain", "contractId": cid, "choice": "Advance", "choiceArgument": {"headerHex": hdr.hex()}}}]})

    def chain_ids(self):
        _, found = self.post("/v2/state/active-contracts", {"eventFormat": {"filtersByParty": {BUILDER: {"cumulative": [
            {"identifierFilter": {"TemplateFilter": {"value": {"templateId": "pkg:Zk.Chain:ZkChain"}}}}]}}}})
        return [e["contractEntry"]["JsActiveContract"]["createdEvent"]["contractId"] for e in found]

    def test_a_block_that_extends_the_head_commits(self):
        (cid,) = self.chain_ids()
        h = header(self.head_hash, HEAD_NUMBER + 1)
        self.assertEqual(self.advance(h, cid, "c1")[0], 200)
        self.assertEqual(self.ledger.head, {"headNumber": str(HEAD_NUMBER + 1), "headHash": keccak256(h).hex()})

    def test_a_parent_that_is_not_the_head_is_refused(self):
        (cid,) = self.chain_ids()
        status, answer = self.advance(header("cd" * 32, HEAD_NUMBER + 1), cid, "c1")
        self.assertEqual((status, answer["code"]), (409, "INTERPRETATION_ERROR"))
        self.assertIn("parent is not the chain's head", answer["cause"])
        self.assertEqual(self.ledger.head["headNumber"], str(HEAD_NUMBER))   # nothing moved
        self.assertEqual(self.chain_ids(), [cid])   # the contract is still the current one
        self.assertEqual(self.ledger.outcomes["c1"]["status"]["code"], 9)   # the command failed, as Canton's completion shows

    def test_a_number_that_is_not_the_heads_plus_one_is_refused(self):
        (cid,) = self.chain_ids()
        for number in (HEAD_NUMBER, HEAD_NUMBER + 2):
            status, answer = self.advance(header(self.head_hash, number), cid, f"c{number}")
            self.assertEqual((status, answer["code"]), (409, "INTERPRETATION_ERROR"))
            self.assertIn("number is not the head's plus one", answer["cause"])
        self.assertEqual(self.ledger.head["headNumber"], str(HEAD_NUMBER))

    def test_each_commit_makes_a_new_contract_id(self):
        (first,) = self.chain_ids()
        h1 = header(self.head_hash, HEAD_NUMBER + 1)
        self.advance(h1, first, "c1")
        (second,) = self.chain_ids()
        self.assertNotEqual(second, first)
        self.advance(header(keccak256(h1).hex(), HEAD_NUMBER + 2), second, "c2")
        (third,) = self.chain_ids()
        self.assertEqual(len({first, second, third}), 3)

    def test_a_refusal_keeps_the_contract_id(self):
        (cid,) = self.chain_ids()
        self.advance(header("cd" * 32, HEAD_NUMBER + 1), cid, "c1")
        self.assertEqual(self.chain_ids(), [cid])

    def test_a_submit_on_a_consumed_contract_id_is_refused(self):
        (old,) = self.chain_ids()
        h1 = header(self.head_hash, HEAD_NUMBER + 1)
        self.assertEqual(self.advance(h1, old, "c1")[0], 200)
        # N+1 is correct in every way but one: it is sent on N's consumed contract
        status, answer = self.advance(header(keccak256(h1).hex(), HEAD_NUMBER + 2), old, "c2")
        self.assertEqual((status, answer["code"]), (404, "CONTRACT_NOT_FOUND"))
        self.assertEqual(self.ledger.head["headNumber"], str(HEAD_NUMBER + 1))

    def test_a_contract_id_nobody_made_is_refused(self):
        status, answer = self.advance(header(self.head_hash, HEAD_NUMBER + 1), "nobody-made-this", "c1")
        self.assertEqual((status, answer["code"]), (404, "CONTRACT_NOT_FOUND"))

    def test_a_late_command_is_checked_when_it_is_taken_and_when_it_lands(self):
        self.ledger.late = True
        (cid,) = self.chain_ids()
        h1 = header(self.head_hash, HEAD_NUMBER + 1)
        self.assertEqual(self.advance(h1, cid, "c1")[0], 503)   # taken, no answer in time
        # N is in doubt: N+1 on the same head and the same contract is not a block Canton takes before N lands
        self.assertEqual(self.advance(header(keccak256(h1).hex(), HEAD_NUMBER + 2), cid, "c2")[0], 409)
        self.ledger.land(True)
        self.assertEqual(self.ledger.head["headNumber"], str(HEAD_NUMBER + 1))
        self.assertNotEqual(self.chain_ids(), [cid])

    def test_a_late_command_that_no_longer_fits_fails_when_it_lands(self):
        self.ledger.late = True
        (cid,) = self.chain_ids()
        h = header(self.head_hash, HEAD_NUMBER + 1)
        self.assertEqual(self.advance(h, cid, "c1")[0], 503)
        self.assertEqual(self.advance(header(self.head_hash, HEAD_NUMBER + 1, salt=1), cid, "c2")[0], 503)   # a second block on the same head
        self.ledger.land(True)   # the first commits; the second would be a fork, and Canton fails it
        self.assertEqual(self.ledger.head["headHash"], keccak256(h).hex())
        self.assertEqual(self.ledger.outcomes["c1"]["status"], {})
        self.assertEqual(self.ledger.outcomes["c2"]["status"]["code"], 9)


class RlpRoundTrip(unittest.TestCase):
    def test_strings_of_every_length_round_trip(self):
        for n in (0, 1, 55, 56, 60, 200, 300):
            self.assertEqual(rlp_decode(rlp([b"x" * n])), [b"x" * n], n)

    def test_nested_lists_with_long_strings_round_trip(self):
        v = [b"a", [b"b" * 56, [b"c" * 300]], b"d" * 60]
        self.assertEqual(rlp_decode(rlp(v)), v)


if __name__ == "__main__":
    unittest.main()
