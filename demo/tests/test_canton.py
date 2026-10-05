"""Tests for demo/canton.py's `settled` with a fake Ledger API (the three calls it makes). Run: python3 -m unittest discover -s demo/tests"""
import http.server, json, os, sys, tempfile, threading, unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import canton

PARTIES = {"OPERATOR": "op::1", "CONFIRMER": "co::1", "BUILDER": "bu::1", "READER": "re::1", "U": "u::1", "V": "v::1", "REGISTRY": "rg::1"}


class FakeLedger(http.server.BaseHTTPRequestHandler):
    contracts: dict = {}     # (party, template) -> created events
    updates: dict = {}       # offset -> (update id, contract ids created)
    asked: list = []

    def log_message(self, *args):
        pass

    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        self.reply({"offset": 99})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.path == "/v2/state/active-contracts":
            [(party, flt)] = body["eventFormat"]["filtersByParty"].items()
            template = flt["cumulative"][0]["identifierFilter"]["TemplateFilter"]["value"]["templateId"]
            events = FakeLedger.contracts.get((party, template), [])
            self.reply([{"contractEntry": {"JsActiveContract": {"createdEvent": e, "synchronizerId": "sync::1"}}} for e in events])
        elif self.path == "/v2/updates/update-by-offset":
            FakeLedger.asked.append(body)
            found = FakeLedger.updates.get(body["offset"])
            if found is None:
                self.send_response(404); self.send_header("content-length", "0"); self.end_headers(); return
            self.reply({"update": {"Transaction": {"value": {"updateId": found[0], "offset": body["offset"],
                                                              "events": [{"CreatedEvent": {"contractId": c}} for c in found[1]]}}}})
        else:
            self.send_response(404); self.send_header("content-length", "0"); self.end_headers()


def record(number, offset, cid):
    return {"contractId": cid, "offset": offset, "createArgument": {"number": str(number)}}


class SettledTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        state = Path(self.tmp.name)
        (state / "canton").mkdir()
        (state / "canton" / "parties.env").write_text("".join(f"{k}_PARTY={v}\n" for k, v in PARTIES.items()))
        os.environ["CZE_STATE_DIR"] = str(state)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeLedger)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        os.environ["CZE_USERS_LEDGER_URL"] = f"http://127.0.0.1:{self.server.server_address[1]}"
        FakeLedger.contracts = {("re::1", canton.CHAIN + "BlockRecord"): [record(7, 40, "rec7"), record(8, 50, "rec8")],
                                ("v::1", canton.TOKEN): [record(0, 30, "hold-old"), record(0, 50, "hold-new")]}
        FakeLedger.updates = {40: ("upd-7", ["rec7"]), 50: ("upd-8", ["rec8", "hold-new"]), 30: ("upd-old", ["hold-old"])}
        FakeLedger.asked = []

    def test_the_block_and_the_holding_come_from_one_update(self):
        got = canton.settled(canton.Network(), 8)
        self.assertEqual(got["record"], {"updateId": "upd-8", "offset": 50, "contract": "rec8"})
        self.assertEqual(got["holding"], {"updateId": "upd-8", "offset": 50, "contract": "hold-new"})
        parties = [list(a["updateFormat"]["includeTransactions"]["eventFormat"]["filtersByParty"])[0] for a in FakeLedger.asked]
        self.assertEqual(sorted(parties), ["re::1", "v::1"])

    def test_a_holding_made_elsewhere_gives_another_update(self):
        FakeLedger.contracts[("v::1", canton.TOKEN)] = [record(0, 30, "hold-old")]
        got = canton.settled(canton.Network(), 8)
        self.assertNotEqual(got["record"]["updateId"], got["holding"]["updateId"])

    def test_an_update_that_did_not_create_the_contract_is_refused(self):
        FakeLedger.updates[50] = ("upd-8", ["rec8"])
        with self.assertRaises(canton.Fail):
            canton.settled(canton.Network(), 8)

    def test_no_record_for_the_block_is_refused(self):
        with self.assertRaises(canton.Fail):
            canton.settled(canton.Network(), 9)

    def test_an_event_without_an_offset_is_refused(self):
        del FakeLedger.contracts[("re::1", canton.CHAIN + "BlockRecord")][1]["offset"]
        with self.assertRaises(canton.Fail):
            canton.settled(canton.Network(), 8)


if __name__ == "__main__":
    unittest.main()
