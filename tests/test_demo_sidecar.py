"""The rehearsal's sidecar stand-in reads a block as the real sidecar does: checked against the real block stored for the sidecar's
tests (sidecar/tests/fixtures/block.json, from this project's own reth). Run: python3 -m unittest discover -s tests -p 'test_demo_sidecar.py'"""
import json, sys, unittest
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


if __name__ == "__main__":
    unittest.main()
