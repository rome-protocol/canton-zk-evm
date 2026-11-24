"""Tests for intake.py: the worker against a fake Ledger API and a fake token registry (local HTTP servers). Run: python3 -m unittest discover -s apps/custody/tests"""
import base64, contextlib, http.server, io, json, os, secrets, sys, tempfile, threading, unittest
from fractions import Fraction
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import claimable, intake, memo
b = intake.b

GATEWAY = "gateway::1220" + "11" * 32
OPERATOR = "operator::1220" + "22" * 32
CONFIRMER = "confirmer::1220" + "33" * 32
ISSUER = "issuer::1220" + "44" * 32
DSO = "dso::1220" + "55" * 32
ALICE = "alice::1220" + "66" * 32
CC, TKB = {"admin": DSO, "id": "Amulet"}, {"admin": ISSUER, "id": "TKB"}
ADDRESS = "0x" + "12" * 20
ROUTER = "0x" + "7a" * 20
ROUTE = "r1:0:0x" + "e3" * 20 + ":2000000000:17"
FIELDS = {"chainId": "770101", "operator": OPERATOR, "confirmer": CONFIRMER, "gateway": GATEWAY}
BOOK = "9a" * 20
INTAKE_CID, TOKEN_CC, TOKEN_TKB = "00" + "a1" * 34, "00" + "a2" * 34, "00" + "a3" * 34


def cid(n: int) -> str:
    return "00" + f"{n:02x}" * 34


def instruction(n, instrument=TKB, amount="10.0", meta=None, receiver=GATEWAY, status="TransferPendingReceiverAcceptance", sender=ALICE):
    view = {"transfer": {"sender": sender, "receiver": receiver, "amount": amount, "instrumentId": instrument, "meta": {"values": meta if meta is not None else {memo.REASON_KEY: ADDRESS}}},
            "status": {"tag": status, "value": {}}}
    return {"contractId": cid(n), "interfaceViews": [{"interfaceId": intake.TRANSFER_INSTRUCTION, "viewStatus": {"code": 0}, "viewValue": view}]}


def template(contract_id, **arguments):
    return {"contractId": contract_id, "createArgument": arguments}


class FakeOstia:
    """The router's book and the router, as `claimable.Ostia` reads them through `call`: the live numbers in base units (10 decimals: 0.05 is 5 * 10**8)."""
    def __init__(self):
        self.fee_out, self.claim, self.minimum, self.unit, self.room = 5 * 10**8, 15 * 10**8, 10**9, 10**9, 10**15
        self.open, self.down, self.calls = True, False, []

    def call(self, to, data):
        self.calls.append((to, data[:4], data[4:]))
        if self.down:
            raise RuntimeError("the router's book cannot be read on Ostia")
        word = lambda n: n.to_bytes(32, "big")
        if data[:4] == claimable.CHECK_OUT:
            if not self.open:
                raise claimable.Reverted()
            return b"".join(word(n) for n in (1, 0, self.fee_out, 0, 0, self.minimum, 2**256 - 1, self.unit, self.claim))
        assert data[:4] == claimable.LOCK_ROOM
        return word(self.room)


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, handle):
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.answer("GET")

            def do_POST(self):
                self.answer("POST")

            def answer(self, method):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or "null")
                code, out = handle(method, self.path, body, dict(self.headers))
                raw = json.dumps(out).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        super().__init__(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server_address[1]}"

    def stop(self):
        self.shutdown()
        self.server_close()


class IntakeCase(unittest.TestCase):
    def setUp(self):
        b.REGISTRY_DOWN.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.bearer = secrets.token_hex(16)
        self.bearer_file = Path(self.dir.name) / "ledger.bearer"
        self.bearer_file.write_text(self.bearer + "\n")
        self.views, self.templates, self.submitted, self.asked, self.seen_auth = [], {}, [], [], []
        self.refuse = None
        self.accept_answer = None
        self.reset_templates()
        self.ledger_server = Server(self.ledger_handler)
        self.registry_server = Server(self.registry_handler)
        for server in (self.ledger_server, self.registry_server):
            self.addCleanup(server.stop)
        self.book = FakeOstia()
        self.settings = intake.Settings(GATEWAY, {DSO: self.registry_server.url + "/scan-proxy"}, ostia=claimable.Ostia(self.book.call, BOOK, ROUTER[2:]))
        self.worker = self.make_worker()

    def reset_templates(self):
        self.templates = {intake.INTAKE: [template(INTAKE_CID, builder="b::1220", **FIELDS)],
                          intake.GATEWAY_TOKEN: [template(TOKEN_CC, instrumentId=CC, evmToken="c1" * 20, **FIELDS), template(TOKEN_TKB, instrumentId=TKB, evmToken="d1" * 20, **FIELDS)],
                          intake.RECEIPT: [], intake.DEPOSIT_REQUEST: []}

    def make_worker(self):
        fields = {"ws_url": "", "engine_url": "", "jwt_secret": b"", "ledger_url": self.ledger_server.url, "ledger_user": "operator", "ledger_token": "", "party": GATEWAY,
                  "fee_recipient": "", "genesis": "", "work_dir": "", "make_input_cmd": "", "prove_cmd": "", "ledger_token_file": str(self.bearer_file)}
        return intake.Intake(b.Ledger(b.Config(**fields)), self.settings)

    def ledger_handler(self, method, path, body, headers):
        self.seen_auth.append({k.lower(): v for k, v in headers.items()}.get("authorization"))
        if path == "/v2/state/ledger-end":
            return 200, {"offset": 5}
        if path == "/v2/state/active-contracts-page":
            flt = body["eventFormat"]["filtersByParty"][GATEWAY]["cumulative"][0]["identifierFilter"]
            if "InterfaceFilter" in flt:
                events = self.views
            else:
                events = self.templates.get(flt["TemplateFilter"]["value"]["templateId"], [])
            return 200, {"activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": e}}} for e in events]}
        if path == "/v2/commands/submit-and-wait":
            self.submitted.append(body)
            if self.refuse:
                return 400, {"cause": self.refuse}
            return 200, {"updateId": f"update-{len(self.submitted)}", "completionOffset": 6}
        return 404, {}

    def registry_handler(self, method, path, body, headers):
        self.asked.append(path)
        if self.accept_answer is not None:
            return self.accept_answer
        return 200, {"choiceContextData": {"values": {"round": {"tag": "AV_ContractId", "value": cid(9)}}},
                     "disclosedContracts": [{"templateId": "#splice-amulet:Splice.Amulet:OpenMiningRound", "contractId": cid(9), "createdEventBlob": base64.b64encode(b"blob").decode(), "synchronizerId": "sync::1220"}]}

    def poll(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            accepted = self.worker.poll()
        return accepted, [json.loads(line) for line in out.getvalue().splitlines()]

    def command(self, i=0):
        return self.submitted[i]["commands"][0]["ExerciseCommand"]


class Accepts(IntakeCase):
    def test_a_canton_coin_transfer_is_accepted_with_the_registrys_context(self):
        self.views = [instruction(1, CC, "12.5", {memo.REASON_KEY: ADDRESS})]
        accepted, lines = self.poll()
        self.assertEqual(len(self.submitted), 1)
        body, command = self.submitted[0], self.command()
        self.assertEqual((body["userId"], body["actAs"]), ("operator", [GATEWAY]))
        self.assertEqual((command["templateId"], command["contractId"], command["choice"]), (intake.INTAKE, INTAKE_CID, "Intake_Accept"))
        self.assertEqual(command["choiceArgument"], {"gatewayToken": TOKEN_CC, "instruction": cid(1), "label": cid(1), "recipient": "12" * 20,
                                                      "choiceContext": {"values": {"round": {"tag": "AV_ContractId", "value": cid(9)}}}})
        self.assertEqual([d["contractId"] for d in body["disclosedContracts"]], [cid(9)])
        self.assertEqual(self.asked, [f"/scan-proxy/registry/transfer-instruction/v1/{cid(1)}/choice-contexts/accept"])
        self.assertEqual([(a["accepted"], a["updateId"], a["recipient"]) for a in accepted], [(cid(1), "update-1", "12" * 20)])
        self.assertEqual(lines, accepted)

    def test_a_token_with_no_registry_gets_an_empty_context_and_its_memo_label(self):
        self.views = [instruction(2, TKB, "3.0", {memo.REASON_KEY: ADDRESS, memo.LABEL_KEY: "page-7"})]
        self.poll()
        self.assertEqual(self.asked, [])
        arguments = self.command()["choiceArgument"]
        self.assertEqual((arguments["label"], arguments["choiceContext"], arguments["gatewayToken"]), ("page-7", None, TOKEN_TKB))
        self.assertNotIn("disclosedContracts", self.submitted[0])

    def test_a_route_memo_makes_a_receipt_for_the_router(self):
        self.settings.router = ROUTER
        self.views = [instruction(3, TKB, "3.0", {memo.REASON_KEY: ROUTE})]
        self.poll()
        arguments = self.command()["choiceArgument"]
        self.assertEqual((arguments["label"], arguments["recipient"]), (ROUTE, "7a" * 20))

    def test_a_route_memo_is_accepted_with_the_router_as_settings_of_keeps_it(self):
        args = intake.parser().parse_args(["--gateway-party", GATEWAY, "--ledger-user", "operator", "--router", ROUTER, "--book", "0x" + BOOK, "--ostia-rpc", "http://127.0.0.1:1"])
        self.settings.router = intake.settings_of(args).router
        self.views = [instruction(3, TKB, "3.0", {memo.REASON_KEY: ROUTE})]
        accepted, _ = self.poll()
        self.assertEqual([x["accepted"] for x in accepted], [cid(3)])

    def test_the_minimum_is_per_token_and_an_amount_at_it_is_accepted(self):
        self.settings.minimums = {(ISSUER, "TKB"): Fraction(5)}
        self.views = [instruction(1, TKB, "5.0"), instruction(2, TKB, "4.9999999999"), instruction(3, CC, "0.0000000001")]
        accepted, lines = self.poll()
        self.assertEqual([a["accepted"] for a in accepted], [cid(1), cid(3)])
        self.assertEqual([(line["pending"], line["why"]) for line in lines if "pending" in line], [(cid(2), "the amount is below the token's minimum")])

    def test_the_ledger_user_is_read_with_its_token_file_and_the_token_is_never_printed(self):
        self.views = [instruction(1)]
        _, lines = self.poll()
        self.assertEqual(set(self.seen_auth), {"Bearer " + self.bearer})
        self.assertNotIn(self.bearer, json.dumps(lines))


class Rejects(IntakeCase):
    """A transfer that cannot be claimed as it stands is rejected, from the live book, so the coin goes back to its sender at once."""
    def setUp(self):
        super().setUp()
        self.settings.router = ROUTER

    def route(self, max_fee, nonce=17):
        return f"r1:0:0x{'e3' * 20}:{max_fee}:{nonce}"

    def rejected(self, view, why, registry=False):
        self.views = [view]
        accepted, lines = self.poll()
        self.assertEqual((accepted, len(self.submitted)), ([], 1))
        command = self.command()
        self.assertEqual((command["templateId"], command["contractId"], command["choice"]), (intake.TRANSFER_INSTRUCTION, view["contractId"], "TransferInstruction_Reject"))
        extra = command["choiceArgument"]["extraArgs"]
        self.assertEqual(extra["meta"], {"values": {intake.REJECT_KEY: why}})
        self.assertEqual(self.submitted[0]["actAs"], [GATEWAY])
        self.assertEqual([(line["rejected"], line["reason"]) for line in lines], [(view["contractId"], why)])
        self.assertEqual(self.asked, [f"/scan-proxy/registry/transfer-instruction/v1/{view['contractId']}/choice-contexts/reject"] if registry else [])
        return extra, lines

    def test_below_the_live_minimum_is_rejected_with_the_registrys_reject_context(self):
        extra, lines = self.rejected(instruction(1, CC, "0.2", {memo.REASON_KEY: self.route(2000000000)}), "the least amount for this route is now 0.3", registry=True)
        self.assertEqual(extra["context"], {"values": {"round": {"tag": "AV_ContractId", "value": cid(9)}}})
        self.assertEqual([d["contractId"] for d in self.submitted[0]["disclosedContracts"]], [cid(9)])
        self.assertEqual((lines[0]["sender"], lines[0]["amount"], lines[0]["updateId"]), (ALICE, "0.2", "update-1"))

    def test_a_token_with_no_registry_is_rejected_with_an_empty_context(self):
        extra, _ = self.rejected(instruction(1, TKB, "0.2", {memo.REASON_KEY: self.route(2000000000)}), "the least amount for this route is now 0.3")
        self.assertEqual(extra["context"], {"values": {}})
        self.assertNotIn("disclosedContracts", self.submitted[0])

    def test_the_minimum_is_read_live_each_time_and_the_boundary_is_exact(self):
        route = self.route(2000000000)
        self.views = [instruction(1, TKB, "0.2999999999", {memo.REASON_KEY: route}), instruction(2, TKB, "0.3", {memo.REASON_KEY: route.replace(":17", ":18")})]
        accepted, lines = self.poll()
        self.assertEqual([a["accepted"] for a in accepted], [cid(2)])
        self.assertEqual([line["rejected"] for line in lines if "rejected" in line], [cid(1)])
        self.book.minimum = 10**10   # the owner raises the minimum to 1: what was taken at 0.3 is below it now
        self.views = [instruction(3, TKB, "0.9", {memo.REASON_KEY: route.replace(":17", ":19")}), instruction(4, TKB, "1.2", {memo.REASON_KEY: route.replace(":17", ":20")})]
        accepted, lines = self.poll()
        self.assertEqual([a["accepted"] for a in accepted], [cid(4)])
        self.assertEqual([(line["rejected"], line["reason"]) for line in lines if "rejected" in line], [(cid(3), "the least amount for this route is now 1")])

    def test_fees_raised_above_the_memos_cap_are_rejected(self):
        self.book.fee_out = 10**9   # feeOut 0.1 and the claim fee 0.15: 0.25 against the memo's 0.2
        self.rejected(instruction(1, TKB, "5.0", {memo.REASON_KEY: self.route(2000000000)}), "the route's fee is now 0.25 and the memo allows 0.2")

    def test_the_cut_off_leftover_counts_in_the_fee_the_memo_allows(self):
        # 0.39 less the fee 0.2 is 0.19, cut to the unit 0.1: what is sent is 0.1 and the fee taken is 0.29
        self.rejected(instruction(1, TKB, "0.39", {memo.REASON_KEY: self.route(2000000000)}), "the fee for this amount is 0.29 and the memo allows 0.2")

    def test_a_route_that_is_not_open_or_has_no_room_is_rejected(self):
        self.book.open = False
        self.rejected(instruction(1, TKB, "5.0", {memo.REASON_KEY: self.route(2000000000)}), "the route is not open now")
        self.submitted.clear(), self.worker.told.clear()
        self.book.open, self.book.room = True, 4 * 10**9
        self.rejected(instruction(2, TKB, "5.0", {memo.REASON_KEY: self.route(2000000000, 18)}), "the route has no room for this amount now")

    def test_a_plain_deposit_that_leaves_nothing_is_rejected_and_any_other_is_taken(self):
        self.views = [instruction(1, TKB, "0.0"), instruction(2, TKB, "0.0000000001")]
        accepted, lines = self.poll()
        self.assertEqual([a["accepted"] for a in accepted], [cid(2)])
        self.assertEqual([(line["rejected"], line["reason"]) for line in lines if "rejected" in line], [(cid(1), "there is nothing to claim")])
        self.assertEqual(self.book.calls, [])   # a plain memo asks the book nothing

    def test_a_reject_that_the_participant_refuses_is_reported_once_and_tried_again(self):
        self.refuse = "no"
        self.views = [instruction(1, TKB, "0.2", {memo.REASON_KEY: self.route(2000000000)})]
        accepted, lines = self.poll()
        self.assertEqual((accepted, len(self.submitted), [list(line) for line in lines]), ([], 1, [["pending", "why"]]))
        self.assertEqual(self.poll()[1], [])
        self.assertEqual(len(self.submitted), 2)
        self.refuse = None
        self.assertEqual([line["rejected"] for line in self.poll()[1]], [cid(1)])

    def test_a_book_that_cannot_be_read_leaves_the_transfer_pending_and_a_later_read_decides(self):
        self.book.down = True
        self.views = [instruction(1, TKB, "5.0", {memo.REASON_KEY: self.route(2000000000)})]
        accepted, lines = self.poll()
        self.assertEqual((accepted, self.submitted, [(line["pending"], line["why"]) for line in lines]), ([], [], [(cid(1), "the router's book cannot be read on Ostia")]))
        self.book.down = False
        self.assertEqual([a["accepted"] for a in self.poll()[0]], [cid(1)])

    def test_the_book_and_the_router_are_asked_for_the_tokens_address_and_the_memos_network(self):
        self.views = [instruction(1, TKB, "5.0", {memo.REASON_KEY: self.route(2000000000)})]
        self.poll()
        padded = bytes.fromhex("d1" * 20).rjust(32, b"\0")
        self.assertEqual(self.book.calls, [("0x" + BOOK, claimable.CHECK_OUT, padded + (0).to_bytes(32, "big")), ("0x" + ROUTER[2:], claimable.LOCK_ROOM, padded)])

    def test_a_route_with_no_book_set_is_never_accepted(self):
        self.settings.ostia = None
        self.views = [instruction(1, TKB, "5.0", {memo.REASON_KEY: self.route(2000000000)})]
        accepted, lines = self.poll()
        self.assertEqual((accepted, self.submitted, lines[0]["why"]), ([], [], "the router's book is not set: a route's fee and minimum are unknown"))


class Preapproval(IntakeCase):
    def warnings(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            intake.preapproval_warning(self.worker.ledger, GATEWAY)
        return [json.loads(line) for line in out.getvalue().splitlines()]

    def test_no_preapproval_no_warning(self):
        self.templates[intake.PREAPPROVAL] = [template(cid(60), receiver=ALICE)]   # someone else's
        self.assertEqual(self.warnings(), [])

    def test_a_preapproval_of_the_gateway_is_warned_of(self):
        self.templates[intake.PREAPPROVAL] = [template(cid(60), receiver=GATEWAY)]
        got = self.warnings()
        self.assertEqual([w["preapprovals"] for w in got], [[cid(60)]])
        self.assertIn("preapproval", got[0]["warning"])

    def test_a_check_that_cannot_be_made_is_a_warning_and_never_stops_the_worker(self):
        self.ledger_server.stop()
        got = self.warnings()
        self.assertEqual(len(got), 1)
        self.assertIn("could not be checked", got[0]["warning"])


class LeavesPending(IntakeCase):
    def left(self, views, why, router=None):
        self.settings.router = router
        self.views = views
        accepted, lines = self.poll()
        self.assertEqual((accepted, self.submitted), ([], []))
        self.assertEqual([(line["pending"], line["why"]) for line in lines], [(v["contractId"], why) for v in views])

    def test_a_missing_or_unreadable_memo(self):
        self.left([instruction(1, meta={})], "the transfer has no memo")
        self.told_reset()
        self.left([instruction(2, meta={memo.REASON_KEY: "for alice"})], "the memo is not one EVM address (0x and 40 hex digits)")

    def told_reset(self):
        self.worker.told.clear()

    def test_a_route_without_a_router_or_a_bad_one(self):
        self.left([instruction(1, meta={memo.REASON_KEY: ROUTE})], "the memo is a route and no router is set")

    def test_an_instrument_that_is_not_registered(self):
        self.left([instruction(1, {"admin": ISSUER, "id": "OTHER"})], "the instrument is not a registered token")

    def test_a_transfer_in_the_issuers_own_workflow_or_to_someone_else_is_not_looked_at(self):
        self.views = [instruction(1, status="TransferPendingInternalWorkflow"), instruction(2, receiver=ALICE), {"contractId": cid(3), "interfaceViews": []}]
        accepted, lines = self.poll()
        self.assertEqual((accepted, lines, self.submitted, self.asked), ([], [], [], []))

    def test_a_deposit_id_that_is_open_or_made_twice_in_one_pass(self):
        label = {memo.REASON_KEY: ADDRESS, memo.LABEL_KEY: "same"}
        self.templates[intake.RECEIPT] = [template(cid(40), depositId=b.deposit_id_of(ALICE, "open-receipt"))]
        self.templates[intake.DEPOSIT_REQUEST] = [template(cid(41), depositId=b.deposit_id_of(ALICE, "open-request"))]
        self.views = [instruction(1, meta={**label, memo.LABEL_KEY: "open-receipt"}), instruction(2, meta={**label, memo.LABEL_KEY: "open-request"}),
                      instruction(3, meta=label), instruction(4, meta=label)]
        accepted, lines = self.poll()
        self.assertEqual([a["accepted"] for a in accepted], [cid(3)])
        self.assertEqual({line["pending"] for line in lines if "pending" in line}, {cid(1), cid(2), cid(4)})

    def test_a_registry_that_is_down_or_gives_nonsense(self):
        for answer in ((500, {}), (200, {"choiceContextData": "x"}), (200, [])):
            b.REGISTRY_DOWN.clear()
            self.accept_answer, self.worker.told = answer, set()
            self.views = [instruction(1, CC)]
            accepted, lines = self.poll()
            with self.subTest(answer=answer):
                self.assertEqual((accepted, self.submitted, len(lines)), ([], [], 1))

    def test_an_accept_that_the_participant_refuses_is_reported_once_and_tried_again(self):
        self.refuse = "the accept did not complete the transfer"
        self.views = [instruction(1, TKB)]
        self.assertEqual(self.poll()[0], [])
        _, lines = self.poll()
        self.assertEqual((len(self.submitted), lines), (2, []))   # tried again, not reported again
        self.refuse = None
        self.assertEqual([a["accepted"] for a in self.poll()[0]], [cid(1)])

    def test_one_failure_does_not_stop_the_others(self):
        self.views = [instruction(1, meta={}), instruction(2, TKB)]
        accepted, _ = self.poll()
        self.assertEqual([a["accepted"] for a in accepted], [cid(2)])

    def test_nothing_is_asked_when_no_transfer_waits(self):
        self.templates = {}
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual(self.asked, [])

    def test_a_chain_with_no_intake_fails_the_pass(self):
        self.templates[intake.INTAKE] = []
        self.views = [instruction(1)]
        with self.assertRaisesRegex(RuntimeError, "0 intakes"):
            self.poll()

    def test_a_token_of_another_chain_is_not_registered_for_this_intake(self):
        self.templates[intake.GATEWAY_TOKEN] = [template(TOKEN_TKB, instrumentId=TKB, evmToken="d1" * 20, **{**FIELDS, "chainId": "1"})]
        self.left([instruction(1)], "the instrument is not a registered token")


class Settings(unittest.TestCase):
    def test_minimums_split_on_the_first_slash_and_the_last_equals(self):
        got = intake.parse_minimums([f"{ISSUER}/TKB=5", f"{ISSUER}/a/b=c=0.5"])
        self.assertEqual(got, {(ISSUER, "TKB"): Fraction(5), (ISSUER, "a/b=c"): Fraction(1, 2)})

    def test_a_bad_minimum_stops_the_start(self):
        for item in (f"{ISSUER}/TKB", f"{ISSUER}/TKB=", f"{ISSUER}/TKB=x", f"{ISSUER}/TKB=-1", f"{ISSUER}=5", f"/TKB=5", "x/TKB=5", f"{ISSUER}/=5"):
            with self.subTest(item=item), self.assertRaises(SystemExit):
                intake.parse_minimums([item])
        with self.assertRaises(SystemExit):
            intake.parse_minimums([f"{ISSUER}/TKB=5", f"{ISSUER}/TKB=6"])

    def test_the_intake_is_off_unless_it_is_switched_on(self):
        with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(intake, "ledger_of") as made, contextlib.redirect_stderr(io.StringIO()) as err:
            os.environ.pop("CZE_INTAKE", None)
            self.assertEqual(intake.main(["--gateway-party", GATEWAY]), 0)
        made.assert_not_called()
        self.assertIn("off", err.getvalue())

    def test_a_start_with_no_gateway_party_or_user_is_refused(self):
        with mock.patch.dict(os.environ, {}, clear=False), self.assertRaises(SystemExit):
            intake.main(["--intake", "--once"])

    def test_the_router_must_be_an_address(self):
        args = intake.parser().parse_args(["--gateway-party", GATEWAY, "--ledger-user", "operator", "--router", "0x12"])
        with self.assertRaisesRegex(SystemExit, "--router must be an EVM address"):
            intake.settings_of(args)

    def test_a_router_given_on_the_command_line_reads_a_route_memo(self):
        args = intake.parser().parse_args(["--gateway-party", GATEWAY, "--ledger-user", "operator", "--router", ROUTER, "--book", "0x" + BOOK, "--ostia-rpc", "http://127.0.0.1:1"])
        settings = intake.settings_of(args)
        self.assertEqual(memo.read({memo.REASON_KEY: ROUTE}, cid(3), settings.router), (ROUTE, "7a" * 20))
        self.assertIsNotNone(settings.ostia)

    def test_a_router_needs_its_book_and_the_rpc_that_reads_it(self):
        base = ["--gateway-party", GATEWAY, "--ledger-user", "operator"]
        for more, words in ((["--router", ROUTER], "go together"), (["--book", "0x" + BOOK], "go together"), (["--router", ROUTER, "--book", "0x" + BOOK], "needs --ostia-rpc"),
                            (["--router", ROUTER, "--book", "0x12", "--ostia-rpc", "http://127.0.0.1:1"], "--book must be an EVM address")):
            with self.subTest(more=more), self.assertRaisesRegex(SystemExit, words):
                intake.settings_of(intake.parser().parse_args(base + more))

    def test_the_rpc_and_the_gateway_address_go_together_and_the_address_must_be_one(self):
        base = ["--gateway-party", GATEWAY, "--ledger-user", "operator"]
        for more, words in ((["--ostia-rpc", "http://127.0.0.1:1"], "go together"), (["--gateway-address", ADDRESS], "go together"),
                            (["--ostia-rpc", "http://127.0.0.1:1", "--gateway-address", "0x12"], "--gateway-address must be an EVM address")):
            with self.subTest(more=more), self.assertRaisesRegex(SystemExit, words):
                intake.settings_of(intake.parser().parse_args(base + more))
        got = intake.settings_of(intake.parser().parse_args(base + ["--ostia-rpc", "http://127.0.0.1:1", "--gateway-address", ADDRESS]))
        self.assertTrue(callable(got.used))


class Used(IntakeCase):
    def rpc(self, answer):
        self.asked = []

        def handle(method, path, body, headers):
            self.asked.append((body["method"], body["params"], headers.get("User-Agent")))
            return answer
        server = Server(handle)
        self.addCleanup(server.stop)
        return server

    def test_the_gateways_used_slot_is_read_and_a_set_slot_is_used(self):
        deposit_id = b.deposit_id_of(ALICE, "label")
        slot = "0x" + b.keccak256(bytes.fromhex(deposit_id) + (1).to_bytes(32, "big")).hex()
        for result, expected in (("0x" + "00" * 32, False), ("0x" + "00" * 31 + "01", True)):
            with self.subTest(result=result):
                server = self.rpc((200, {"jsonrpc": "2.0", "id": 1, "result": result}))
                self.assertIs(intake.gateway_used(server.url, "ab" * 20)(deposit_id), expected)
                self.assertEqual(self.asked, [("eth_getStorageAt", ["0x" + "ab" * 20, slot, "latest"], "Rome Protocol rome@romeprotocol.com")])

    def test_an_answer_that_cannot_be_read_is_an_error_that_does_not_name_the_url(self):
        for answer in ((500, {}), (200, {"error": "x"}), (200, {"result": "nonsense"})):
            server = self.rpc(answer)
            with self.subTest(answer=answer), self.assertRaises(RuntimeError) as caught:
                intake.gateway_used(server.url, "ab" * 20)("cd" * 32)
            self.assertNotIn(server.url, str(caught.exception))

    def test_a_route_send_whose_deposit_id_the_gateway_used_stays_pending_and_the_others_are_taken(self):
        used = b.deposit_id_of(ALICE, ROUTE)
        self.settings.router = ROUTER
        self.settings.used = lambda deposit_id: deposit_id == used
        self.views = [instruction(1, meta={memo.REASON_KEY: ROUTE}), instruction(2, meta={memo.REASON_KEY: ROUTE.replace(":17", ":18")})]
        accepted, lines = self.poll()
        self.assertEqual([a["accepted"] for a in accepted], [cid(2)])
        self.assertEqual([(line["pending"], line["why"]) for line in lines if "pending" in line], [(cid(1), "a deposit with this id was claimed already")])

    def test_a_used_read_that_fails_leaves_the_transfer_pending(self):

        def down(deposit_id):
            raise RuntimeError("the gateway's used(id) cannot be read on Ostia")
        self.settings.used = down
        self.views = [instruction(1)]
        accepted, lines = self.poll()
        self.assertEqual((accepted, self.submitted, lines[0]["why"]), ([], [], "the gateway's used(id) cannot be read on Ostia"))


if __name__ == "__main__":
    unittest.main()
