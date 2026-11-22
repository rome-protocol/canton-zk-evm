#!/usr/bin/env python3
"""Writes r1.json: fixed vectors that every router implementation must reproduce, byte for byte (label text, deposit id, inbox address).
The deposit id is what demo/canton.py's deposit_id_of makes. The inbox address is CREATE2 from the router's pinned address, the salt
keccak256(abi.encode(party, refundNetwork, refundAddress)) and the inbox's code hash. Needs `cast`. Run: python3 make.py > r1.json"""
import hashlib, json, subprocess

ROUTER = "0x000000000000000000000000000000000c0a7001"
INBOX_CODE = open("../../artifacts/CantonInbox.creation.hex").read().strip()


def cast(*args):
    return subprocess.check_output(["cast", *args], text=True).strip()


code_hash = cast("keccak", "0x" + INBOX_CODE)
# Two ids already public in this repo (explorer/src/bridge/canton/fixtures.json) and one made-up one.
parties = [
    "ostia-operator::12207f23ae47643a4c4c61543923d62e6320a6db41e7beba264372e2fd61b040bbbb",
    "bob-treasury::1220" + "09fe" * 16,
    "operator::1220b43735bd74bbb95fa897975034c6419e7c91e61de333bf9e0739edfd424fc092",
]
labels = []
for i, (party, net, dest, fee, nonce) in enumerate([
    (parties[0], 0, "0x5b38da6a701c568545dcfcb03fcb875f56beddc4", 2000000000, 17),
    (parties[1], 74, "0xab8483f64d9c6d1ecf9b849ae677dd3315835cb2", 0, 0),
    (parties[2], 4294967295, "0xffffffffffffffffffffffffffffffffffffffff", 2**256 - 1, 2**64 - 1),
    (parties[0], 1, "0x00000000000000000000000000000000000000a1", 123456789012345678901234567890, 9007199254740993),
]):
    label = f"r1:{net}:{dest}:{fee}:{nonce}"
    labels.append({"party": party, "net": net, "dest": dest, "maxFee": str(fee), "nonce": str(nonce), "label": label,
                   "id": "0x" + hashlib.sha256(f"deposit,{party},{label}".encode()).hexdigest()})
inboxes = []
for party, net, addr in [
    (parties[0], 0, "0x5b38da6a701c568545dcfcb03fcb875f56beddc4"),
    (parties[0], 74, "0xab8483f64d9c6d1ecf9b849ae677dd3315835cb2"),
    (parties[1], 0, "0x5b38da6a701c568545dcfcb03fcb875f56beddc4"),
    (parties[2], 1, "0x00000000000000000000000000000000000000a1"),
]:
    salt = cast("keccak", cast("abi-encode", "f(string,uint32,address)", party, str(net), addr))
    inbox = "0x" + cast("keccak", "0xff" + ROUTER[2:] + salt[2:] + code_hash[2:])[-40:]
    inboxes.append({"party": party, "refundNetwork": net, "refundAddress": addr, "inbox": inbox.lower()})
print(json.dumps({"inboxCodeHash": code_hash, "routerProxy": ROUTER, "labels": labels, "inboxes": inboxes}, indent=2))
