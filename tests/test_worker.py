"""Tests for worker/ (the Canton router's out-relayer and Sepolia claimer) against stand-ins only: a fake chain behind chain.Rpc (answers by selector, keeps the transactions it is sent), a fake
ledger snapshot, and a local HTTP server for the bridge service. No real endpoint is used.
Run: python3 -W error::ResourceWarning -m unittest tests/test_worker.py"""
import contextlib, hashlib, http.server, io, json, os, sys, tempfile, threading, unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from eth_abi import decode, encode
from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from eth_utils import keccak
from hexbytes import HexBytes

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "worker"))
sys.path.insert(0, str(ROOT / "demo"))
import canton, chain, claim_sepolia, main as worker_main, relay_out
from records import Records

SECRET_URL = "http://127.0.0.1:1/secret-key-xyz"
ROUTER, BOOK, GATEWAY, SEPOLIA_BRIDGE = ("0x" + c * 20 for c in "a1 b2 c3 f6".split())
DEST, DEPOSITOR = "0x5b38da6a701c568545dcfcb03fcb875f56beddc4", "alice::1220" + "ab" * 32
CHAIN = {"operator": "op::1", "confirmer": "co::1", "gateway": "gw::1", "builder": "bu::1", "chainId": 770101}
INSTRUMENT = {"admin": "dso::1", "id": "Amulet"}
OSTIA_NETWORK = 75
CFG = {"limits": {"gas": 3_000_000, "gas_price": 100 * 10**9}, "caps": {"hour": 20, "day": 100, "recipient": 10}, "min_balance": 10**16, "wait": 900, "margin": 600}
CLAIM_CFG = {**CFG, "floor": 0, "network": 0, "from_block": 0, "chunk": 50}


class Revert(Exception):
    pass


class FakeChain(chain.Rpc):
    """A chain as chain.Rpc sees it: eth_call answered by (address, selector), sent transactions kept, receipts given by the test."""
    def __init__(self, label="Ostia"):
        super().__init__(label, SECRET_URL)
        self.views, self.sent, self.hashes, self.receipts, self.logs = {}, [], [], {}, []
        self.balance, self.price, self.head, self.final, self.count = 10**18, 10**9, 100, 100, 0

    def mine(self, i, status=1, logs=(), block=100):
        """Gives the i-th transaction that was sent a receipt."""
        self.receipts[self.hashes[i]] = {"blockNumber": hex(block), "status": hex(status), "logs": list(logs)}
        self.count = self.sent[i]["nonce"] + 1

    def on(self, to, signature, ins, outs, fn):
        self.views[(to.lower(), "0x" + chain.selector(signature).hex())] = (ins, outs, fn)

    def call(self, method, params):
        if method == "eth_call":
            ins, outs, fn = self.views[(params[0]["to"].lower(), params[0]["data"][:10])]
            try:
                return "0x" + encode(outs, list(fn(*decode(ins, bytes.fromhex(params[0]["data"][10:]))))).hex()
            except Revert:
                raise chain.ChainError(f"{self.label}: eth_call was refused: execution reverted") from None
        if method == "eth_sendRawTransaction":
            raw = bytes.fromhex(params[0][2:])
            self.sent.append({**TypedTransaction.from_bytes(HexBytes(raw)).as_dict(), "from": Account.recover_transaction(raw)})
            self.hashes.append("0x" + keccak(raw).hex())
            return self.hashes[-1]
        if method == "eth_getLogs":
            lo, hi = int(params[0]["fromBlock"], 16), int(params[0]["toBlock"], 16)
            return [e for e in self.logs if lo <= int(e["blockNumber"], 16) <= hi and e["topics"][0] == params[0]["topics"][0]]
        return {"eth_chainId": hex(770101), "eth_gasPrice": hex(self.price), "eth_estimateGas": hex(100_000), "eth_getTransactionCount": hex(self.count), "eth_getBalance": hex(self.balance),
                "eth_getBlockByNumber": {"number": hex(self.final)}}.get(method) if method != "eth_getTransactionReceipt" else self.receipts.get(params[0])


def routed_log(count, dest=DEST, network=0, coin="0x" + "11" * 20, send=900, fee=105, block=10):
    data = encode(["string", "uint32", "address", "uint256", "uint256", "uint256"], [DEPOSITOR, network, coin, send, fee, count])
    return {"address": ROUTER, "blockNumber": hex(block), "topics": [relay_out.ROUTED_OUT, "0x" + "00" * 32, "0x" + "00" * 32, "0x" + "00" * 12 + dest[2:]], "data": "0x" + data.hex()}


def key_file(folder):
    path = Path(folder) / "relay.key"
    path.write_text(Account.create().key.hex())
    path.chmod(0o600)
    return str(path)


class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.signer = chain.load_signer(key_file(self.dir.name))
        self.records = Records(Path(self.dir.name) / "records.json")
        self.logs = []


class RelayOutTests(Base):
    def setUp(self):
        super().setUp()
        self.rpc = FakeChain("Ostia")
        self.book = {"open": True, "feeOut": 100, "claim": 0, "min": 0, "unit": 10, "room": 10**15, "used": False}
        b = self.book
        self.rpc.on(ROUTER, "book()", [], ["address"], lambda: (BOOK,))
        self.rpc.on(ROUTER, "gateway()", [], ["address"], lambda: (GATEWAY,))
        self.rpc.on(ROUTER, "routeLabel(uint32,address,uint256,uint64)", ["uint32", "address", "uint256", "uint64"], ["string"], lambda n, a, f, x: (b.get("label") or canton.route_label(n, a, f, x),))
        self.rpc.on(ROUTER, "depositId(string,string)", ["string", "string"], ["bytes32"], lambda p, l: (hashlib.sha256(f"deposit,{p},{l}".encode()).digest(),))
        self.rpc.on(BOOK, "checkOut(address,uint32)", ["address", "uint32"], [relay_out.ASSET, "uint256", "uint256"],
                    lambda t, n: ((1, b"\0" * 32, b["feeOut"], 0, 0, b["min"], 0), b["unit"], b["claim"]) if b["open"] else (_ for _ in ()).throw(Revert()))
        self.rpc.on(ROUTER, "lockRoom(address)", ["address"], ["uint256"], lambda t: (b["room"],))
        self.rpc.on(GATEWAY, "used(bytes32)", ["bytes32"], ["bool"], lambda i: (b["used"],))
        self.router = relay_out.Router(self.rpc, ROUTER)
        self.coin = "0x" + "11" * 20
        self.snap = SimpleNamespace(chain=CHAIN, requests=[], allocations={}, wrapped={(INSTRUMENT["admin"], INSTRUMENT["id"]): self.coin})
        self.ledger = SimpleNamespace(snapshot=lambda router: self.snap)

    def add(self, amount="0.0000001005", max_fee=105, nonce=1, label=None, dest=DEST, receiver="gw::1", ends=timedelta(hours=2)):
        label = label or canton.route_label(0, dest, max_fee, nonce)
        cid = f"00a{len(self.snap.requests)}"
        spec = {"settlement": {"executor": "op::1", "settleBefore": (datetime.now(timezone.utc) + ends).isoformat()},
                "transferLeg": {"sender": DEPOSITOR, "receiver": receiver, "amount": amount, "instrumentId": INSTRUMENT}}
        self.snap.allocations[cid] = spec
        request = {**CHAIN, "depositor": DEPOSITOR, "depositId": canton.deposit_id_of(DEPOSITOR, label), "recipient": ROUTER[2:], "allocation": cid, "label": label, "contractId": "00r" + cid}
        self.snap.requests.append(request)
        return request

    def run_once(self, cfg=CFG):
        relay_out.run_once(self.ledger, self.router, self.rpc, self.signer, self.records, cfg, self.logs.append)

    def sent_args(self, i=0):
        return decode(relay_out.CLAIM_TYPES, bytes(self.rpc.sent[i]["data"])[4:])

    def test_a_valid_request_is_sent_through_claim_and_bridge_with_the_requests_own_parts(self):
        r = self.add()
        self.run_once()
        [tx] = self.rpc.sent
        self.assertEqual((tx["to"].hex(), tx["from"], bytes(tx["data"])[:4]), (ROUTER[2:], self.signer.address, chain.selector(relay_out.CLAIM)))
        self.assertEqual(self.sent_args(), (DEPOSITOR, self.coin, 1005, 0, DEST, 105, 1))
        self.assertEqual(self.records.get(r["depositId"])["state"], "sent")
        self.run_once()
        self.assertEqual(len(self.rpc.sent), 1)   # one transaction at a time, and not again for the same request

    def test_it_is_done_only_in_a_final_block_with_the_deposit_count_of_the_routed_out_event(self):
        r = self.add()
        self.run_once()
        log = routed_log(7)
        log["topics"][0] = relay_out.ROUTED_OUT
        self.rpc.mine(0, logs=[log], block=120)
        self.rpc.final = 110
        self.run_once()
        self.assertEqual(self.records.get(r["depositId"])["state"], "sent")   # block 120 is not final: Canton has not committed it
        self.rpc.final = 120
        self.run_once()
        self.assertEqual((self.records.get(r["depositId"])["state"], self.records.get(r["depositId"])["depositCount"]), ("done", 7))

    def test_labels_that_are_not_in_the_exact_form_are_never_sent_and_are_let_alone_for_good(self):
        good = canton.route_label(0, DEST, 105, 1)
        for label in (good.replace("0x5b", "0x5B"), good.replace(":1", ":01") if good.endswith(":1") else good, good + "\n", "r1:0:" + DEST + ":105", "r1:0:0x" + "00" * 20 + ":105:1",
                      "r2:0:" + DEST + ":105:1", f"r1:4294967296:{DEST}:105:1", f"r1:0:{DEST}:105:18446744073709551616"):
            with self.subTest(label):
                self.add(label=label)
        self.run_once()
        self.assertEqual(self.rpc.sent, [])
        self.assertTrue(all(v["permanent"] for v in self.records.data["items"].values()))

    def test_a_label_that_the_router_does_not_rebuild_is_left_alone(self):
        self.add()
        self.book["label"] = "r1:0:" + DEST + ":999:1"
        self.run_once()
        self.assertEqual(self.rpc.sent, [])
        self.assertIn("does not rebuild", self.logs[0])

    def test_the_fee_that_is_finally_charged_may_not_pass_the_most_fee(self):
        # 1005 - 100 = 905 cut to a multiple of 10 is 900: the fee is 105, not the book's 100
        self.add(max_fee=100)
        self.run_once()
        self.assertEqual(self.rpc.sent, [])
        self.assertIn("fee 105 is above", self.logs[0])
        self.add(max_fee=105, nonce=2)
        self.run_once()
        self.assertEqual(len(self.rpc.sent), 1)

    def test_a_route_the_book_refuses_waits_and_goes_when_it_opens_and_other_book_limits_hold(self):
        r = self.add()
        self.book["open"] = False
        self.run_once()
        self.assertEqual((self.rpc.sent, self.records.get(r["depositId"])["permanent"]), ([], False))
        for change in ({"min": 2000}, {"room": 800}, {"feeOut": 1005}):
            with self.subTest(change):
                self.book.update(open=True, **change)
                self.run_once()
                self.assertEqual(self.rpc.sent, [])
                self.book.update(min=0, room=10**15, feeOut=100)
        self.book["used"] = True
        self.run_once()
        self.assertEqual((self.rpc.sent, self.records.get(r["depositId"])["permanent"]), ([], True))
        self.book["used"] = False
        self.records.put(r["depositId"], permanent=False)
        self.run_once()
        self.assertEqual(len(self.rpc.sent), 1)

    def test_an_allocation_that_is_missing_wrong_or_about_to_end_is_not_used(self):
        self.add(receiver="someone::1")
        self.add(nonce=2, ends=timedelta(minutes=5))
        self.add(nonce=3, amount="x")
        r = self.add(nonce=4)
        del self.snap.allocations[r["allocation"]]
        self.run_once()
        self.assertEqual(self.rpc.sent, [])
        self.assertEqual(len(self.logs), 4)

    def test_the_caps_the_balance_and_the_gas_limits_stop_a_send(self):
        self.add()
        for name, change in (("recipient", lambda c: c["caps"].update(recipient=0)), ("day", lambda c: c["caps"].update(day=0)), ("hour", lambda c: c["caps"].update(hour=0)),
                             ("gas price", lambda c: c["limits"].update(gas_price=1)), ("gas", lambda c: c["limits"].update(gas=1)), ("balance", lambda c: c.update(min_balance=10**19))):
            with self.subTest(name):
                cfg = json.loads(json.dumps(CFG))
                change(cfg)
                self.run_once(cfg)
                self.assertEqual(self.rpc.sent, [])
        self.run_once()
        self.assertEqual(len(self.rpc.sent), 1)

    def test_a_transaction_that_sticks_is_replaced_at_twice_the_fees_so_the_next_request_can_go(self):
        r = self.add()
        self.run_once()
        self.records.get(r["depositId"])["at"] -= 10_000
        self.run_once()
        [first, second] = self.rpc.sent
        self.assertEqual((second["to"].hex(), second["nonce"], second["value"], bytes(second["data"])), (self.signer.address[2:].lower(), first["nonce"], 0, b""))
        self.assertEqual((second["maxFeePerGas"], second["maxPriorityFeePerGas"]), (2 * first["maxFeePerGas"], 2 * first["maxPriorityFeePerGas"]))
        self.assertEqual(self.records.get(r["depositId"])["state"], "replaced")
        self.add(nonce=2)
        self.run_once()
        self.assertEqual(len(self.rpc.sent), 3)

    def test_a_restart_finds_the_sent_transaction_again_and_a_reverted_one_is_failed_for_good(self):
        r = self.add()
        self.run_once()
        self.records = Records(self.records.path)
        self.run_once()
        self.assertEqual(len(self.rpc.sent), 1)
        self.rpc.mine(0, status=0)
        self.run_once()
        self.assertEqual(self.records.get(r["depositId"])["state"], "failed")
        self.run_once()
        self.assertEqual(len(self.rpc.sent), 1)
        self.assertEqual(oct(self.records.path.stat().st_mode & 0o777), "0o600")

    def test_requests_for_another_chain_are_not_sent_and_nothing_secret_is_logged_or_recorded(self):
        self.add()
        self.snap.requests[0]["chainId"] = 1
        self.run_once()
        self.assertEqual(self.rpc.sent, [])
        self.add(nonce=2)
        self.rpc.balance = 0
        self.run_once()
        self.run_once()
        text = "\n".join(self.logs) + self.records.path.read_text()
        self.assertNotIn("secret-key-xyz", text)
        self.assertNotIn(self.signer.key.hex()[2:], text)


class Server:
    """A local stand-in for AggKit's bridge service: routes by path, an answer or None for 404."""
    def __init__(self, routes):
        server = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                server.seen.append(self.path)
                answer = routes.get(self.path.split("?")[0].removeprefix("/bridge/v1/"))
                answer = answer(self.path) if callable(answer) else answer
                self.send_response(404 if answer is None else 200)
                self.end_headers()
                self.wfile.write(json.dumps(answer).encode())

            def log_message(self, *a):
                pass
        self.seen, self.http = [], http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.http.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.http.server_address[1]}"

    def stop(self):
        self.http.shutdown()
        self.http.server_close()


HASHES = ["0x" + f"{i:064x}" for i in range(32)]
LEAF = {"deposit_count": 7, "leaf_type": 0, "origin_network": 75, "origin_address": "0x" + "11" * 20, "destination_network": 0, "destination_address": DEST, "global_index": "18446744073709551623",
        "amount": "900", "metadata": "0x01"}
PROOF = {"proof_local_exit_root": HASHES, "proof_rollup_exit_root": HASHES, "l1_info_tree_leaf": {"mainnet_exit_root": "0x" + "aa" * 32, "rollup_exit_root": "0x" + "bb" * 32}}


class ClaimTests(Base):
    def setUp(self):
        super().setUp()
        self.routes = {"bridges": {"bridges": [LEAF]}, "l1-info-tree-index": 5, "injected-l1-info-leaf": {"l1_info_tree_index": 5}, "claim-proof": PROOF}
        self.server = Server({k: (lambda p, k=k: self.routes[k]) for k in self.routes})
        self.addCleanup(self.server.stop)
        self.aggkit = claim_sepolia.Aggkit(self.server.url)
        self.ostia, self.sepolia = FakeChain("Ostia"), FakeChain("Sepolia")
        self.is_claimed = False
        self.sepolia.on(SEPOLIA_BRIDGE, "isClaimed(uint32,uint32)", ["uint32", "uint32"], ["bool"], lambda i, n: (self.is_claimed,))
        self.ostia.logs = [routed_log(7)]

    def run_once(self, cfg=CLAIM_CFG):
        claim_sepolia.run_once(self.aggkit, self.ostia, self.sepolia, ROUTER, SEPOLIA_BRIDGE, OSTIA_NETWORK, self.signer, self.records, cfg, self.logs.append)

    def test_a_ready_transfer_is_claimed_on_sepolia_with_the_leaf_and_proof_of_the_service(self):
        self.run_once()
        [tx] = self.sepolia.sent
        self.assertEqual((tx["to"].hex(), bytes(tx["data"])[:4]), (SEPOLIA_BRIDGE[2:], chain.selector(claim_sepolia.CLAIM)))
        a = decode(claim_sepolia.CLAIM_TYPES, bytes(tx["data"])[4:])
        self.assertEqual((list(a[0]), a[2], a[3], a[4], a[5:]), ([bytes.fromhex(h[2:]) for h in HASHES], 18446744073709551623, b"\xaa" * 32, b"\xbb" * 32, (75, "0x" + "11" * 20, 0, DEST, 900, b"\x01")))
        self.assertEqual(self.ostia.sent, [])
        self.sepolia.mine(0)
        self.run_once()
        self.assertEqual(self.records.get("7")["state"], "claimed")

    def test_only_the_routers_sends_to_this_destination_in_final_blocks_are_read(self):
        self.ostia.logs = [routed_log(7), routed_log(8, network=74), routed_log(9, block=150)]
        self.ostia.final = 100
        self.routes["bridges"] = None
        self.run_once()
        self.assertEqual(sorted(self.records.data["items"]), ["7"])   # 8 goes to another network, 9 is in a block that is not final
        self.assertEqual(self.records.data["cursor"], 100)

    def test_it_waits_at_each_step_the_service_has_not_reached(self):
        for key in ("bridges", "l1-info-tree-index", "injected-l1-info-leaf", "claim-proof"):
            with self.subTest(key):
                saved, self.routes[key] = self.routes[key], None
                self.run_once()
                self.assertEqual(self.sepolia.sent, [])
                self.routes[key] = saved
        self.run_once()
        self.assertEqual(len(self.sepolia.sent), 1)

    def test_a_leaf_that_is_not_the_routers_send_or_a_proof_that_is_malformed_is_never_claimed(self):
        self.routes["bridges"] = {"bridges": [{**LEAF, "amount": "901"}]}
        self.run_once()
        self.assertEqual((self.sepolia.sent, self.records.get("7")["state"]), ([], "mismatch"))
        self.records.put("7", state="pending")
        self.routes["bridges"], self.routes["claim-proof"] = {"bridges": [LEAF]}, {**PROOF, "proof_local_exit_root": HASHES[:31]}
        self.run_once()
        self.assertEqual(self.sepolia.sent, [])
        self.assertIn("claim proof", "\n".join(self.logs))

    def test_a_transfer_that_is_claimed_already_or_under_the_floor_or_over_a_cap_is_not_claimed(self):
        self.is_claimed = True
        self.run_once()
        self.assertEqual((self.sepolia.sent, self.records.get("7")["state"]), ([], "claimed"))
        self.is_claimed = False
        for name, change in (("floor", {"floor": 901}), ("recipient", {"caps": {"hour": 20, "day": 100, "recipient": 0}}), ("balance", {"min_balance": 10**19})):
            with self.subTest(name):
                self.records.put("7", state="pending")
                self.run_once({**CLAIM_CFG, **change})
                self.assertEqual(self.sepolia.sent, [])

    def test_a_claim_that_reverts_is_failed_unless_somebody_else_claimed_and_a_stuck_one_is_tried_again_up_to_three_times(self):
        self.run_once()
        self.sepolia.mine(0, status=0)
        self.is_claimed = True
        self.run_once()
        self.assertEqual(self.records.get("7")["state"], "claimed")
        self.is_claimed = False
        self.records.put("7", state="pending", tries=0)
        for n in range(3):
            self.run_once()
            self.records.get("7")["at"] -= 10_000
            self.run_once()   # replaced: the nonce goes to a transfer of nothing
        self.assertEqual(self.records.get("7")["state"], "failed")

    def test_the_bridge_service_must_be_on_this_machine_and_the_settings_are_needed(self):
        for url in ("http://10.0.0.5:5578", "https://127.0.0.1:5578", "http://127.0.0.1.evil.example:5578"):
            with self.subTest(url), self.assertRaises(SystemExit):
                claim_sepolia.Aggkit(url)
        with self.assertRaises(chain.ChainError):
            self.aggkit.get("bridges", {"network_id": 75, "deposit_count": 2**32})


class MainTests(Base):
    def test_a_worker_with_its_switch_off_reads_and_sends_nothing(self):
        for kind in ("out", "claim"):
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(chain, "Rpc", side_effect=AssertionError), contextlib.redirect_stdout(io.StringIO()) as out:
                worker_main.run([kind, "--once"])
            self.assertIn("is not 1", out.getvalue())

    def test_a_key_file_that_others_can_read_and_an_endpoint_in_the_clear_are_refused(self):
        path = Path(self.dir.name) / "open.key"
        path.write_text("ab" * 32)
        path.chmod(0o644)
        with self.assertRaises(SystemExit) as why:
            chain.load_signer(str(path))
        self.assertIn("chmod 600", str(why.exception))
        self.assertNotIn("ab" * 32, str(why.exception))
        with self.assertRaises(SystemExit):
            chain.Rpc("Sepolia", "http://example.com/key")

    def test_an_unreachable_endpoint_is_described_without_its_url(self):
        with self.assertRaises(chain.ChainError) as why:
            chain.Rpc("Sepolia", SECRET_URL, timeout=1).call("eth_chainId", [])
        self.assertNotIn("secret-key-xyz", str(why.exception))
        self.assertNotIn("127.0.0.1", str(why.exception))


class LabelTests(unittest.TestCase):
    def test_the_label_and_the_id_are_the_routers_own_vectors(self):
        vectors = json.loads((ROOT / "router/test/vectors/r1.json").read_text())["labels"]
        for v in vectors:
            with self.subTest(v["label"][:40]):
                dest = v["dest"]
                self.assertEqual(canton.route_label(v["net"], dest, int(v["maxFee"]), int(v["nonce"])), v["label"])
                self.assertEqual("0x" + canton.deposit_id_of(v["party"], v["label"]), v["id"])
                self.assertEqual(canton.route_parts(v["label"]), (v["net"], dest, int(v["maxFee"]), int(v["nonce"])))

    def test_the_selectors_are_those_of_the_routers_source(self):
        source = (ROOT / "router/src/CantonRouter.sol").read_text()
        for signature in (relay_out.CLAIM, "routeLabel(uint32,address,uint256,uint64)", "depositId(string,string)", "lockRoom(address)"):
            name, types = signature.split("(")
            declared = [l for l in source.splitlines() if f"function {name}(" in l][0]
            shapes = [t.split()[0] for t in declared.split("(", 1)[1].split(")")[0].split(",")]
            self.assertEqual(shapes, signature.split("(")[1].rstrip(")").split(","), signature)


if __name__ == "__main__":
    unittest.main()
