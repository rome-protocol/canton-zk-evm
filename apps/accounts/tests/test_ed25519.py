"""ed25519.py against the test vectors of RFC 8032, section 7.1, and against signatures that must be refused."""
import hashlib, os, sys, unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ed25519 as E

# (secret key, public key, message, signature): TEST 1, TEST 2 and TEST 3 of RFC 8032
VECTORS = [
    ("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"),
    ("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"),
    ("c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7", "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"),
]


def public_key(seed: bytes) -> bytes:
    h = bytearray(hashlib.sha512(seed).digest()[:32])
    h[0] &= 248; h[31] &= 63; h[31] |= 64
    return E.encode(E.mul(int.from_bytes(h, "little"), E.B))


def sign(seed: bytes, message: bytes) -> bytes:
    """RFC 8032 section 5.1.6: for the tests only; the service verifies and never signs."""
    h = hashlib.sha512(seed).digest()
    a = bytearray(h[:32])
    a[0] &= 248; a[31] &= 63; a[31] |= 64
    a, pub = int.from_bytes(a, "little"), public_key(seed)
    r = int.from_bytes(hashlib.sha512(h[32:] + message).digest(), "little") % E.Q
    big_r = E.encode(E.mul(r, E.B))
    k = int.from_bytes(hashlib.sha512(big_r + pub + message).digest(), "little") % E.Q
    return big_r + ((r + k * a) % E.Q).to_bytes(32, "little")


class Checks:
    """The checks of one verify function (`verify`); the classes below run them on each path."""
    verify = None

    def test_rfc_8032_vectors_verify_and_our_signing_agrees(self):
        for seed, public, message, signature in VECTORS:
            seed, public, message, signature = map(bytes.fromhex, (seed, public, message, signature))
            self.assertEqual(public_key(seed), public)
            self.assertEqual(sign(seed, message), signature)
            self.assertTrue(self.verify(public, message, signature))

    def test_a_changed_message_signature_or_key_is_refused(self):
        _, public, message, signature = map(bytes.fromhex, VECTORS[1])
        self.assertFalse(self.verify(public, message + b"\0", signature))
        self.assertFalse(self.verify(public, b"", signature))
        for i in (0, 31, 32, 63):
            bad = bytearray(signature); bad[i] ^= 1
            self.assertFalse(self.verify(public, message, bytes(bad)), i)
        self.assertFalse(self.verify(bytes.fromhex(VECTORS[0][1]), message, signature))

    def test_malformed_input_is_refused(self):
        _, public, message, signature = map(bytes.fromhex, VECTORS[0])
        s = int.from_bytes(signature[32:], "little")
        self.assertFalse(self.verify(public, message, signature[:63]))
        self.assertFalse(self.verify(public[:31], message, signature))
        self.assertFalse(self.verify(public, message, signature[:32] + (s + E.Q).to_bytes(32, "little")))   # s not below the group order
        self.assertFalse(self.verify(public, message, bytes(64)))
        self.assertFalse(self.verify(b"\xff" * 32, message, signature))   # not a point


class Pure(Checks, unittest.TestCase):
    verify = staticmethod(E.verify_pure)


@unittest.skipIf(E.Ed25519PublicKey is None, "the cryptography package is not installed")
class Fast(Checks, unittest.TestCase):
    verify = staticmethod(E.verify_fast)

    def test_it_agrees_with_the_pure_one_on_changed_signatures(self):
        _, public, message, signature = map(bytes.fromhex, VECTORS[2])
        for i in range(64):
            bad = bytearray(signature); bad[i] ^= 0x10
            self.assertEqual(E.verify_fast(public, message, bytes(bad)), E.verify_pure(public, message, bytes(bad)), i)


class Dispatch(Checks, unittest.TestCase):
    """`verify` uses the cryptography package when it can be imported, and the pure-Python code when it cannot."""
    verify = staticmethod(E.verify)

    def test_without_the_package_the_pure_path_answers(self):
        saved, E.Ed25519PublicKey = E.Ed25519PublicKey, None
        try:
            for seed, public, message, signature in VECTORS:
                self.assertTrue(E.verify(*map(bytes.fromhex, (public, message, signature))))
            self.assertFalse(E.verify(bytes.fromhex(VECTORS[0][1]), b"x", bytes.fromhex(VECTORS[0][3])))
        finally:
            E.Ed25519PublicKey = saved


class Keys(unittest.TestCase):
    def test_keys_of_a_small_order_are_not_usable(self):
        identity = (1).to_bytes(32, "little")
        order_two = (E.P - 1).to_bytes(32, "little")
        order_four = bytes(32)   # y = 0
        for key in (identity, order_two, order_four):
            self.assertFalse(E.usable_key(key), key.hex())
        self.assertTrue(E.usable_key(public_key(bytes(range(32)))))
        self.assertTrue(E.usable_key(bytes.fromhex(VECTORS[0][1])))
        self.assertFalse(E.usable_key(b"\xff" * 32))   # not a point
        self.assertFalse(E.usable_key(bytes(31)))


if __name__ == "__main__":
    unittest.main()
