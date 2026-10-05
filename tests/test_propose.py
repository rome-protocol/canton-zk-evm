"""network/canton/propose.py against a fake JSON Ledger API and a fake reth. Run: python3 -m unittest discover -s tests -p 'test_propose.py'"""
import json, sys, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "network" / "canton"))
import propose

PARTIES = {"OPERATOR_PARTY": "operator::1", "CONFIRMER_PARTY": "confirmer::2", "BUILDER_PARTY": "builder::1", "READER_PARTY": "reader::3",
           "GATEWAY_PARTY": "gateway::1"}
H = "ab" * 32
R = "99" * 32   # the genesis block's state root
GW = "a7e0" + "00" * 18   # the gateway contract's address, as the chain record writes it
TOKEN = "12" * 20          # a wrapped token's address
OTHER = "34" * 20


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


class FakeReth:
    """reth's JSON-RPC, for the one call propose.py makes: it records each request and answers eth_call with `result`
    (or with an error, when `error` is set)."""
    def __init__(self, result="0x" + "00" * 31 + "01", error=None):
        self.requests, self.result, self.error = [], result, error
        reth = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                reth.requests.append(body)
                answer = {"jsonrpc": "2.0", "id": body["id"]}
                answer.update({"error": {"code": -32000, "message": reth.error}} if reth.error else {"result": reth.result})
                data = json.dumps(answer).encode()
                self.send_response(200); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(data)

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()


def args(**kw):
    return SimpleNamespace(**{"chain_id": 770101, "gas_cap": 30000000, "genesis_hash": H, "genesis_state_root": R, "program_vk": "cd" * 32, "root_c": "ef" * 32,
                              "rules_hash": "12" * 32, "gateway_address": GW, **kw})


def token_args(**kw):
    return SimpleNamespace(**{"evm_token": TOKEN, "instrument_admin": "registry::5", "instrument_id": "TKB", "factory": "00f1", **kw})


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
        # The gateway is a signatory of the proposal: the operator's user acts for both.
        self.assertEqual((create["userId"], create["actAs"]), ("operator", ["operator::1", "gateway::1"]))
        c = create["commands"][0]["CreateCommand"]
        self.assertEqual(c["templateId"], "#canton-zk-evm:Zk.Chain:ChainProposal")
        # Every field the template has, as the JSON API writes them: numbers as strings.
        self.assertEqual(c["createArguments"], {
            "operator": "operator::1", "confirmer": "confirmer::2", "gateway": "gateway::1", "builder": "builder::1", "reader": "reader::3",
            "chainId": "770101", "genesisHash": H, "genesisStateRoot": R, "programVK": "cd" * 32, "rootC": "ef" * 32, "rulesHash": "12" * 32,
            "gasCap": "30000000", "gatewayAddress": GW})
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


class RegisterToken(unittest.TestCase):
    CHAIN = {"contractId": "z1", "args": {"chainId": "770101", "gatewayAddress": GW}}

    def setup_network(self, operator_contracts=None, reth=None, proposals=None):
        op = FakeLedger({"ZkChain": [self.CHAIN], **(operator_contracts or {})})
        co = FakeLedger({"GatewayTokenProposal": proposals if proposals is not None else [
            {"contractId": "tp0", "args": {"evmToken": OTHER}}, {"contractId": "tp1", "args": {"evmToken": TOKEN}}]})
        reth = reth or FakeReth()
        for closable in (op, co, reth):
            self.addCleanup(closable.close)
        accepted = {"contractId": "gt1", "args": {"evmToken": TOKEN, "instrumentId": {"admin": "registry::5", "id": "TKB"}}}
        co.on_submit = lambda body: op.contracts.__setitem__("GatewayToken", [accepted])   # AcceptToken creates the token
        return op, co, reth

    def test_the_operator_proposes_the_token_and_the_confirmer_accepts_it(self):
        op, co, reth = self.setup_network()
        result = propose.register_token(token_args(), PARTIES, op.url, co.url, reth.url)
        self.assertEqual(result, {"contractId": "gt1", "evmToken": TOKEN, "instrumentId": {"admin": "registry::5", "id": "TKB"}})
        (create,) = op.submitted
        self.assertEqual((create["userId"], create["actAs"]), ("operator", ["operator::1", "gateway::1"]))
        c = create["commands"][0]["CreateCommand"]
        self.assertEqual(c["templateId"], "#canton-zk-evm:Zk.Chain:GatewayTokenProposal")
        self.assertEqual(c["createArguments"], {
            "operator": "operator::1", "confirmer": "confirmer::2", "gateway": "gateway::1", "builder": "builder::1", "chainId": "770101",
            "evmToken": TOKEN, "instrumentId": {"admin": "registry::5", "id": "TKB"}, "factory": "00f1"})
        # Of the two proposals the confirmer can see, it accepts the one for this token.
        (accept,) = co.submitted
        self.assertEqual((accept["userId"], accept["actAs"]), ("confirmer", ["confirmer::2"]))
        e = accept["commands"][0]["ExerciseCommand"]
        self.assertEqual((e["templateId"], e["contractId"], e["choice"]), ("#canton-zk-evm:Zk.Chain:GatewayTokenProposal", "tp1", "AcceptToken"))

    def test_it_asks_reth_whether_the_gateway_made_the_token_at_the_finalized_block(self):
        op, co, reth = self.setup_network()
        propose.register_token(token_args(), PARTIES, op.url, co.url, reth.url)
        (request,) = reth.requests
        self.assertEqual(request["method"], "eth_call")
        call, block = request["params"]
        self.assertEqual(block, "finalized")
        self.assertEqual(call["to"], "0x" + GW)
        self.assertEqual(call["data"], "0x" + propose.WRAPPED_SELECTOR + "00" * 12 + TOKEN)

    def test_the_selector_is_that_of_wrapped_of_an_address(self):
        sys.path.insert(0, str(ROOT / "builder"))
        import keccak
        self.assertEqual(propose.WRAPPED_SELECTOR, keccak.keccak256(b"wrapped(address)").hex()[:8])

    def test_it_refuses_a_token_the_gateway_did_not_make(self):
        op, co, reth = self.setup_network(reth=FakeReth(result="0x" + "00" * 32))
        with self.assertRaises(SystemExit) as why:
            propose.register_token(token_args(), PARTIES, op.url, co.url, reth.url)
        self.assertIn("did not make", str(why.exception))
        self.assertEqual((op.submitted, co.submitted), ([], []))

    def test_it_refuses_when_reth_gives_no_answer(self):
        op, co, reth = self.setup_network(reth=FakeReth(error="header not found"))
        with self.assertRaises(SystemExit) as why:
            propose.register_token(token_args(), PARTIES, op.url, co.url, reth.url)
        self.assertIn("header not found", str(why.exception))
        self.assertEqual((op.submitted, co.submitted), ([], []))

    def test_it_refuses_when_reth_has_no_code_at_the_gateway_address(self):
        op, co, reth = self.setup_network(reth=FakeReth(result="0x"))
        with self.assertRaises(SystemExit) as why:
            propose.register_token(token_args(), PARTIES, op.url, co.url, reth.url)
        self.assertIn("gave no word", str(why.exception))
        self.assertEqual((op.submitted, co.submitted), ([], []))

    def test_it_refuses_when_there_is_no_chain_yet(self):
        op, co, reth = self.setup_network()
        op.contracts.clear()
        with self.assertRaises(SystemExit):
            propose.register_token(token_args(), PARTIES, op.url, co.url, reth.url)
        self.assertEqual((op.submitted, co.submitted, reth.requests), ([], [], []))

    def test_it_refuses_a_token_that_is_registered_or_proposed_already(self):
        for template in ("GatewayToken", "GatewayTokenProposal"):
            op, co, reth = self.setup_network({template: [{"contractId": "old", "args": {"evmToken": TOKEN}}]})
            with self.assertRaises(SystemExit):
                propose.register_token(token_args(), PARTIES, op.url, co.url, reth.url)
            self.assertEqual((op.submitted, co.submitted), ([], []))

    def test_another_token_being_registered_does_not_stop_this_one(self):
        op, co, reth = self.setup_network({"GatewayToken": [{"contractId": "old", "args": {"evmToken": OTHER}}]})
        self.assertEqual(propose.register_token(token_args(), PARTIES, op.url, co.url, reth.url)["contractId"], "gt1")


class Arguments(unittest.TestCase):
    PINS = {"CHAIN_ID": "770101", "GAS_CAP": "30000000", "GATEWAY_ADDRESS": "0x" + GW}
    CHAIN = ["--genesis-hash", H, "--genesis-state-root", R, "--program-vk", "cd" * 32, "--root-c", "ef" * 32, "--rules-hash", "12" * 32]

    def test_the_chain_is_the_default_and_its_gateway_address_comes_from_pins(self):
        mode, a = propose.parse(self.CHAIN, self.PINS)
        self.assertEqual((mode, a.gateway_address, a.chain_id, a.gas_cap), ("chain", GW, 770101, 30000000))

    def test_the_chain_takes_another_gateway_address_in_either_form(self):
        _, a = propose.parse(self.CHAIN + ["--gateway-address", "0x" + OTHER.upper()], self.PINS)
        self.assertEqual(a.gateway_address, OTHER)

    def test_a_gateway_address_that_is_not_an_address_is_refused(self):
        for bad in ("abc", "zz" * 20, "12" * 21):
            with self.assertRaises(SystemExit):
                propose.parse(self.CHAIN + ["--gateway-address", bad], self.PINS)

    def test_the_token_mode_takes_the_token_the_instrument_and_the_factory(self):
        mode, a = propose.parse(["token", "--evm-token", "0x" + TOKEN, "--instrument-admin", "registry::5", "--instrument-id", "TKB", "--factory", "00f1"], self.PINS)
        self.assertEqual(mode, "token")
        self.assertEqual((a.evm_token, a.instrument_admin, a.instrument_id, a.factory), (TOKEN, "registry::5", "TKB", "00f1"))
        self.assertEqual(a.reth_url, "http://127.0.0.1:8545")

    def test_the_token_address_is_written_in_lower_case_without_0x(self):
        _, a = propose.parse(["token", "--evm-token", "0x" + "AB" * 20, "--instrument-admin", "r", "--instrument-id", "T", "--factory", "00"], self.PINS)
        self.assertEqual(a.evm_token, "ab" * 20)

    def test_a_token_address_that_is_not_an_address_is_refused(self):
        for bad in ("abc", "zz" * 20):
            with self.assertRaises(SystemExit):
                propose.parse(["token", "--evm-token", bad, "--instrument-admin", "r", "--instrument-id", "T", "--factory", "00"], self.PINS)


if __name__ == "__main__":
    unittest.main()
