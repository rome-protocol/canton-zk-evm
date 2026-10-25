"""The rehearsal's sidecar stand-in reads a block as the real sidecar does: checked against the real block stored for the sidecar's
tests (sidecar/tests/fixtures/block.json, from this project's own reth). Run: python3 -m unittest discover -s tests -p 'test_demo_sidecar.py'"""
import hashlib, json, sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import demo_sidecar as s

BLOCK = json.loads((HERE.parent / "sidecar" / "tests" / "fixtures" / "block.json").read_text())
VK, ROOT, FIXED = "ab" * 32, "cd" * 32, "ee" * 832


def stand_in(block_hash: str) -> str:
    """What tests/demo_fake_prove.sh writes: the fixed bytes, then public values that commit to the block hash."""
    words = (bytes([0x20]) + bytes.fromhex(block_hash)).ljust(256, b"\0")
    return FIXED + b"".join(words[i:i + 4] + b"\0" * 4 for i in range(0, 256, 4)).hex()


PROOF = stand_in(BLOCK["hash"])


class StandIn(unittest.TestCase):
    def setUp(self):
        s.program_vk, s.root_c, s.accepted = VK, ROOT, FIXED

    def line(self, proof=PROOF, header=BLOCK["header"], txs=BLOCK["txs"]):
        return ",".join([proof, header, txs])

    def test_the_answer_is_what_the_header_says(self):
        want = " ".join(["ok", VK, ROOT, BLOCK["hash"], BLOCK["parentHash"], str(BLOCK["number"]), BLOCK["stateRoot"], str(BLOCK["timestamp"]),
                         str(BLOCK["gasLimit"]), str(BLOCK["gasUsed"]), str(BLOCK["txCount"])])
        self.assertEqual(s.verify(self.line()), want)

    def test_another_proof_is_refused(self):
        flipped = "ef" + PROOF[2:]
        self.assertEqual(s.verify(self.line(proof=flipped)), "no the proof does not verify")

    def test_a_proof_of_another_block_is_refused(self):
        self.assertEqual(s.verify(self.line(proof=stand_in("11" * 32))), "no the proof does not verify")

    def test_an_empty_block_has_no_transactions(self):
        self.assertTrue(s.verify(self.line(txs="")).endswith(" 0"))

    def test_a_line_of_the_wrong_shape_is_refused(self):
        self.assertEqual(s.verify("a,b"), "no malformed input")


class StandInVerify2(unittest.TestCase):
    def line(self, proof=PROOF, header=BLOCK["header"], txs=BLOCK["txs"], body=None):
        body = body if body is not None else f"{len(proof):010d}{proof}{len(header):010d}{header}{txs}"
        return hashlib.sha256(body.encode()).hexdigest() + body

    def setUp(self):
        s.program_vk, s.root_c, s.accepted = VK, ROOT, FIXED

    def test_it_answers_as_verify_does(self):
        want = s.verify(",".join([PROOF, BLOCK["header"], BLOCK["txs"]]))
        self.assertTrue(want.startswith("ok "))
        self.assertEqual(s.verify2(self.line()), want)

    def test_the_fixed_line_reads_as_its_fields(self):
        # the same literal as in daml/test/src/Zk/ChainTest.daml and sidecar/tests/verify.rs: fields aa, 01, cc
        fixed = "63bf501ac3036ecbde797c99ac847bfe8a41194cbe46468d4e668ea0a21686460000000002aa000000000201cc"
        self.assertEqual(self.line(proof="aa", header="01", txs="cc"), fixed)
        self.assertEqual(s.verify2(fixed), s.verify("aa,01,cc"))

    def test_an_empty_block_has_no_transactions(self):
        self.assertTrue(s.verify2(self.line(txs="")).endswith(" 0"))

    def test_the_proof_check_is_the_same(self):
        self.assertEqual(s.verify2(self.line(proof=stand_in("11" * 32))), "no the proof does not verify")

    def test_a_wrong_hash_is_refused(self):
        line = self.line()
        self.assertEqual(s.verify2(("0" if line[0] != "0" else "1") + line[1:]), "no malformed input")

    def test_a_capital_letter_in_a_field_is_refused(self):
        # The caller kept the field as written and hashed it; the text that arrives is lowercased, so the hash no longer matches.
        header = BLOCK["header"]
        upper = header.replace("f", "F", 1)
        self.assertNotEqual(upper, header)
        body = f"{len(PROOF):010d}{PROOF}{len(header):010d}{upper}{BLOCK['txs']}"
        lowered = hashlib.sha256(body.encode()).hexdigest() + body.lower()
        self.assertEqual(s.verify2(lowered), "no malformed input")
        self.assertEqual(s.verify2_why(lowered)[1], "hash")   # refused at the hash: the lowercasing is what the test can tell apart

    def test_a_capital_letter_that_reaches_the_sidecar_is_refused(self):
        body = f"{len(PROOF):010d}{PROOF}{len(BLOCK['header']):010d}{BLOCK['header'].upper()}{BLOCK['txs']}"
        self.assertEqual(s.verify2(self.line(body=body)), "no malformed input")
        self.assertEqual(s.verify2_why(self.line(body=body))[1], "form")   # the case was kept: the hash matches, the hex form does not

    def test_a_short_line_or_a_bad_length_is_refused(self):
        self.assertEqual(s.verify2("ab"), "no malformed input")
        header = BLOCK["header"]
        past_end = [f"{len(PROOF):010d}{PROOF}{len(header) + 20:010d}{header}",
                    f"{len(PROOF) + len(header) + 20:010d}{PROOF}{len(header):010d}{header}{BLOCK['txs']}"]
        for body in past_end + ["", "12", f"{len(PROOF) + 2:010d}{PROOF}", f"{len(PROOF) + 1:010d}{PROOF}0", f"{len(PROOF):010d}{PROOF}", f"000000000x{PROOF}"]:
            self.assertEqual(s.verify2(self.line(body=body)), "no malformed input", body[:20])

    def test_a_field_that_is_not_whole_bytes_is_refused(self):
        self.assertEqual(s.verify2(self.line(txs="abc")), "no malformed input")


if __name__ == "__main__":
    unittest.main()
