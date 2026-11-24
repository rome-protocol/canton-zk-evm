"""Tests for buy.py: the buy mode against a fake Ledger API, a fake token registry and a fake reth (local HTTP servers). Run: python3 -m unittest discover -s apps/custody/tests"""
import base64, contextlib, io, json, os, secrets, sys, tempfile, unittest
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import buy, evm, intake, memo
from keccak import keccak256
from test_intake import ALICE, CC, DSO, ISSUER, TKB, Server, cid, instruction, template

b = intake.b
VALIDATOR = "validator::1220" + "77" * 32
ADDRESS = "0x" + "12" * 20
KEY = bytes.fromhex("46" * 32)
KEY_ADDRESS = evm.address_of(KEY)
PRICE, LEAST = "20", "20"   # test values only: the worker has no number of its own
GAS_PRICE, TIP = 10**9, 10**8
CHAIN = 770101
WEI = 10**18


KINDS = ("accepted", "sent", "sentAgain", "settled", "dropped", "pending", "warning", "error", "buy")


def kinds(lines):
    """The kind of each line the worker said (the key that names it)."""
    return [next(k for k in KINDS if k in x) for x in lines]


class FakeReth:
    """reth as the buy worker uses it: the key's balance and count, a pool, and the blocks (mine / forget are the tests' to call)."""
    def __init__(self):
        self.balance, self.count, self.down, self.reverts = 1000 * WEI, 0, False, False
        self.gas_of = {}   # recipient (40 hex digits) -> the gas reth estimates for a transfer to it (21000 when not named); None: the transfer would fail
        self.pool, self.mined, self.sent = {}, {}, []

    def handle(self, method, path, body, headers):
        if self.down:
            return 500, {}
        m, p = body["method"], body["params"]
        result = {
            "eth_chainId": lambda: hex(CHAIN), "eth_getBalance": lambda: hex(self.balance), "eth_getTransactionCount": lambda: hex(self.count),
            "eth_gasPrice": lambda: hex(GAS_PRICE), "eth_maxPriorityFeePerGas": lambda: hex(TIP),
            "eth_getTransactionReceipt": lambda: {"blockNumber": "0x5", "status": "0x0" if self.reverts else "0x1"} if p[0] in self.mined else None,
            "eth_getTransactionByHash": lambda: {"hash": p[0]} if p[0] in self.pool or p[0] in self.mined else None,
        }
        if m == "eth_estimateGas":
            need = self.gas_of.get(p[0]["to"][2:], 21000)
            if need is None:
                return 200, {"jsonrpc": "2.0", "id": body["id"], "error": {"code": 3, "message": "execution reverted"}}
            return 200, {"jsonrpc": "2.0", "id": body["id"], "result": hex(need)}
        if m == "eth_sendRawTransaction":
            raw = bytes.fromhex(p[0][2:])
            self.sent.append(raw)
            h = "0x" + keccak256(raw).hex()
            if h in self.pool or h in self.mined:
                return 200, {"jsonrpc": "2.0", "id": body["id"], "error": {"code": -32000, "message": "already known"}}
            self.pool[h] = raw
            self.count += 1
            return 200, {"jsonrpc": "2.0", "id": body["id"], "result": h}
        return 200, {"jsonrpc": "2.0", "id": body["id"], "result": result[m]()}

    def mine(self):
        self.mined.update(self.pool)
        self.pool.clear()

    def forget(self):
        """reth restarts with an empty pool: the count falls back to what was mined."""
        self.pool.clear()
        self.count = len(self.mined)


class BuyCase(unittest.TestCase):
    def setUp(self):
        b.REGISTRY_DOWN.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.bearer_file = Path(self.dir.name) / "ledger.bearer"
        self.bearer_file.write_text(secrets.token_hex(16) + "\n")
        self.work = str(Path(self.dir.name) / "work")
        Path(self.work).mkdir()
        self.views, self.templates, self.submitted, self.asked, self.completions = [], {}, [], [], []
        self.refuse, self.lose_answer = None, False
        self.reth = FakeReth()
        servers = [Server(self.ledger_handler), Server(self.registry_handler), Server(self.reth.handle)]
        self.ledger_server, self.registry_server, self.reth_server = servers
        for server in servers:
            self.addCleanup(server.stop)
        self.settings = intake.Settings(VALIDATOR, {DSO: self.registry_server.url + "/scan-proxy"})
        self.worker = self.make_worker()

    def make_worker(self, price=PRICE, least=LEAST, max_meta=0, clock=None):
        fields = {"ws_url": "", "engine_url": "", "jwt_secret": b"", "ledger_url": self.ledger_server.url, "ledger_user": "validator-buy", "ledger_token": "", "party": VALIDATOR,
                  "fee_recipient": "", "genesis": "", "work_dir": self.work, "make_input_cmd": "", "prove_cmd": "", "ledger_token_file": str(self.bearer_file)}
        extra = {"clock": clock} if clock else {}
        return buy.Buy(b.Ledger(b.Config(**fields)), self.settings, evm.Reth(self.reth_server.url), KEY, Fraction(price), Fraction(least), self.work, max_meta, **extra)

    def ledger_handler(self, method, path, body, headers):
        if path == "/v2/state/ledger-end":
            return 200, {"offset": 5}
        if path == "/v2/state/active-contracts-page":
            flt = body["eventFormat"]["filtersByParty"][VALIDATOR]["cumulative"][0]["identifierFilter"]
            events = self.views if "InterfaceFilter" in flt else self.templates.get(flt["TemplateFilter"]["value"]["templateId"], [])
            return 200, {"activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": e}}} for e in events]}
        if path.startswith("/v2/commands/completions"):
            return 200, self.completions
        if path == "/v2/commands/submit-and-wait":
            self.submitted.append(body)
            if self.refuse:
                return 400, {"cause": self.refuse}
            self.views = [v for v in self.views if v["contractId"] != body["commands"][0]["ExerciseCommand"]["contractId"]]   # the accepted transfer is gone
            if self.lose_answer:
                return 500, {}
            return 200, {"updateId": f"update-{len(self.submitted)}", "completionOffset": 6}
        return 404, {}

    def registry_handler(self, method, path, body, headers):
        self.asked.append(path)
        return 200, {"choiceContextData": {"values": {"round": {"tag": "AV_ContractId", "value": cid(9)}}},
                     "disclosedContracts": [{"templateId": "#splice-amulet:Splice.Amulet:OpenMiningRound", "contractId": cid(9), "createdEventBlob": base64.b64encode(b"blob").decode(), "synchronizerId": "sync::1220"}]}

    def poll(self, worker=None):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            (worker or self.worker).poll()
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def buy_of(self, n, amount="100.0", meta=None, instrument=CC, sender=ALICE):
        view = instruction(n, instrument, amount, meta if meta is not None else {memo.REASON_KEY: ADDRESS}, receiver=VALIDATOR, sender=sender)
        self.views.append(view)
        return view

    def status(self):
        return json.loads((Path(self.work) / buy.STATUS).read_text())

    def journal(self):
        return json.loads((Path(self.work) / buy.JOURNAL).read_text())

    def expected_send(self, nonce, wei, gas=21000):
        return evm.transfer(KEY, CHAIN, nonce, "12" * 20, wei, 2 * GAS_PRICE, TIP, gas)

    def completion(self, command, ok=True, update="u-x"):
        value = {"commandId": command, "offset": 7, "status": {}} if ok else {"commandId": command, "offset": 7, "status": {"code": 14, "message": "UNAVAILABLE"}}
        return {"completionResponse": {"Completion": {"value": {**value, **({"updateId": update} if ok else {})}}}}


class LeftPending(BuyCase):
    """A transfer that fails a check is left pending: no accept, no reject, no send."""
    def left(self, view_args, why=None, **kwargs):
        self.buy_of(1, **view_args)
        if kwargs.get("worker"):
            self.worker = kwargs["worker"]
        lines = self.poll()
        self.assertEqual(self.submitted, [])
        self.assertEqual(self.reth.sent, [])
        self.assertEqual(self.journal() if (Path(self.work) / buy.JOURNAL).exists() else {}, {})
        pending = [x for x in lines if "pending" in x]
        self.assertEqual(len(pending), 1)
        if why:
            self.assertIn(why, pending[0]["why"])
        return pending

    def test_a_memo_that_is_not_one_address(self):
        for n, text in enumerate(["not an address", "0x" + "12" * 19, ADDRESS + " " + ADDRESS, "r1:0:0x" + "e3" * 20 + ":1:2", "0x" + "Ab" * 20], 1):
            self.views.clear()
            self.worker = self.make_worker()
            self.buy_of(n, meta={memo.REASON_KEY: text})
            lines = self.poll()
            self.assertEqual((self.submitted, self.reth.sent), ([], []), text)
            self.assertEqual(len([x for x in lines if "pending" in x]), 1, text)

    def test_no_memo_is_left_alone(self):
        self.left({"meta": {}}, "no memo")

    def test_an_amount_under_the_least_buy(self):
        self.left({"amount": "19.9999999999"}, "below the least buy")

    def test_an_amount_that_buys_no_tROME(self):
        self.worker = self.make_worker(price="1000000000000000000000000000", least="0")
        self.left({"amount": "0.0000000001"}, "buys no tROME")

    def test_a_meta_over_the_cap(self):
        values = {memo.REASON_KEY: ADDRESS, "k": "x" * 300}
        self.left({"meta": values}, "meta is larger", worker=self.make_worker(max_meta=len(memo.REASON_KEY) + len(ADDRESS) + 300))   # one byte under what it holds
        # the same transfer under a larger cap is taken
        self.views.clear()
        self.worker = self.make_worker(max_meta=len(memo.REASON_KEY) + len(ADDRESS) + 301)
        self.buy_of(2, meta=values)
        self.poll()
        self.assertEqual(len(self.submitted), 1)

    def test_no_cap_by_default(self):
        self.buy_of(1, meta={memo.REASON_KEY: ADDRESS, "k": "x" * 5000})
        self.poll()
        self.assertEqual(len(self.submitted), 1)

    def test_short_stock(self):
        self.reth.balance = 4 * WEI   # 100 CC at the test price buys 5 tROME
        self.left({"amount": "100.0"}, "too little tROME")

    def test_stock_that_covers_the_tROME_but_not_the_gas(self):
        self.reth.balance = 5 * WEI
        self.left({"amount": "100.0"}, "too little tROME")

    def test_another_instrument_or_an_admin_with_no_registry(self):
        self.left({"instrument": TKB}, "not Canton Coin")
        self.views.clear()
        self.worker = self.make_worker()
        self.buy_of(2, instrument={"admin": ISSUER, "id": "Amulet"})
        self.poll()
        self.assertEqual((self.submitted, self.reth.sent), ([], []))

    def test_a_transfer_to_someone_else_or_already_in_the_issuers_workflow_is_not_looked_at(self):
        self.views = [instruction(1, CC, "100.0", receiver="other::1220" + "88" * 32), instruction(2, CC, "100.0", {memo.REASON_KEY: ADDRESS}, receiver=VALIDATOR, status="TransferPendingInternalWorkflow")]
        self.poll()
        self.assertEqual((self.submitted, self.reth.sent, self.asked), ([], [], []))

    def test_a_pending_transfer_is_said_once_and_taken_when_it_passes(self):
        self.reth.balance = 4 * WEI
        self.buy_of(1)
        self.assertEqual(len([x for x in self.poll() if "pending" in x]), 1)
        self.assertEqual([x for x in self.poll() if "pending" in x], [])
        self.reth.balance = 1000 * WEI
        self.poll()
        self.assertEqual(len(self.submitted), 1)


class Takes(BuyCase):
    def test_accept_then_one_send_of_the_amount_over_the_price(self):
        self.buy_of(1, amount="100.0")
        lines = self.poll()
        self.assertEqual(len(self.submitted), 1)
        body = self.submitted[0]
        command = body["commands"][0]["ExerciseCommand"]
        self.assertEqual((body["userId"], body["actAs"], body["readAs"]), ("validator-buy", [VALIDATOR], [VALIDATOR]))
        self.assertEqual((command["templateId"], command["contractId"], command["choice"]), (intake.TRANSFER_INSTRUCTION, cid(1), "TransferInstruction_Accept"))
        self.assertEqual(command["choiceArgument"], {"extraArgs": {"context": {"values": {"round": {"tag": "AV_ContractId", "value": cid(9)}}}, "meta": {"values": {}}}})
        self.assertEqual([d["contractId"] for d in body["disclosedContracts"]], [cid(9)])
        self.assertEqual(self.asked, [f"/scan-proxy/registry/transfer-instruction/v1/{cid(1)}/choice-contexts/accept"])
        self.assertEqual(self.reth.sent, [self.expected_send(0, 5 * WEI)])
        self.assertEqual(kinds(lines), ["accepted", "sent"])
        self.assertEqual(lines[0]["wei"], str(5 * WEI))
        self.assertEqual(lines[1]["hash"], "0x" + keccak256(self.reth.sent[0]).hex())

    def test_the_send_is_from_the_buy_key_to_the_memo_address(self):
        self.buy_of(1, amount="25.0")
        self.poll()
        raw = self.reth.sent[0]
        self.assertEqual(raw[0], 2)
        self.assertEqual(raw, self.expected_send(0, 125 * WEI // 100))   # 25 CC at the test price

    def test_one_send_per_instruction_with_the_next_nonce_each(self):
        for n in (1, 2, 3):
            self.buy_of(n, amount="40.0")
        self.poll()
        self.assertEqual(len(self.submitted), 3)
        self.assertEqual(self.reth.sent, [self.expected_send(i, 2 * WEI) for i in range(3)])
        self.assertEqual(sorted(e["nonce"] for e in self.journal().values()), [0, 1, 2])

    def test_the_amount_over_the_price_is_rounded_down(self):
        self.worker = self.make_worker(price="3", least="1")
        self.buy_of(1, amount="10.0")
        self.poll()
        self.assertEqual(self.reth.sent, [self.expected_send(0, 3333333333333333333)])
        self.views.clear()
        self.worker = self.make_worker(price="3", least="0")
        self.buy_of(2, amount="0.0000000001")
        self.poll()
        self.assertEqual(self.journal()[cid(2)]["wei"], str(33333333))   # 1e-10 CC / 3, in wei

    def test_the_stock_is_counted_across_the_buys_of_one_poll(self):
        self.reth.balance = 9 * WEI   # two buys of 5 tROME do not fit; one does
        self.buy_of(1, amount="100.0")
        self.buy_of(2, amount="100.0")
        lines = self.poll()
        self.assertEqual(len(self.submitted), 1)
        self.assertEqual([x["why"] for x in lines if "pending" in x], ["the buy key holds too little tROME for this amount"])

    def test_the_stock_counts_what_is_sent_and_not_yet_mined(self):
        self.reth.balance = 8 * WEI
        self.buy_of(1, amount="100.0")
        self.poll()
        self.buy_of(2, amount="100.0")   # reth's balance has not fallen yet (the first send is not mined): the second does not fit
        self.poll()
        self.assertEqual(len(self.submitted), 1)
        self.reth.mine()
        self.reth.balance = 3 * WEI - 10**15   # the first send's cost is paid now
        self.poll()
        self.assertEqual(len(self.submitted), 1)
        self.reth.balance = 6 * WEI
        self.poll()
        self.assertEqual(len(self.submitted), 2)

    def test_a_send_that_reth_has_is_not_sent_again_and_is_settled_when_mined(self):
        self.buy_of(1)
        self.poll()
        lines = self.poll()
        self.assertEqual((len(self.reth.sent), lines), (1, []))
        self.reth.mine()
        lines = self.poll()
        self.assertEqual(kinds(lines), ["settled"])
        self.assertEqual((lines[0]["success"], len(self.reth.sent), self.journal()[cid(1)]["state"]), (True, 1, "done"))
        self.assertEqual(self.poll(), [])

    def test_a_send_that_reth_does_not_hold_is_sent_again_with_the_same_nonce_and_the_same_bytes(self):
        self.buy_of(1)
        self.poll()
        first = self.reth.sent[0]
        self.reth.forget()
        lines = self.poll()
        self.assertEqual(kinds(lines), ["sentAgain"])
        self.assertEqual(self.reth.sent, [first, first])
        self.reth.mine()
        self.poll()
        self.assertEqual((len(self.reth.sent), len(self.reth.mined)), (2, 1))   # it landed once

    def test_a_restart_sends_nothing_twice(self):
        self.buy_of(1)
        self.poll()
        self.reth.mine()
        self.poll()
        restarted = self.make_worker()
        lines = self.poll(restarted)
        self.assertEqual((lines, len(self.submitted), len(self.reth.sent)), ([], 1, 1))

    def test_a_restart_with_the_send_not_yet_mined_does_not_accept_or_sign_again(self):
        self.buy_of(1)
        self.poll()
        restarted = self.make_worker()
        lines = self.poll(restarted)
        self.assertEqual((lines, len(self.submitted), len(self.reth.sent)), ([], 1, 1))

    def test_nothing_is_accepted_while_reth_cannot_be_read(self):
        self.buy_of(1)
        self.reth.down = True
        with self.assertRaises(RuntimeError):
            self.poll()
        self.assertEqual((self.submitted, self.reth.sent), ([], []))   # a buy that could not be paid is not accepted
        self.reth.down = False
        self.poll()
        self.assertEqual((len(self.submitted), len(self.reth.sent)), (1, 1))

    def test_a_send_that_failed_after_the_accept_is_tried_again_from_the_journal(self):
        self.buy_of(1)
        original = evm.Reth.send
        calls = []

        def broken(reth, raw):
            calls.append(raw)
            if len(calls) == 1:
                raise RuntimeError("reth cannot be reached for eth_sendRawTransaction")
            return original(reth, raw)
        evm.Reth.send = broken
        self.addCleanup(setattr, evm.Reth, "send", original)
        lines = self.poll()
        self.assertEqual(len(self.submitted), 1)
        self.assertEqual([x for x in lines if "sent" in x], [])
        self.assertEqual(self.journal()[cid(1)]["state"], "sent")
        lines = self.poll()   # the journal holds the signed bytes; reth does not know the hash: sent again, the same bytes
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertEqual(kinds(lines), ["sentAgain"])

    def test_an_accepted_buy_that_was_never_signed_is_signed_and_sent_once(self):
        Path(self.work, buy.JOURNAL).write_text(json.dumps({cid(1): {"state": "accepted", "command": "c", "begin": 1, "at": 1, "to": "12" * 20, "amount": "100.0", "sender": ALICE, "wei": str(5 * WEI)}}))
        worker = self.make_worker()
        lines = self.poll(worker)
        self.assertEqual(kinds(lines), ["sent"])
        self.assertEqual(self.reth.sent, [self.expected_send(0, 5 * WEI)])
        self.assertEqual(self.poll(worker), [])

    def test_a_stop_between_the_accept_and_its_record_is_settled_by_the_commands_completion(self):
        entry = {"state": "accepting", "command": "buy-1", "begin": 3, "at": 1, "to": "12" * 20, "amount": "100.0", "sender": ALICE, "wei": str(5 * WEI)}
        Path(self.work, buy.JOURNAL).write_text(json.dumps({cid(1): entry}))
        self.completions = [{"completionResponse": {"Completion": {"value": {"commandId": "buy-1", "updateId": "u-9", "offset": 7, "status": {}}}}}]
        lines = self.poll(self.make_worker())   # the transfer is no longer pending: it was accepted
        self.assertEqual(kinds(lines), ["accepted", "sent"])
        self.assertEqual((len(self.submitted), self.reth.sent), (0, [self.expected_send(0, 5 * WEI)]))

    def test_a_transfer_that_is_gone_with_no_commit_is_dropped_and_nothing_is_sent(self):
        entry = {"state": "accepting", "command": "buy-1", "begin": 3, "at": 1, "to": "12" * 20, "amount": "100.0", "sender": ALICE, "wei": str(5 * WEI)}
        Path(self.work, buy.JOURNAL).write_text(json.dumps({cid(1): entry}))
        self.completions = [{"completionResponse": {"Completion": {"value": {"commandId": "buy-1", "offset": 7, "status": {"code": 3, "message": "CONTRACT_NOT_FOUND"}}}}}]
        lines = self.poll(self.make_worker())
        self.assertEqual(kinds(lines), ["dropped"])
        self.assertEqual((self.reth.sent, self.journal()), ([], {}))

    def test_an_accept_still_in_doubt_waits(self):
        entry = {"state": "accepting", "command": "buy-1", "begin": 3, "at": 1, "to": "12" * 20, "amount": "100.0", "sender": ALICE, "wei": str(5 * WEI)}
        Path(self.work, buy.JOURNAL).write_text(json.dumps({cid(1): entry}))
        self.assertEqual((self.poll(self.make_worker()), self.reth.sent), ([], []))   # no completion, and Canton's own time has not passed the window
        self.assertEqual(self.journal()[cid(1)]["state"], "accepting")

    def test_an_accept_that_is_refused_is_tried_again_only_when_that_try_has_failed_and_with_its_own_command(self):
        self.buy_of(1)
        self.refuse = "INVALID"
        lines = self.poll()
        self.assertEqual((self.reth.sent, [x["pending"] for x in lines if "pending" in x]), ([], [cid(1)]))
        self.refuse = None
        self.poll()   # no completion of the first try, and Canton's time has not passed its window: it may still commit, so nothing is submitted
        self.assertEqual(len(self.submitted), 1)
        self.completions = [self.completion(self.submitted[0]["commandId"], ok=False)]
        self.poll()
        self.assertEqual(len(self.submitted), 2)
        self.assertNotEqual(self.submitted[0]["commandId"], self.submitted[1]["commandId"])
        self.assertEqual(len(self.reth.sent), 1)

    def test_a_failed_try_then_a_committed_one_whose_answer_was_lost_ends_accepted_with_one_send(self):
        self.buy_of(1)
        self.refuse = "UNAVAILABLE"
        self.poll()
        first = self.submitted[0]["commandId"]
        self.refuse, self.lose_answer = None, True
        self.completions = [self.completion(first, ok=False)]
        self.poll()   # the second try commits and its answer is lost
        second = self.submitted[1]["commandId"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.reth.sent, [])
        self.assertEqual(self.journal()[cid(1)]["state"], "accepting")
        self.lose_answer = False
        self.completions = [self.completion(first, ok=False), self.completion(second, update="u-2")]
        lines = self.poll(self.make_worker())
        self.assertEqual(kinds(lines), ["accepted", "sent"])
        self.assertEqual((len(self.submitted), self.reth.sent), (2, [self.expected_send(0, 5 * WEI)]))
        self.assertEqual(self.journal()[cid(1)]["state"], "sent")

    def test_a_try_that_failed_and_a_transfer_that_is_gone_is_dropped(self):
        self.buy_of(1)
        self.refuse = "UNAVAILABLE"
        self.poll()
        self.refuse = None
        self.views.clear()   # the sender took it back
        self.completions = [self.completion(self.submitted[0]["commandId"], ok=False)]
        lines = self.poll()
        self.assertEqual((kinds(lines), self.reth.sent, self.journal()), (["dropped"], [], {}))

    def test_a_try_with_no_completion_is_failed_once_cantons_time_is_past_its_window(self):
        now = {"t": 1000.0}
        worker = self.make_worker(clock=lambda: now["t"])
        self.buy_of(1)
        self.refuse = "UNAVAILABLE"
        self.poll(worker)
        self.refuse = None
        stamp = lambda t: datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
        self.completions = [{"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 9, "synchronizerTimes": [{"recordTime": stamp(1200)}]}}}}]
        now["t"] = 1250.0
        self.poll(worker)   # Canton's time is inside the window: the try may still commit
        self.assertEqual(len(self.submitted), 1)
        self.completions = [{"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 9, "synchronizerTimes": [{"recordTime": stamp(1301)}]}}}}]
        now["t"] = 1400.0
        self.poll(worker)
        self.assertEqual(len(self.submitted), 2)

    def test_a_settled_buy_is_kept_for_a_while_then_forgotten(self):
        now = {"t": 1000.0}
        worker = self.make_worker(clock=lambda: now["t"])
        self.buy_of(1)
        self.poll(worker)
        self.reth.mine()
        self.poll(worker)
        self.assertIn(cid(1), self.journal())
        now["t"] += buy.KEEP_DONE_SECONDS + 1
        self.poll(worker)
        self.assertEqual(self.journal(), {})

    def test_a_reverted_send_is_said_as_not_successful(self):
        self.buy_of(1)
        self.poll()
        self.reth.mine()
        self.reth.reverts = True
        lines = self.poll()
        self.assertEqual([(x["success"], x["settled"]) for x in lines], [(False, cid(1))])


class StatusFile(BuyCase):
    def test_it_says_the_price_the_least_buy_the_party_and_open(self):
        self.poll()
        status = self.status()
        self.assertEqual({k: status[k] for k in ("version", "price", "minBuy", "party", "state")}, {"version": 1, "price": PRICE, "minBuy": LEAST, "party": VALIDATOR, "state": "open"})
        self.assertRegex(status["updatedAt"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(set(status), {"version", "updatedAt", "price", "minBuy", "party", "state"})

    def test_it_is_sold_out_when_the_stock_is_under_the_least_buy(self):
        self.reth.balance = WEI   # the least buy, 20 CC at the test price, is one tROME and the gas of its send
        self.poll()
        self.assertEqual(self.status()["state"], "sold out")
        self.reth.balance = 2 * WEI
        self.poll()
        self.assertEqual(self.status()["state"], "open")

    def test_what_the_buys_not_yet_mined_still_take_is_not_open_stock(self):
        self.reth.balance = 6 * WEI
        self.buy_of(1, amount="100.0")
        self.poll()   # 5 tROME are sent and not mined: under the least buy (one tROME and its gas) is left
        self.assertEqual(self.status()["state"], "sold out")
        self.reth.balance = 7 * WEI
        self.poll()
        self.assertEqual(self.status()["state"], "open")

    def test_decimals_are_plain_text(self):
        worker = self.make_worker(price="0.5", least="2.25")
        self.poll(worker)
        self.assertEqual((self.status()["price"], self.status()["minBuy"]), ("0.5", "2.25"))

    def test_nothing_is_written_while_reth_cannot_be_read(self):
        self.reth.down = True
        with self.assertRaises(RuntimeError):
            self.poll()
        self.assertFalse((Path(self.work) / buy.STATUS).exists())

    def test_the_file_is_replaced_whole_each_poll(self):
        self.poll()
        first = self.status()["updatedAt"]
        self.assertFalse((Path(self.work) / (buy.STATUS + ".tmp")).exists())
        now = {"t": 1_900_000_000.0}
        worker = self.make_worker(clock=lambda: now["t"])
        self.poll(worker)
        self.assertNotEqual(self.status()["updatedAt"], first)


class Start(BuyCase):
    def test_a_preapproval_on_the_validator_party_warns(self):
        self.templates[intake.PREAPPROVAL] = [template(cid(7), receiver=VALIDATOR, provider="p")]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            intake.preapproval_warning(self.worker.ledger, VALIDATOR, "validator party")
        line = json.loads(out.getvalue())
        self.assertIn("validator party holds a Canton Coin transfer preapproval", line["warning"])
        self.assertEqual(line["preapprovals"], [cid(7)])

    def test_no_preapproval_says_nothing_and_another_receivers_is_not_ours(self):
        self.templates[intake.PREAPPROVAL] = [template(cid(7), receiver="other::1220" + "99" * 32, provider="p")]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            intake.preapproval_warning(self.worker.ledger, VALIDATOR, "validator party")
        self.assertEqual(out.getvalue(), "")

    def test_the_intakes_own_warning_is_unchanged(self):
        self.templates[intake.PREAPPROVAL] = [template(cid(7), receiver=VALIDATOR, provider="p")]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            intake.preapproval_warning(self.worker.ledger, VALIDATOR)
        self.assertEqual(json.loads(out.getvalue()), {"warning": "the gateway holds a Canton Coin transfer preapproval: coins reach it with no offer, so the intake cannot refuse what cannot be claimed; archive it", "preapprovals": [cid(7)]})

    def run_main(self, extra=(), env=None):
        key = Path(self.dir.name) / "buy.key"
        key.write_text(KEY.hex() + "\n")
        key.chmod(0o600)
        argv = ["--buy", "--once", "--validator-party", VALIDATOR, "--ledger-url", self.ledger_server.url, "--ledger-user", "validator-buy", "--ledger-token-file", str(self.bearer_file),
                "--registry", f"{DSO}={self.registry_server.url}/scan-proxy", "--price", PRICE, "--min-buy", LEAST, "--buy-key-file", str(key), "--reth-rpc", self.reth_server.url, "--work-dir", self.work, *extra]
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            try:
                code = intake.main(argv)
            except SystemExit as e:
                code = str(e)
        return code, out.getvalue(), err.getvalue()

    def test_it_starts_says_its_settings_and_never_the_key(self):
        self.templates[intake.PREAPPROVAL] = [template(cid(7), receiver=VALIDATOR, provider="p")]
        self.buy_of(1)
        code, out, err = self.run_main()
        self.assertEqual(code, 0)
        lines = [json.loads(x) for x in out.splitlines()]
        self.assertEqual(lines[0]["warning"].split(" holds")[0], "the validator party")
        self.assertEqual(lines[1]["buy"], {"price": PRICE, "minBuy": LEAST, "party": VALIDATOR, "maxMetaBytes": 0, "sendFrom": "0x" + KEY_ADDRESS})
        self.assertEqual(kinds(lines[2:]), ["accepted", "sent"])
        for text in (out, err):
            self.assertNotIn(KEY.hex(), text)
            self.assertNotIn(self.reth_server.url, text)
        self.assertEqual(self.status()["state"], "open")

    def test_the_settings_it_needs(self):
        for flag, value in (("--price", ""), ("--min-buy", ""), ("--buy-key-file", ""), ("--reth-rpc", ""), ("--validator-party", ""), ("--work-dir", "")):
            code, out, _ = self.run_main([flag, value])
            self.assertIn(flag, str(code), flag)
            self.assertEqual(out, "")

    def test_a_price_that_is_not_more_than_zero_or_not_a_decimal(self):
        for value in ("0", "-1", "ten", "1e3", "2/3"):
            code, _, _ = self.run_main(["--price", value])
            self.assertIn("--price", str(code), value)
        code, _, _ = self.run_main(["--min-buy", "-1"])
        self.assertIn("--min-buy", str(code))
        self.assertEqual(self.run_main(["--min-buy", "0"])[0], 0)

    def test_it_runs_on_its_own(self):
        for flag in ("--intake", "--payout-offers"):
            self.assertIn("on its own", str(self.run_main([flag])[0]))

    def test_it_needs_the_registry_of_canton_coin(self):
        code, _, _ = self.run_main(["--registry", ""])
        self.assertTrue(isinstance(code, str))

    def test_a_key_file_that_others_can_read_is_refused(self):
        key = Path(self.dir.name) / "loose.key"
        key.write_text(KEY.hex())
        key.chmod(0o640)
        code, _, _ = self.run_main(["--buy-key-file", str(key)])
        self.assertIn("mode 0600", str(code))
        self.assertNotIn(KEY.hex(), str(code))

    def test_a_key_file_that_is_not_a_key_is_refused_without_its_content(self):
        key = Path(self.dir.name) / "bad.key"
        key.write_text("not a key " + "zz" * 20)
        key.chmod(0o600)
        code, out, err = self.run_main(["--buy-key-file", str(key)])
        self.assertIn("64 hex digits", str(code))
        self.assertNotIn("zzzz", str(code) + out + err)

    def test_the_key_may_carry_0x(self):
        key = Path(self.dir.name) / "x.key"
        key.write_text("0x" + KEY.hex())
        key.chmod(0o600)
        self.assertEqual(buy.read_key(str(key)), KEY)

    def test_the_cap_is_not_negative(self):
        self.assertIn("--max-meta-bytes", str(self.run_main(["--max-meta-bytes", "-1"])[0]))


class Disk(BuyCase):
    def break_writes(self, when):
        original = b.write_json_file

        def broken(path, value):
            if when(value):
                raise OSError(28, "No space left on device")
            return original(path, value)
        b.write_json_file = broken
        self.addCleanup(setattr, b, "write_json_file", original)
        return lambda: setattr(b, "write_json_file", original)

    def test_a_sent_record_that_cannot_be_written_sends_nothing_and_a_restart_sends_one_transfer(self):
        self.buy_of(1)
        heal = self.break_writes(lambda doc: any(isinstance(e, dict) and e.get("state") == "sent" for e in doc.values()))
        lines = self.poll()
        self.assertEqual((kinds(lines), self.reth.sent), (["accepted", "pending"], []))   # nothing is sent from a state the disk does not hold
        self.assertEqual((self.worker.journal.entries[cid(1)]["state"], self.journal()[cid(1)]["state"]), ("accepted", "accepted"))
        self.poll()   # the disk is still full: still nothing sent
        self.assertEqual(self.reth.sent, [])
        heal()
        restarted = self.make_worker()
        self.poll(restarted)
        self.reth.mine()
        self.poll(restarted)
        self.assertEqual((len(self.reth.sent), len(self.reth.mined), len(self.submitted)), (1, 1, 1))
        self.assertEqual(self.reth.sent, [self.expected_send(0, 5 * WEI)])

    def test_the_same_worker_signs_once_when_the_disk_is_back(self):
        self.buy_of(1)
        heal = self.break_writes(lambda doc: any(isinstance(e, dict) and e.get("state") == "sent" for e in doc.values()))
        self.poll()
        heal()
        self.poll()
        self.assertEqual(self.reth.sent, [self.expected_send(0, 5 * WEI)])

    def test_an_accepted_record_that_cannot_be_written_is_not_in_memory_either(self):
        self.buy_of(1)
        self.break_writes(lambda doc: any(isinstance(e, dict) and e.get("state") == "accepted" for e in doc.values()))
        self.poll()
        self.assertEqual(self.worker.journal.entries[cid(1)]["state"], "accepting")
        self.assertEqual(self.reth.sent, [])


class GasOfTheSend(BuyCase):
    def test_a_recipient_whose_code_runs_is_sent_with_the_estimate_and_room(self):
        self.reth.gas_of["12" * 20] = 50000
        self.buy_of(1, amount="100.0")
        self.poll()
        self.assertEqual(self.reth.sent, [self.expected_send(0, 5 * WEI, gas=60000)])
        self.assertEqual(self.journal()[cid(1)]["gas"], 60000)

    def test_a_plain_transfer_is_sent_with_exactly_21000(self):
        self.buy_of(1)
        self.poll()
        self.assertEqual(self.reth.sent, [self.expected_send(0, 5 * WEI, gas=21000)])

    def test_a_transfer_reth_says_would_fail_is_left_pending_before_the_accept(self):
        self.reth.gas_of["12" * 20] = None
        self.buy_of(1)
        lines = self.poll()
        self.assertEqual((self.submitted, self.reth.sent, [x["why"] for x in lines if "pending" in x]), ([], [], ["the transfer to this address would fail"]))

    def test_a_transfer_that_needs_more_gas_than_the_cap_is_left_pending(self):
        self.reth.gas_of["12" * 20] = buy.MAX_SEND_GAS
        self.buy_of(1)
        lines = self.poll()
        self.assertEqual((self.submitted, self.reth.sent), ([], []))
        self.assertIn("more gas", lines[0]["why"])

    def test_the_gas_of_the_estimate_is_part_of_the_stock_check(self):
        self.reth.gas_of["12" * 20] = 70000   # a limit of 84000 with room
        self.reth.balance = 5 * WEI + 84000 * 2 * GAS_PRICE - 1   # covers a plain transfer's gas, not the estimate's
        self.buy_of(1, amount="100.0")
        lines = self.poll()
        self.assertEqual((self.submitted, [x["why"] for x in lines if "pending" in x]), ([], ["the buy key holds too little tROME for this amount"]))

    def test_what_a_send_may_cost_is_owed_with_its_own_gas(self):
        self.reth.gas_of["12" * 20] = 50000
        self.buy_of(1, amount="100.0")
        self.poll()
        chain = self.worker.read_chain()
        self.assertEqual(self.worker.owed(chain, {}), 5 * WEI + 60000 * chain.max_fee)


class OneWorker(BuyCase):
    def test_a_second_worker_on_the_same_work_folder_refuses_to_start(self):
        lock = buy.take_lock(self.work)
        self.addCleanup(lock.close)
        with self.assertRaises(SystemExit) as refused:
            buy.take_lock(self.work)
        self.assertIn("another buy worker", str(refused.exception))

    def test_the_lock_is_let_go_with_the_worker(self):
        lock = buy.take_lock(self.work)
        lock.close()
        buy.take_lock(self.work).close()

    def test_the_command_line_worker_refuses_when_another_holds_the_folder(self):
        lock = buy.take_lock(self.work)
        self.addCleanup(lock.close)
        code, out, _ = Start.run_main(self)
        self.assertIn("another buy worker", str(code))
        self.assertEqual(out, "")

    def test_the_command_line_worker_lets_go_when_it_ends(self):
        self.assertEqual(Start.run_main(self)[0], 0)
        self.assertEqual(Start.run_main(self)[0], 0)


class OffByDefault(unittest.TestCase):
    def test_the_buy_mode_is_off_unless_asked(self):
        args = intake.parser().parse_args([])
        self.assertFalse(args.buy)
        self.assertEqual((args.price, args.min_buy, args.buy_key_file, args.reth_rpc, args.validator_party, args.max_meta_bytes), ("", "", "", "", "", 0))

    def test_with_nothing_on_the_worker_is_off_and_says_what_it_said_before(self):
        with contextlib.redirect_stderr(io.StringIO()) as err:
            code = intake.main([])
        self.assertEqual((code, err.getvalue()), (0, "the custody worker is off: pass --intake and/or --payout-offers (or CZE_INTAKE=1, CZE_PAYOUT_OFFERS=1) to switch it on\n"))

    def test_the_settings_come_from_the_environment_too(self):
        env = {"CZE_BUY": "1", "CZE_VALIDATOR_PARTY": VALIDATOR, "CZE_BUY_PRICE": "20", "CZE_BUY_MIN": "20", "CZE_BUY_KEY_FILE": "/k", "CZE_MAX_META_BYTES": "512", "CZE_RETH_RPC_URL": "http://127.0.0.1:1"}
        old = {k: os.environ.get(k) for k in env}
        os.environ.update(env)
        try:
            args = intake.parser().parse_args([])
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        self.assertEqual((args.buy, args.validator_party, args.price, args.min_buy, args.buy_key_file, args.max_meta_bytes, args.reth_rpc), (True, VALIDATOR, "20", "20", "/k", 512, "http://127.0.0.1:1"))


if __name__ == "__main__":
    unittest.main()
