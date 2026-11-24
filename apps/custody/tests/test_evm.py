"""Tests for evm.py: the signature and the transaction the buy worker sends, against known answers. Run: python3 -m unittest discover -s apps/custody/tests"""
import sys, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import evm
from keccak import keccak256

KEY = bytes.fromhex("46" * 32)   # the key of the EIP-155 specification's example


class SignatureCase(unittest.TestCase):
    def test_the_address_of_a_key(self):
        self.assertEqual(evm.address_of(KEY), "9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f")
        self.assertEqual(evm.address_of((1).to_bytes(32, "big")), "7e5f4552091a69125d5dfcb7b8c2659029395bdf")

    def test_a_legacy_transaction_signed_as_the_eip_155_example(self):
        body = [9, 20 * 10**9, 21000, bytes.fromhex("35" * 20), 10**18, b""]
        r, s, recovery = evm.sign(KEY, keccak256(evm.rlp(body + [1, 0, 0])))
        raw = evm.rlp(body + [recovery + 37, r, s])
        self.assertEqual(raw.hex(), "f86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a76400008025a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83")

    def test_the_same_digest_gives_the_same_signature(self):
        digest = keccak256(b"a")
        self.assertEqual(evm.sign(KEY, digest), evm.sign(KEY, digest))

    def test_the_signer_is_recovered_and_s_is_low(self):
        for i in range(20):
            digest = keccak256(bytes([i]))
            r, s, recovery = evm.sign(KEY, digest)
            self.assertLessEqual(s, evm.N // 2)
            self.assertEqual(evm.recover(digest, r, s, recovery), evm.address_of(KEY))

    def test_a_bad_key_is_refused(self):
        for bad in (b"", b"\x00" * 32, b"\xff" * 32, b"\x01" * 31):
            with self.assertRaises(ValueError):
                evm.address_of(bad)


class RlpCase(unittest.TestCase):
    def test_known_encodings(self):
        self.assertEqual(evm.rlp(0), b"\x80")
        self.assertEqual(evm.rlp(b""), b"\x80")
        self.assertEqual(evm.rlp(15), b"\x0f")
        self.assertEqual(evm.rlp(1024), b"\x82\x04\x00")
        self.assertEqual(evm.rlp([]), b"\xc0")
        self.assertEqual(evm.rlp([b"cat", b"dog"]), bytes.fromhex("c88363617483646f67"))
        self.assertEqual(evm.rlp(b"a" * 56), b"\xb8\x38" + b"a" * 56)


class TransferCase(unittest.TestCase):
    TO = "12" * 20

    def sent(self, **over):
        fields = {"chain_id": 770101, "nonce": 7, "to": self.TO, "value": 5 * 10**18, "max_fee": 20 * 10**9, "tip": 10**9, **over}
        return evm.transfer(KEY, **fields)

    def test_it_is_an_eip_1559_transfer_signed_by_the_key(self):
        raw = self.sent()
        self.assertEqual(raw[0], 2)
        unsigned = [770101, 7, 10**9, 20 * 10**9, 21000, bytes.fromhex(self.TO), 5 * 10**18, b"", []]
        digest = keccak256(b"\x02" + evm.rlp(unsigned))
        sig = evm.sign(KEY, digest)
        self.assertEqual(raw, b"\x02" + evm.rlp(unsigned + [sig[2] & 1, sig[0], sig[1]]))
        self.assertEqual(evm.recover(digest, sig[0], sig[1], sig[2]), evm.address_of(KEY))

    def test_the_same_fields_are_the_same_bytes_and_a_new_nonce_is_not(self):
        self.assertEqual(self.sent(), self.sent())
        self.assertNotEqual(self.sent(), self.sent(nonce=8))
        self.assertEqual(keccak256(self.sent()), keccak256(self.sent()))


if __name__ == "__main__":
    unittest.main()
