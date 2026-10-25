"""The fake reth holds to reth's own answers, so a test cannot pass on a fault a real reth would show:
a transaction in any block on the head's chain is `nonce too low` (not only one in the head block), and eth_getProof fails for a
block more than one below the head (reth --rpc.eth-proof-window 1). Run: python3 -m unittest discover -s builder/tests"""
import sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from fakes import GATEWAY, HEAD_HASH, HEAD_NUMBER, FakeReth, RpcError, hash_of, raw_of, tx

SENDER = "0x" + "a1" * 20


class FakeRethChain(unittest.TestCase):
    def setUp(self):
        self.t = [tx(SENDER, n) for n in range(3)]
        self.reth = FakeReth({SENDER: list(self.t)})
        self.addCleanup(self.reth.close)

    def build(self, parent, txs, ts):
        """Build a block on `parent` holding `txs`; returns its hash. The head does not move."""
        out = self.reth._build(parent, {"timestamp": hex(ts)}, [raw_of(t) for t in txs], None)
        return out["executionPayload"]["blockHash"]

    def send(self, t):
        try:
            return self.reth.send_raw(raw_of(t))
        except RpcError as e:
            return str(e)

    def test_a_transaction_in_an_earlier_block_on_the_chain_is_nonce_too_low(self):
        a = self.build(HEAD_HASH, [self.t[0]], 2000)
        b = self.build(a, [self.t[1]], 2001)
        self.reth.became_head(a)
        self.reth.became_head(b)   # a is now the head's parent: the head's state still has t[0]
        self.assertEqual(self.send(self.t[0]), "nonce too low")   # an earlier block
        self.assertEqual(self.send(self.t[1]), "nonce too low")   # the head block
        self.assertEqual(self.send(self.t[2]), "already known")   # still in the pool

    def test_a_transaction_in_a_block_off_the_chain_goes_back_to_the_pool(self):
        a = self.build(HEAD_HASH, [self.t[0]], 2000)
        b = self.build(a, [self.t[1]], 2001)
        self.reth.became_head(a)
        self.reth.became_head(b)
        self.reth.became_head(a)   # an unwind: b is off the chain, a is on it
        self.assertEqual(self.send(self.t[0]), "nonce too low")
        self.assertEqual(self.send(self.t[1]), hash_of(raw_of(self.t[1])))   # back in the pool
        self.assertIn(self.t[1]["hash"], [x["hash"] for x in self.reth.pool[SENDER]])

    def test_after_a_move_back_to_the_first_block_nothing_is_nonce_too_low(self):
        a = self.build(HEAD_HASH, [self.t[0]], 2000)
        self.reth.became_head(a)
        self.reth.became_head(HEAD_HASH)
        self.assertEqual(self.send(self.t[0]), hash_of(raw_of(self.t[0])))

    def proof(self, number):
        try:
            return self.reth._rpc("eth_getProof", ["0x" + GATEWAY, ["0x" + "00" * 32], hex(number)])
        except RpcError as e:
            return str(e)

    def test_eth_getproof_fails_more_than_one_block_below_the_head(self):
        a = self.build(HEAD_HASH, [self.t[0]], 2000)
        b = self.build(a, [self.t[1]], 2001)
        c = self.build(b, [self.t[2]], 2002)
        for h in (a, b, c):
            self.reth.became_head(h)
        head = HEAD_NUMBER + 3
        self.assertIsInstance(self.proof(head), dict)       # the head
        self.assertIsInstance(self.proof(head - 1), dict)   # one below: inside the window
        self.assertIn("proof window", self.proof(head - 2))
        self.assertIn("proof window", self.proof(HEAD_NUMBER))


if __name__ == "__main__":
    unittest.main()
