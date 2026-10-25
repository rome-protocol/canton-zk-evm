"""The three stages of a block (build, prove, submit) one at a time, against the fakes. Run: python3 -m unittest discover -s builder/tests"""
import sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_builder as tb
from fakes import HEAD_HASH, HEAD_NUMBER, tx
from websockets.sync.client import connect


class Stages(tb.Case):
    def stages(self, s, **k):
        """Opens the builder's connection as build_block does and cuts the block: returns reth, the chain record and the build stage's answer."""
        ws = connect(s.cfg.ws_url, max_size=None)
        self.addCleanup(ws.close)
        reth = b.Reth(s.cfg, ws)
        chain = b.Ledger(s.cfg).head()
        head = "0x" + chain["headHash"]
        reth.forkchoice(head, head, head)
        return reth, chain, head

    def proof_reads(self, s):
        return [p for m, p in s.reth.ws_calls if m == "eth_getProof"]

    def test_build_reads_the_gateway_proofs_and_leaves_the_prover_alone(self):
        s = self.setup({tb.ALICE: [tx(tb.ALICE, 0)]})
        reth, chain, head = self.stages(s)
        built = b.build(s.cfg, reth, chain, head, set())
        self.assertIsInstance(built, b.Built)
        self.assertEqual((built.n, built.head, built.block_hash), (HEAD_NUMBER + 1, HEAD_HASH, built.payload["blockHash"]))
        self.assertEqual(len(self.proof_reads(s)), 1)   # read at build time, while the block is the tip
        self.assertFalse(s.log.exists())                  # the prover has not run
        self.assertEqual(sorted(p.name for p in built.work.iterdir()), ["block.json", "witness.json"])
        self.assertEqual(s.ledger.submitted, [])          # nothing was sent to Canton

    def test_prove_leaves_the_proof_and_reads_nothing_from_reth(self):
        s = self.setup({tb.ALICE: [tx(tb.ALICE, 0)]})
        reth, chain, head = self.stages(s)
        built = b.build(s.cfg, reth, chain, head, set())
        before = len(s.reth.ws_calls)
        proven = b.prove(s.cfg, built)
        self.assertEqual(len(proven.proof), 2688)
        self.assertEqual(b.committed_hash(proven.proof), built.block_hash)
        self.assertTrue((built.work / "out" / "wrapped-proof.hex").is_file())
        self.assertEqual(len(s.reth.ws_calls), before)
        self.assertEqual(s.ledger.submitted, [])

    def test_prove_failure_names_the_transactions_to_keep(self):
        s = self.setup({tb.ALICE: [tx(tb.ALICE, 0)]}, prover_fails=True)
        reth, chain, head = self.stages(s)
        built = b.build(s.cfg, reth, chain, head, set())
        with self.assertRaises(b.ProvingError) as raised:
            b.prove(s.cfg, built)
        self.assertEqual(raised.exception.kept, [t["hash"] for t in built.chosen])

    def test_submit_sends_the_proofs_read_at_build_time(self):
        s = self.setup({tb.ALICE: [tx(tb.ALICE, 0)]})
        reth, chain, head = self.stages(s)
        built = b.build(s.cfg, reth, chain, head, set())
        reads = len(self.proof_reads(s))
        result = b.submit(s.cfg, reth, built, b.prove(s.cfg, built))
        self.assertTrue(result["committed"], result)
        self.assertEqual(len(self.proof_reads(s)), reads)   # submit reads no proof of its own
        argument = s.advance_argument()
        self.assertEqual((argument["gatewayAccountNodes"], argument["gatewayStorageNodes"]), (built.account_nodes, built.storage_nodes))

    def test_a_block_with_nothing_to_settle_ends_in_the_build_stage(self):
        s = self.setup({})
        reth, chain, head = self.stages(s)
        answer = b.build(s.cfg, reth, chain, head, set(), prove_empty=False)
        self.assertEqual((answer["skipped"], answer["number"]), (True, HEAD_NUMBER + 1))
        self.assertEqual(self.proof_reads(s), [])
        self.assertFalse(s.log.exists())


if __name__ == "__main__":
    unittest.main()
