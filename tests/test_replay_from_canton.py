"""network/replay_from_canton.py rebuild: a fake Ledger API with recorded blocks and a fake reth (JSON-RPC and Engine API, with the Engine secret)."""
import contextlib, io, json, sys, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "network"))
import replay_from_canton as rc
from keccak import keccak256

SECRET = bytes.fromhex("11" * 32)
PARTY = "reader::1220abcd"
EMPTY = bytes.fromhex("56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421")   # constants of the test headers
OMMERS = bytes.fromhex("1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347")


def rlp(x) -> bytes:
    if isinstance(x, int):
        x = x.to_bytes((x.bit_length() + 7) // 8, "big")
    if isinstance(x, bytes):
        return x if len(x) == 1 and x[0] < 0x80 else length(len(x), 0x80) + x
    body = b"".join(rlp(i) for i in x)
    return length(len(body), 0xC0) + body


def length(n: int, base: int) -> bytes:
    if n < 56:
        return bytes([base + n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([base + 55 + len(b)]) + b


def header(n: int, parent: bytes, gas_used: int = 21000) -> bytes:
    f = [parent, OMMERS, b"\xfe" * 20, bytes([n]) * 32, EMPTY, EMPTY, b"\x00" * 256, 0, n, 30_000_000, gas_used, 1000 + n, b"", b"\x07" * 32, b"\x00" * 8,
         7, EMPTY, 0, 0, b"\x00" * 32, EMPTY]
    return rlp(f)


LEGACY = rlp([0, 10, 21000, b"\x01" * 20, 5, b"", 27, b"\x02" * 32, b"\x03" * 32])
TYPED = b"\x02" + rlp([770101, 1, 1, 10, 21000, b"\x01" * 20, 5, b"", [], 1, b"\x02" * 32, b"\x03" * 32])


def chain(count: int) -> list:
    """Records of blocks 1..count on a genesis whose hash is GENESIS; block 2 has two transactions, a typed and a legacy one, the others none."""
    recs, parent = [], GENESIS
    for n in range(1, count + 1):
        h = header(n, parent)
        txs = "" if n != 2 else rlp([TYPED, LEGACY]).hex()
        recs.append({"number": n, "hash": "0x" + keccak256(h).hex(), "parent": "0x" + parent.hex(), "header": h, "txs": txs})
        parent = keccak256(h)
    return recs


GENESIS = keccak256(b"genesis")


class FakeCanton:
    """/v2/state/ledger-end and /v2/updates, paged. A checkpoint sits between the transactions, as on a real participant."""
    def __init__(self, records, page_cap=3):
        self.records, self.page_cap, self.requests, self.writes = records, page_cap, [], 0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        threading.Thread(target=lambda: self.server.serve_forever(0.02), daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def updates(self):
        items = []
        for i, r in enumerate(self.records):
            created = {"CreatedEvent": {"templateId": "pkg:Zk.Chain:BlockRecord", "createArgument": {
                "number": str(r["number"]), "blockHash": r["hash"][2:], "parentHash": r["parent"][2:], "headerHex": r["header"].hex(), "txsHex": r["txs"]}}}
            items.append((10 * (i + 1), {"update": {"Transaction": {"value": {"offset": 10 * (i + 1), "events": [created]}}}}))
            items.append((10 * (i + 1) + 5, {"update": {"OffsetCheckpoint": {"value": {"offset": 10 * (i + 1) + 5}}}}))
        return items

    def _handler(self):
        canton = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                canton.requests.append(("GET", self.path, None))
                self._send({"offset": 10 * len(canton.records) + 5})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                canton.requests.append(("POST", self.path, body))
                if not self.path.startswith("/v2/updates"):
                    canton.writes += 1
                    return self._send({"error": "no"}, 404)
                limit = min(int(self.path.split("limit=")[1]), canton.page_cap)
                items = [u for off, u in canton.updates() if body["beginExclusive"] < off <= body["endInclusive"]]
                self._send(items[:limit])

            def do_PUT(self):
                canton.writes += 1

            def _send(self, obj, code=200):
                out = json.dumps(obj).encode()
                self.send_response(code); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
        return H


class FakeReth:
    """JSON-RPC and Engine API in one object, on two ports. newPayload rebuilds the header from the payload's fields and checks it hashes to the payload's block hash,
    the way reth does; `refuse` answers INVALID for a block number, `differ` makes reth's own hash for a block number another one."""
    def __init__(self, blocks=None, refuse=(), differ=None):
        self.blocks = blocks or [GENESIS]   # canonical hashes by number, genesis first
        self.known = {h: i for i, h in enumerate(self.blocks)}
        self.pending, self.refuse, self.differ, self.calls, self.bad_jwt = {}, set(refuse), differ or {}, [], 0
        self.http = self._serve(False)
        self.engine = self._serve(True)
        self.http_url, self.engine_url = (f"http://127.0.0.1:{s.server_port}" for s in (self.http, self.engine))

    def _serve(self, engine):
        reth = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                if engine and self.headers.get("authorization", "").removeprefix("Bearer ").count(".") != 2:
                    reth.bad_jwt += 1
                    self.send_response(401); self.end_headers()
                    return
                reth.calls.append(body["method"])
                out = json.dumps({"jsonrpc": "2.0", "id": 1, "result": reth.answer(body["method"], body["params"])}).encode()
                self.send_response(200); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
        server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=lambda: server.serve_forever(0.02), daemon=True).start()
        return server

    def close(self):
        for s in (self.http, self.engine):
            s.shutdown(); s.server_close()

    def answer(self, method, params):
        if method == "eth_getBlockByNumber":
            n = len(self.blocks) - 1 if params[0] == "latest" else int(params[0], 16)
            return {"number": hex(n), "hash": "0x" + self.blocks[n].hex()} if n < len(self.blocks) else None
        if method == "engine_newPayloadV4":
            p = params[0]
            n = int(p["blockNumber"], 16)
            if n in self.refuse:
                return {"status": "INVALID", "latestValidHash": None, "validationError": "the state root does not match"}
            parent = bytes.fromhex(p["parentHash"][2:])
            if parent not in self.known:
                return {"status": "SYNCING", "latestValidHash": None, "validationError": None}
            b = lambda k: bytes.fromhex(p[k][2:])
            i = lambda k: int(p[k], 16)
            hdr = rlp([parent, OMMERS, b("feeRecipient"), b("stateRoot"), EMPTY, b("receiptsRoot"), b("logsBloom"), 0, i("blockNumber"), i("gasLimit"),
                       i("gasUsed"), i("timestamp"), b("extraData"), b("prevRandao"), b"\x00" * 8, i("baseFeePerGas"), EMPTY, i("blobGasUsed"),
                       i("excessBlobGas"), bytes.fromhex(params[2][2:]), EMPTY])
            if "0x" + keccak256(hdr).hex() != p["blockHash"] or params[1] != [] or params[3] != [] or p["withdrawals"] != []:
                return {"status": "INVALID", "latestValidHash": None, "validationError": "block hash mismatch"}
            self.pending[p["blockHash"]] = (n, self.differ.get(n, bytes.fromhex(p["blockHash"][2:])), p["transactions"])
            return {"status": "VALID", "latestValidHash": p["blockHash"], "validationError": None}
        if method == "engine_forkchoiceUpdatedV3":
            state = params[0]
            assert state["headBlockHash"] == state["safeBlockHash"] == state["finalizedBlockHash"]
            n, h, _ = self.pending[state["headBlockHash"]]
            del self.blocks[n:]
            self.blocks.append(h); self.known[h] = n
            return {"payloadStatus": {"status": "VALID", "latestValidHash": state["headBlockHash"]}, "payloadId": None}
        raise AssertionError(method)


class Case(unittest.TestCase):
    def setUp(self):
        self.closers = []

    def tearDown(self):
        for c in self.closers:
            c.close()

    def parts(self, records, reth=None, page_cap=3):
        canton = FakeCanton(records, page_cap)
        reth = reth or FakeReth()
        self.closers += [canton, reth]
        return rc.Canton(canton.url, PARTY, page=2), rc.Reth(reth.http_url, reth.engine_url, SECRET), canton, reth


class Rebuild(Case):
    def test_a_clean_rebuild_ends_on_cantons_head(self):
        recs = chain(6)
        canton, client, fake_canton, reth = self.parts(recs)
        r = rc.rebuild(canton, client)
        self.assertEqual((r["applied"], r["canton_head"], r["reth_head"], r["reth_before"]), (6, 6, 6, 0))
        self.assertEqual(r["reth_hash"], r["canton_hash"])
        self.assertEqual(reth.blocks[1:], [bytes.fromhex(x["hash"][2:]) for x in recs])
        self.assertEqual(reth.bad_jwt, 0)
        self.assertGreater(len([q for q in fake_canton.requests if q[1].startswith("/v2/updates")]), 3, "Canton was read in pages")

    def test_the_transactions_reach_reth_as_the_record_has_them(self):
        recs = chain(2)
        canton, client, _, reth = self.parts(recs)
        rc.rebuild(canton, client)
        txs = reth.pending[recs[1]["hash"]][2]
        self.assertEqual(txs, ["0x" + TYPED.hex(), "0x" + LEGACY.hex()])
        self.assertEqual(reth.pending[recs[0]["hash"]][2], [])

    def test_it_reads_canton_and_writes_nothing(self):
        canton, client, fake_canton, _ = self.parts(chain(3))
        rc.rebuild(canton, client)
        self.assertEqual(fake_canton.writes, 0)
        self.assertEqual({m for m, _, _ in fake_canton.requests}, {"GET", "POST"})
        self.assertTrue(all(p.startswith(("/v2/state/ledger-end", "/v2/updates")) for _, p, _ in fake_canton.requests))

    def test_a_run_goes_on_from_where_reth_is(self):
        recs = chain(6)
        canton, client, fake_canton, reth = self.parts(recs[:3])   # Canton had 3 blocks
        self.assertEqual(rc.rebuild(canton, client)["applied"], 3)
        fake_canton.records = recs                                  # and has 6 now
        reth.calls.clear()
        r = rc.rebuild(canton, client)
        self.assertEqual((r["applied"], r["reth_before"], r["reth_head"]), (3, 3, 6))
        self.assertEqual(reth.calls.count("engine_newPayloadV4"), 3)

    def test_a_rerun_at_the_head_applies_nothing(self):
        canton, client, _, reth = self.parts(chain(3))
        rc.rebuild(canton, client)
        reth.calls.clear()
        self.assertEqual(rc.rebuild(canton, client)["applied"], 0)
        self.assertNotIn("engine_newPayloadV4", reth.calls)

    def test_a_block_reth_refuses_stops_the_run_at_that_block(self):
        canton, client, _, reth = self.parts(chain(6), FakeReth(refuse={4}))
        with self.assertRaises(rc.ReplayError) as e:
            rc.rebuild(canton, client)
        self.assertEqual(e.exception.number, 4)
        self.assertIn("INVALID", e.exception.why)
        self.assertEqual(len(reth.blocks) - 1, 3, "reth stays on the last good block")
        self.assertIn("block=4", e.exception.report())

    def test_a_hash_that_differs_from_the_recorded_one_stops_with_both_hashes(self):
        recs = chain(5)
        other = bytes([9]) * 32
        canton, client, _, reth = self.parts(recs, FakeReth(differ={3: other}))
        with self.assertRaises(rc.ReplayError) as e:
            rc.rebuild(canton, client)
        x = e.exception
        self.assertEqual((x.number, x.recorded, x.found), (3, recs[2]["hash"], "0x" + other.hex()))
        self.assertEqual(reth.calls.count("engine_newPayloadV4"), 3, "no block after the mismatch is tried")
        self.assertIn(f"recorded={recs[2]['hash']}", x.report())

    def test_a_header_that_does_not_hash_to_its_record_stops_before_reth_is_asked(self):
        recs = chain(4)
        recs[2]["hash"] = "0x" + "ab" * 32
        canton, client, _, reth = self.parts(recs)
        with self.assertRaises(rc.ReplayError) as e:
            rc.rebuild(canton, client)
        self.assertEqual(e.exception.number, 3)
        self.assertEqual(reth.calls.count("engine_newPayloadV4"), 2)

    def test_a_missing_block_stops_with_its_number(self):
        recs = chain(6)
        del recs[3]   # block 4
        canton, client, _, reth = self.parts(recs)
        with self.assertRaises(rc.ReplayError) as e:
            rc.rebuild(canton, client)
        self.assertEqual(e.exception.number, 4)
        self.assertIn("no record of block 4", e.exception.why)
        self.assertEqual(len(reth.blocks) - 1, 3)

    def test_canton_without_the_first_block_stops_at_one(self):
        canton, client, *_ = self.parts(chain(3)[1:])
        with self.assertRaises(rc.ReplayError) as e:
            rc.rebuild(canton, client)
        self.assertEqual(e.exception.number, 1)

    def test_reth_on_another_chain_stops(self):
        recs = chain(4)
        other = [GENESIS, keccak256(b"another block 1")]
        canton, client, *_ = self.parts(recs, FakeReth(other))
        with self.assertRaises(rc.ReplayError) as e:
            rc.rebuild(canton, client)
        self.assertEqual(e.exception.number, 1)

    def test_reth_ahead_of_canton_is_refused(self):
        recs = chain(5)
        canton, client, _, reth = self.parts(recs[:3])
        rc.rebuild(canton, client)
        canton2, client2, *_ = self.parts(recs[:2], reth)
        with self.assertRaises(rc.ReplayError) as e:
            rc.rebuild(canton2, client2)
        self.assertIn("ahead of Canton", e.exception.why)

    def test_an_empty_canton_and_a_genesis_reth_is_done(self):
        canton, client, *_ = self.parts([])
        r = rc.rebuild(canton, client)
        self.assertEqual((r["applied"], r["canton_head"], r["reth_head"]), (0, 0, 0))

    def test_a_header_of_another_form_is_a_report_not_a_crash(self):
        recs = chain(2)
        recs[1]["header"] = rlp([b"\x01", b"\x02"]); recs[1]["hash"] = "0x" + keccak256(recs[1]["header"]).hex()
        canton, client, *_ = self.parts(recs)
        with self.assertRaises(rc.ReplayError) as e:
            rc.rebuild(canton, client)
        self.assertEqual(e.exception.number, 2)


class Main(Case):
    def run_main(self, records, reth=None, env=None):
        import os, tempfile
        canton, _, fake_canton, fake_reth = self.parts(records, reth)
        state = tempfile.mkdtemp()
        Path(state, "jwt.hex").write_text(SECRET.hex())
        port = lambda url: url.rsplit(":", 1)[1]
        os.environ.update({"CZE_STATE_DIR": state, "CZE_LEDGER_URL": fake_canton.url, "CZE_READER_PARTY": PARTY,
                           "RETH_HTTP_PORT": port(fake_reth.http_url), "RETH_ENGINE_PORT": port(fake_reth.engine_url)})
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = rc.main(["rebuild"])
        return code, out.getvalue(), err.getvalue()

    def test_exit_0_and_key_value_lines(self):
        code, out, _ = self.run_main(chain(4))
        self.assertEqual(code, 0)
        self.assertIn("reth_head=4", out.split())
        self.assertIn("applied=4", out.split())

    def test_exit_1_and_a_fail_line_on_a_stop(self):
        code, out, err = self.run_main(chain(4), FakeReth(refuse={2}))
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        self.assertIn("FAIL block=2", err)


class DiscoveryOff(unittest.TestCase):
    def test_reth_is_only_started_by_launch_sh_with_discovery_off(self):
        launch = (ROOT / "network/reth/launch.sh").read_text()
        for flag in ("--disable-discovery", "--max-outbound-peers 0", "--max-inbound-peers 0", "--addr 127.0.0.1"):
            self.assertIn(flag, launch)
        source = (ROOT / "network/replay_from_canton.py").read_text()
        for starts_a_node in ("reth node", "docker run", "subprocess", "os.system", "Popen"):
            self.assertNotIn(starts_a_node, source)
        for peers in ("--bootnodes", "--trusted-peers", "--max-peers"):
            self.assertNotIn(peers, source)


if __name__ == "__main__":
    unittest.main()
