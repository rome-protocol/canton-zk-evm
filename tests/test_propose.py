"""network/canton/propose.py against a fake JSON Ledger API. Run: python3 -m unittest discover -s tests -p 'test_propose.py'"""
import json, sys, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "network" / "canton"))
import propose

PARTIES = {"OPERATOR_PARTY": "operator::1", "CONFIRMER_PARTY": "confirmer::2", "BUILDER_PARTY": "builder::1", "READER_PARTY": "reader::3"}
H = "ab" * 32
R = "99" * 32   # the genesis block's state root


class FakeLedger:
    """One participant's JSON Ledger API: it records the submitted commands and answers the active-contract queries
    from a list that the test (or, for Accept, the confirmer's fake) fills."""
    def __init__(self, contracts=None, late=0):
        self.submitted, self.contracts, self.late, self.on_submit = [], contracts if contracts is not None else {}, late, None
        ledger = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, body):
                data = json.dumps(body).encode()
                self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(data)

            def do_GET(self):
                self._send({"offset": 7})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                if self.path == "/v2/commands/submit-and-wait":
                    ledger.submitted.append(body)
                    if ledger.on_submit:
                        ledger.on_submit(body)
                    return self._send({})
                template = body["eventFormat"]["filtersByParty"]
                (party, flt), = template.items()
                name = flt["cumulative"][0]["identifierFilter"]["TemplateFilter"]["value"]["templateId"].split(":")[-1]
                if ledger.late > 0 and name == "ChainProposal":
                    ledger.late -= 1
                    return self._send([])
                self._send([{"contractEntry": {"JsActiveContract": {"createdEvent": {"contractId": c["contractId"], "createArgument": c["args"]}}}}
                            for c in ledger.contracts.get(name, [])])

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()


def args(**kw):
    return SimpleNamespace(**{"chain_id": 770101, "gas_cap": 30000000, "genesis_hash": H, "genesis_state_root": R, "program_vk": "cd" * 32, "root_c": "ef" * 32, "rules_hash": "12" * 32, **kw})


class Propose(unittest.TestCase):
    def ledgers(self, operator_contracts=None, confirmer_late=0):
        op, co = FakeLedger(operator_contracts or {}), FakeLedger({"ChainProposal": [{"contractId": "p1", "args": {}}]}, late=confirmer_late)
        self.addCleanup(op.close); self.addCleanup(co.close)
        chain = {"contractId": "z1", "args": {"chainId": "770101", "headNumber": "0", "headHash": H}}
        co.on_submit = lambda body: op.contracts.__setitem__("ZkChain", [chain])   # Accept creates the chain
        return op, co

    def test_the_operator_proposes_and_the_confirmer_accepts(self):
        op, co = self.ledgers()
        result = propose.propose(args(), PARTIES, op.url, co.url)
        self.assertEqual(result, {"contractId": "z1", "chainId": "770101", "headNumber": "0", "headHash": H})
        (create,) = op.submitted
        self.assertEqual((create["userId"], create["actAs"]), ("operator", ["operator::1"]))
        c = create["commands"][0]["CreateCommand"]
        self.assertEqual(c["templateId"], "#canton-zk-evm:Zk.Chain:ChainProposal")
        # Every field the template has, as the JSON API writes them: numbers as strings.
        self.assertEqual(c["createArguments"], {
            "operator": "operator::1", "confirmer": "confirmer::2", "builder": "builder::1", "reader": "reader::3", "chainId": "770101",
            "genesisHash": H, "genesisStateRoot": R, "programVK": "cd" * 32, "rootC": "ef" * 32, "rulesHash": "12" * 32, "gasCap": "30000000"})
        (accept,) = co.submitted
        self.assertEqual((accept["userId"], accept["actAs"]), ("confirmer", ["confirmer::2"]))
        e = accept["commands"][0]["ExerciseCommand"]
        self.assertEqual((e["templateId"], e["contractId"], e["choice"]), ("#canton-zk-evm:Zk.Chain:ChainProposal", "p1", "Accept"))

    def test_it_waits_for_the_proposal_to_reach_the_confirmer(self):
        op, co = self.ledgers(confirmer_late=2)
        self.assertEqual(propose.propose(args(), PARTIES, op.url, co.url)["contractId"], "z1")

    def test_it_refuses_if_a_chain_already_exists(self):
        op, co = self.ledgers({"ZkChain": [{"contractId": "old", "args": {}}]})
        with self.assertRaises(SystemExit):
            propose.propose(args(), PARTIES, op.url, co.url)
        self.assertEqual((op.submitted, co.submitted), ([], []))

    def test_it_refuses_a_proposal_that_is_already_there(self):
        op, co = self.ledgers({"ChainProposal": [{"contractId": "old", "args": {}}]})
        with self.assertRaises(SystemExit):
            propose.propose(args(), PARTIES, op.url, co.url)
        self.assertEqual((op.submitted, co.submitted), ([], []))

    def test_the_env_file_is_read_key_by_key(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "parties.env"
            p.write_text("# a comment\nOPERATOR_PARTY=operator::1\n\nBUILDER_PARTY=builder::1\n")
            self.assertEqual(propose.read_env_file(p), {"OPERATOR_PARTY": "operator::1", "BUILDER_PARTY": "builder::1"})


if __name__ == "__main__":
    unittest.main()
