"""Tests for payout.py: the worker against a fake Ledger API and a fake token registry, for Canton Coin (registry, expiring holdings) and a token with no registry (the test token).
Run: python3 -m unittest discover -s apps/custody/tests"""
import contextlib, io, json, os, sys, tempfile, unittest
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))
import intake, payout
from test_intake import Server, cid, template
b = intake.b
RATE = "0.0002588"   # coin per round: the floor of 30 days of 144 rounds is 1.118016 CC

GATEWAY = "gateway::1220" + "11" * 32
OPERATOR = "operator::1220" + "22" * 32
CONFIRMER = "confirmer::1220" + "33" * 32
ISSUER = "issuer::1220" + "44" * 32
DSO = "dso::1220" + "55" * 32
ALICE = "alice::1220" + "66" * 32
CC, TKB = {"admin": DSO, "id": "Amulet"}, {"admin": ISSUER, "id": "TKB"}
FIELDS = {"chainId": "770101", "operator": OPERATOR, "confirmer": CONFIRMER, "gateway": GATEWAY}
UNIT = b.UNIT
TOKEN_CC, TOKEN_TKB = cid(0xa2), cid(0xa3)
PID = "ab" * 32
NOW = 1_800_000_000
HOURS = 24
TKB_FACTORY = cid(0xf1)
DISCLOSED = [{"templateId": "pkg:Test:Rules", "contractId": TKB_FACTORY, "createdEventBlob": "beef", "synchronizerId": "sync::1220"}]
PENDING_TAG, DONE, FAILED = payout.PENDING, payout.COMPLETED, "TransferInstructionResult_Failed"
WAITING, INTERNAL = intake.WAITING, "TransferPendingInternalWorkflow"


def rounds_doc(transfer="0"):
    """The scan proxy's open rounds: round 1000, a price of 1, holding fee RATE, 100 inputs, and `transfer` as the transfer fee."""
    one = lambda n: {"contract": {"payload": {"round": {"number": str(n)}, "amuletPrice": "1.0", "tickDuration": {"microseconds": "600000000"},
                     "transferConfigUsd": {"createFee": {"fee": "0"}, "holdingFee": {"rate": RATE}, "lockHolderFee": {"fee": "0"}, "transferFee": {"initialRate": transfer, "steps": []}, "maxNumInputs": "100"}}}}
    return {"open_mining_rounds": [one(n) for n in (998, 999, 1000)], "issuing_mining_rounds": []}


class Scan(Server):
    """A fake scan proxy that is the registry of Canton Coin too: the open rounds, the transfer factory (fac-1) and every choice context, empty."""

    def __init__(self):
        self.doc, self.status, self.asked = rounds_doc(), 200, []

        def handle(method, path, body, headers):
            self.asked.append((method, path, headers.get("Authorization")))
            if method == "GET":
                return (self.status, self.doc) if path == "/open-and-issuing-mining-rounds" else (404, {})
            empty = {"choiceContextData": {"values": {}}, "disclosedContracts": []}
            return self.status, ({"factoryId": "fac-1", "transferKind": "offer", "choiceContext": empty} if path.endswith("/transfer-factory") else empty)
        super().__init__(handle)

    def close(self):
        self.stop()


def view(cid_, owner=GATEWAY, instrument=TKB, units=10 * UNIT, lock=None):
    return {"contractId": cid_, "interfaceViews": [{"interfaceId": "holding", "viewStatus": {"code": 0}, "viewValue": {
        "owner": owner, "instrumentId": instrument, "amount": b.canton_amount(units), "lock": lock, "meta": {"values": {"created-in-round": "1000", "rate-per-round": RATE}}}}]}


class Net:
    """The ledger's state for these tests: what the fake Ledger API shows and what it was asked."""

    def __init__(self):
        self.payouts, self.registered, self.holdings, self.holdings_at = [], [], [], {}
        self.instructions, self.archived, self.updates = {}, {}, {}   # cid -> (transfer, status tag); cid -> {offset, choice, tag}; update id -> transaction
        self.mode, self.next_offset, self.completions = "pending", 200, []
        self.submitted, self.transfers, self.refuse, self.refuse_transfer = [], [], None, False
        self.kinds = {}

    def archive(self, instruction, choice, tag, successor=None):
        self.instructions.pop(instruction, None)
        self.next_offset += 1
        self.archived[instruction] = {"offset": self.next_offset, "choice": choice, "tag": tag, "value": {"transferInstructionCid": successor} if successor else {}}
        return self.next_offset

    def accept(self, instruction):
        return self.archive(instruction, "TransferInstruction_Accept", DONE)

    def handle(self, method, path, body, headers):
        if path == "/v2/state/ledger-end":
            return 200, {"offset": 5}
        if path == "/v2/state/active-contracts-page":
            flt = body["eventFormat"]["filtersByParty"][GATEWAY]["cumulative"][0]["identifierFilter"]
            if "InterfaceFilter" in flt:
                if flt["InterfaceFilter"]["value"]["interfaceId"] == intake.TRANSFER_INSTRUCTION:
                    events = [{"contractId": c, "interfaceViews": [{"interfaceId": intake.TRANSFER_INSTRUCTION, "viewStatus": {"code": 0}, "viewValue":
                                {"transfer": t, "status": {"tag": tag, "value": {}}}}]} for c, (t, tag) in self.instructions.items()]
                else:
                    events = self.holdings_at.get(body.get("activeAtOffset"), self.holdings)
            else:
                events = {payout.PAYOUT: self.payouts, intake.GATEWAY_TOKEN: self.registered}.get(flt["TemplateFilter"]["value"]["templateId"], [])
            return 200, {"activeContracts": [{"contractEntry": {"JsActiveContract": {"createdEvent": e}}} for e in events]}
        if path.startswith("/v2/commands/completions"):
            return 200, self.completions
        if path == "/v2/events/events-by-contract-id":
            done = self.archived.get(body["contractId"])
            return 200, {"archived": {"archivedEvent": {"offset": done["offset"]}}} if done else {"created": {"createdEvent": {}}}
        if path == "/v2/updates/update-by-offset":
            [(c, done)] = [(c, d) for c, d in self.archived.items() if d["offset"] == body["offset"]]
            event = {"ExercisedEvent": {"contractId": c, "choice": done["choice"], "consuming": True, "exerciseResult": {"output": {"tag": done["tag"], "value": done["value"]}}}}
            return 200, {"update": {"Transaction": {"value": {"updateId": f"update-{done['offset']}", "offset": done["offset"], "events": [event]}}}}
        if path == "/v2/updates/update-by-id":
            return 200, {"update": {"Transaction": {"value": self.updates[body["updateId"]]}}}
        if path == "/v2/commands/submit-and-wait-for-transaction":
            self.transfers.append(body)
            if self.refuse_transfer:   # the participant refuses the command: a failed completion, and an HTTP error to the caller
                self.completions.append({"completionResponse": {"Completion": {"value": {"commandId": body["commands"]["commandId"], "offset": 9, "status": {"code": 3, "message": "UNKNOWN_INFORMEES"}}}}})
                return 400, {"cause": "UNKNOWN_INFORMEES"}
            command = body["commands"]["commands"][0]["ExerciseCommand"]
            self.next_offset += 1
            update_id, instruction = f"update-{self.next_offset}", cid(0x60 + len(self.transfers))
            if self.mode == "pending":
                self.instructions[instruction] = (command["choiceArgument"]["transfer"], WAITING)
                output = {"tag": PENDING_TAG, "value": {"transferInstructionCid": instruction}}
            else:
                output = {"tag": DONE if self.mode == "completed" else FAILED, "value": {}}
            tx = {"updateId": update_id, "offset": self.next_offset, "events": [{"ExercisedEvent": {"contractId": command["contractId"], "choice": "TransferFactory_Transfer", "exerciseResult": {"output": output}}}]}
            self.updates[update_id] = tx
            self.completions.append({"completionResponse": {"Completion": {"value": {"commandId": body["commands"]["commandId"], "updateId": update_id, "offset": self.next_offset, "status": {}}}}})
            return 200, {"transaction": tx}
        if path == "/v2/commands/submit-and-wait":
            if self.refuse:
                return 400, {"cause": self.refuse}
            self.submitted.append(body)
            command = body["commands"][0]["ExerciseCommand"]
            if command["choice"] == "Payout_Paid":
                self.payouts = [p for p in self.payouts if p["contractId"] != command["contractId"]]
            elif command["choice"] == "TransferInstruction_Withdraw":
                self.archive(command["contractId"], "TransferInstruction_Withdraw", FAILED)
            return 200, {"updateId": f"update-{len(self.submitted)}", "completionOffset": 6}
        return 404, {}


class PayoutCase(unittest.TestCase):
    def setUp(self):
        b.REGISTRY_DOWN.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.work = Path(self.dir.name)
        self.bearer_file = self.work / "ledger.bearer"
        self.bearer_file.write_text("ledger-bearer\n")
        self.net, self.now = Net(), NOW
        self.ledger_server = Server(self.net.handle)
        self.scan = Scan()
        self.addCleanup(self.ledger_server.stop)
        self.addCleanup(self.scan.close)
        self.net.registered = [template(TOKEN_CC, instrumentId=CC, evmToken="cc", factory=cid(0xf0), **FIELDS), template(TOKEN_TKB, instrumentId=TKB, evmToken="tk", factory=TKB_FACTORY, **FIELDS)]
        self.net.holdings = [view(cid(1), units=3 * UNIT), view(cid(2), units=9 * UNIT), view(cid(3), units=5 * UNIT), view(cid(4), owner=ALICE, units=99 * UNIT)]
        self.settings = intake.Settings(GATEWAY, {DSO: self.scan.url})
        self.worker = self.make()

    def make(self, hours=HOURS, **kwargs):
        fields = {"ws_url": "", "engine_url": "", "jwt_secret": b"", "ledger_url": self.ledger_server.url, "ledger_user": "operator", "ledger_token": "", "party": GATEWAY,
                  "fee_recipient": "", "genesis": "", "work_dir": str(self.work), "make_input_cmd": "", "prove_cmd": "", "ledger_token_file": str(self.bearer_file)}
        cfg = b.Config(**fields)
        cfg.disclosed, cfg.registries = list(DISCLOSED), self.settings.registries
        cfg.expiring, cfg.custody_floor_days, cfg.max_transfer_inputs = (DSO,), 30, 50
        return payout.Payouts(b.Ledger(cfg), self.settings, str(self.work), hours, clock=lambda: self.now, **kwargs)

    def payout(self, which=TOKEN_TKB, amount="4.0", pid=PID, n=30):
        self.net.payouts.append(template(cid(n), gatewayToken=which, payoutId=pid, party=ALICE, amount=amount, **FIELDS))
        return cid(n)

    def poll(self):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            said = self.worker.poll()
        return said, [json.loads(line) for line in out.getvalue().splitlines()]

    def entry(self, pid=PID):
        return json.loads((self.work / payout.JOURNAL).read_text())[pid]

    def transfer(self, i=0):
        return self.net.transfers[i]["commands"]["commands"][0]["ExerciseCommand"]

    def sent_choices(self):
        return [s["commands"][0]["ExerciseCommand"]["choice"] for s in self.net.submitted]


class Offers(PayoutCase):
    def test_a_test_token_payout_is_one_offer_through_the_registered_factory_with_the_largest_inputs(self):
        self.payout()
        said, lines = self.poll()
        self.assertEqual(len(self.net.transfers), 1)
        body, command = self.net.transfers[0], self.transfer()
        self.assertEqual((command["contractId"], command["choice"], command["templateId"]), (TKB_FACTORY, "TransferFactory_Transfer", payout.TRANSFER_FACTORY))
        self.assertEqual(body["commands"]["disclosedContracts"], DISCLOSED)
        transfer = command["choiceArgument"]["transfer"]
        self.assertEqual((command["choiceArgument"]["expectedAdmin"], command["choiceArgument"]["extraArgs"]), (ISSUER, {"context": {"values": {}}, "meta": {"values": {}}}))
        self.assertEqual((transfer["sender"], transfer["receiver"], transfer["amount"], transfer["instrumentId"]), (GATEWAY, ALICE, "4.0", TKB))
        self.assertEqual(transfer["inputHoldingCids"], [cid(2)])   # the 9 alone covers it: largest first, and Alice's own holding is not the gateway's
        self.assertEqual(transfer["meta"], {"values": {payout.WITHDRAWAL_KEY: PID}})
        self.assertEqual((transfer["requestedAt"], transfer["executeBefore"]), (b.stamp(b.datetime.fromtimestamp(NOW - 60, b.timezone.utc)), b.stamp(b.datetime.fromtimestamp(NOW + HOURS * 3600, b.timezone.utc))))
        self.assertEqual(self.scan.asked, [])   # no registry for the test token
        self.assertEqual([line["offered"] for line in said], [PID])
        self.assertEqual(lines, said)
        self.assertEqual((self.entry()["state"], self.entry()["instruction"], self.entry()["n"]), ("offered", cid(0x61), 1))

    def test_an_offer_that_is_out_is_not_sent_again_and_says_nothing(self):
        self.payout()
        self.poll()
        self.now += 3600
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual((len(self.net.transfers), self.net.submitted), (1, []))

    def test_the_receiver_accepting_marks_the_payout_paid_and_nothing_else_is_sent(self):
        pay = self.payout()
        self.poll()
        offset = self.net.accept(cid(0x61))
        said, _ = self.poll()
        self.assertEqual([(line["paid"], line["transferUpdateId"]) for line in said], [(PID, f"update-{offset}")])
        command = self.net.submitted[0]["commands"][0]["ExerciseCommand"]
        self.assertEqual((command["contractId"], command["choice"], len(self.net.transfers)), (pay, "Payout_Paid", 1))
        self.assertEqual(self.net.submitted[0]["actAs"], [GATEWAY])
        self.poll()
        self.assertNotIn(PID, json.loads((self.work / payout.JOURNAL).read_text()))   # the payout is gone, and so is its record

    def test_a_pre_approved_receiver_is_paid_at_once(self):
        self.net.mode = "completed"
        self.payout()
        said, _ = self.poll()
        self.assertEqual([list(line)[0] for line in said], ["paid"])
        self.assertEqual(self.sent_choices(), ["Payout_Paid"])

    def test_a_reject_is_not_paid_and_is_offered_again_after_the_offer_time(self):
        self.payout()
        self.poll()
        self.net.archive(cid(0x61), "TransferInstruction_Reject", FAILED)
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual((self.entry()["state"], self.net.submitted), ("ended", []))
        self.now += HOURS * 3600 - 1
        self.assertEqual(self.poll(), ([], []))
        self.now += 1
        said, _ = self.poll()
        self.assertEqual([list(line)[0] for line in said], ["offered"])
        self.assertEqual((len(self.net.transfers), self.entry()["n"], self.entry()["instruction"]), (2, 2, cid(0x62)))
        self.assertNotEqual(self.transfer(0)["choiceArgument"]["transfer"]["executeBefore"], self.transfer(1)["choiceArgument"]["transfer"]["executeBefore"])

    def test_a_lapsed_offer_is_withdrawn_and_offered_again(self):
        self.payout()
        self.poll()
        self.now += HOURS * 3600
        said, _ = self.poll()
        self.assertEqual([(list(line)[0], line["instruction"]) for line in said], [("withdrawn", cid(0x61))])
        command = self.net.submitted[0]["commands"][0]["ExerciseCommand"]
        self.assertEqual((command["contractId"], command["choice"], command["templateId"]), (cid(0x61), "TransferInstruction_Withdraw", intake.TRANSFER_INSTRUCTION))
        self.assertEqual(self.net.submitted[0]["disclosedContracts"], DISCLOSED)
        said, _ = self.poll()
        self.assertEqual([list(line)[0] for line in said], ["offered"])
        self.assertEqual((len(self.net.transfers), self.entry()["n"]), (2, 2))

    def test_the_offer_time_is_a_setting(self):
        self.worker = self.make(hours=2)
        self.payout()
        self.poll()
        self.now += 2 * 3600
        self.assertEqual([list(line)[0] for line in self.poll()[0]], ["withdrawn"])

    def test_an_offer_in_the_issuers_own_workflow_is_followed_until_it_completes(self):
        self.payout()
        self.poll()
        transfer = self.net.instructions[cid(0x61)][0]
        self.net.instructions[cid(0x61)] = (transfer, INTERNAL)
        self.now += HOURS * 3600 * 2   # past its time: the issuer's own step is not withdrawn
        self.assertEqual(self.poll(), ([], []))
        self.net.archive(cid(0x61), "TransferInstruction_Update", PENDING_TAG)   # an issuer step: archived, and a new instruction carries the same meta
        self.net.instructions[cid(0x70)] = (transfer, INTERNAL)
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual(self.entry()["instruction"], cid(0x70))
        offset = self.net.archive(cid(0x70), "TransferInstruction_Update", DONE)
        said, _ = self.poll()
        self.assertEqual([(line["paid"], line["transferUpdateId"]) for line in said], [(PID, f"update-{offset}")])
        self.assertEqual((len(self.net.transfers), self.sent_choices()), (1, ["Payout_Paid"]))

    def test_a_step_that_hands_the_offer_on_is_followed_to_its_successor_and_never_offered_again(self):
        self.payout()
        self.poll()
        self.net.archive(cid(0x61), "TransferInstruction_Accept", PENDING_TAG, successor=cid(0x70))   # the successor is not visible to the gateway (no meta, or not yet)
        self.now += HOURS * 3600 * 2
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual((len(self.net.transfers), self.entry()["state"], self.entry()["instruction"]), (1, "offered", cid(0x70)))
        self.now += HOURS * 3600 * 2
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual(len(self.net.transfers), 1)
        offset = self.net.archive(cid(0x70), "TransferInstruction_Update", DONE)
        said, _ = self.poll()
        self.assertEqual([(line["paid"], line["transferUpdateId"]) for line in said], [(PID, f"update-{offset}")])
        self.assertEqual((len(self.net.transfers), self.sent_choices()), (1, ["Payout_Paid"]))

    def test_a_transfer_that_failed_is_offered_again_after_the_offer_time(self):
        self.net.mode = "failed"
        self.payout()
        said, _ = self.poll()
        self.assertEqual([(list(line)[0], line["why"]) for line in said], [("failed", f"the transfer's result is {FAILED}")])
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual(self.net.submitted, [])

    def test_two_payouts_are_each_offered_once(self):
        self.payout(pid="aa" * 32, n=30)
        self.payout(pid="bb" * 32, amount="1.0", n=31)
        self.poll()
        self.poll()
        self.assertEqual(sorted(t["commands"]["commands"][0]["ExerciseCommand"]["choiceArgument"]["transfer"]["meta"]["values"][payout.WITHDRAWAL_KEY] for t in self.net.transfers), ["aa" * 32, "bb" * 32])


class Recovery(PayoutCase):
    def test_a_send_whose_answer_was_lost_is_found_by_its_completion_and_not_sent_again(self):
        self.net.mode = "completed"
        self.payout()
        # the worker stopped after the participant committed the transfer, before it recorded the result
        self.poll_with_lost_answer()
        self.assertEqual(self.entry()["state"], "sending")
        self.worker = self.make()
        said, _ = self.poll()
        self.assertEqual([list(line)[0] for line in said], ["paid"])
        self.assertEqual((len(self.net.transfers), self.sent_choices()), (1, ["Payout_Paid"]))

    def poll_with_lost_answer(self):
        real = payout.it.call

        def lost(ledger, path, body):
            answer = real(ledger, path, body)
            if path == "/v2/commands/submit-and-wait-for-transaction":
                raise RuntimeError("the connection dropped")
            return answer
        with contextlib.redirect_stdout(io.StringIO()):
            with unittest.mock.patch.object(payout.it, "call", lost):
                self.worker.poll()

    def canton_time(self, seconds):
        """Canton's own time, as the completions stream shows it: an offset checkpoint with a record time."""
        stamp = datetime.fromtimestamp(seconds, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.net.completions.append({"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 9, "synchronizerTimes": [{"recordTime": stamp}]}}}})

    def test_a_send_that_never_committed_is_sent_again_once_canton_time_is_past_the_window(self):
        self.payout()
        self.poll_with_lost_answer()
        self.net.completions.clear()
        self.net.transfers.clear()
        self.net.instructions.clear()
        self.assertEqual(self.poll(), ([], []))   # no completion yet: it may still commit
        self.now += self.worker.ledger.cfg.resolve_seconds + 1
        self.canton_time(self.now)
        self.poll()
        self.assertEqual(self.entry()["state"], "ended")
        said, _ = self.poll()
        self.assertEqual([list(line)[0] for line in said], ["offered"])
        self.assertEqual(len(self.net.transfers), 1)

    def test_a_participant_that_lags_behind_this_clock_gets_no_second_send(self):
        self.payout()
        self.poll_with_lost_answer()
        self.net.completions.clear()
        self.net.transfers.clear()
        self.net.instructions.clear()
        self.canton_time(self.now + 10)   # Canton's time is before the end of the window
        self.now += 3 * self.worker.ledger.cfg.resolve_seconds   # this clock is far past it
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual((self.entry()["state"], len(self.net.transfers)), ("sending", 0))

    def test_a_canton_time_far_ahead_of_this_clock_is_a_skew_and_sends_nothing_again(self):
        self.payout()
        self.poll_with_lost_answer()
        self.net.completions.clear()
        self.net.transfers.clear()
        self.net.instructions.clear()
        self.canton_time(self.now + 10 * self.worker.ledger.cfg.resolve_seconds)
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual((self.entry()["state"], len(self.net.transfers)), ("sending", 0))

    def test_a_committed_completion_without_an_update_id_waits_and_sends_nothing_again(self):
        self.payout()
        self.poll_with_lost_answer()
        self.net.completions.clear()
        self.net.instructions.clear()
        self.net.completions.append({"completionResponse": {"Completion": {"value": {"commandId": self.entry()["command"], "offset": 9, "status": {}}}}})
        self.now += 3 * self.worker.ledger.cfg.resolve_seconds
        self.canton_time(self.now)
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual((self.entry()["state"], len(self.net.transfers)), ("sending", 1))

    def test_a_failed_completion_ends_the_send_and_it_is_offered_again(self):
        self.payout()
        self.poll_with_lost_answer()
        self.net.completions.clear()
        self.net.transfers.clear()
        self.net.instructions.clear()
        self.net.completions.append({"completionResponse": {"Completion": {"value": {"commandId": self.entry()["command"], "offset": 9, "status": {"code": 3, "message": "refused"}}}}})
        self.poll()
        self.assertEqual(self.entry()["state"], "ended")
        said, _ = self.poll()
        self.assertEqual([list(line)[0] for line in said], ["offered"])

    def test_a_transfer_that_completed_and_was_not_marked_is_marked_without_another_transfer(self):
        self.net.mode = "completed"
        self.payout()
        self.net.refuse = "no Payout_Paid"
        said, lines = self.poll()   # the transfer completed; the marking was refused
        self.assertEqual((said, [list(line)[0] for line in lines], self.entry()["state"]), ([], ["waiting"], "completed"))
        self.net.refuse = None
        self.worker = self.make()
        said, _ = self.poll()
        self.assertEqual(([list(line)[0] for line in said], len(self.net.transfers), self.sent_choices()), (["paid"], 1, ["Payout_Paid"]))

    def test_a_pending_offer_found_without_a_record_is_adopted_not_sent_again(self):
        self.payout()
        self.poll()
        (self.work / payout.JOURNAL).unlink()
        self.worker = self.make()
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual((len(self.net.transfers), self.entry()["state"], self.entry()["instruction"]), (1, "offered", cid(0x61)))

    def test_a_journal_that_cannot_be_read_stops_the_worker(self):
        (self.work / payout.JOURNAL).write_text("not json")
        with self.assertRaises(b.BuilderError):
            self.make()


class Waits(PayoutCase):
    def test_a_token_that_is_not_registered_waits_with_its_reason_once(self):
        self.payout(which=cid(0x99))
        _, lines = self.poll()
        self.assertEqual([(line["waiting"], line["why"]) for line in lines], [(PID, "the payout's token is not registered with the gateway")])
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual(self.net.transfers, [])

    def test_a_holding_that_does_not_cover_waits_and_sends_nothing(self):
        self.payout(amount="40.0")
        _, lines = self.poll()
        self.assertIn("do not cover the amount", lines[0]["why"])
        self.assertEqual(self.net.transfers, [])

    def test_a_send_the_participant_refuses_is_reported_and_looked_up_later(self):
        self.payout()
        real = payout.it.call

        def refuse(ledger, path, body):
            if path == "/v2/commands/submit-and-wait-for-transaction":
                raise RuntimeError("the participant refused it (HTTP 400): no")
            return real(ledger, path, body)
        with unittest.mock.patch.object(payout.it, "call", refuse):
            _, lines = self.poll()
        self.assertEqual((lines[0]["why"], self.entry()["state"]), ("the participant refused it (HTTP 400): no", "sending"))


class CantonCoin(PayoutCase):
    """The registry names the factory and gives the context; the inputs, the floor, the stop file and the custody check are the builder's."""

    def setUp(self):
        super().setUp()
        self.net.holdings = [view(cid(1), instrument=CC, units=20 * UNIT)]
        self.net.holdings_at = {}

    def custody(self, offset, units):
        self.net.holdings_at[offset - 1] = [view(cid(1), instrument=CC, units=20 * UNIT)]
        self.net.holdings_at[offset] = [view(cid(1), instrument=CC, units=units)]

    def test_the_factory_and_the_context_are_the_registrys_and_not_the_tokens(self):
        self.payout(TOKEN_CC)
        self.poll()
        command = self.transfer()
        self.assertEqual(command["contractId"], "fac-1")   # the registry's factoryId, not the token's own
        self.assertNotIn(cid(0xf0), json.dumps(self.net.transfers))
        self.assertEqual(command["choiceArgument"]["expectedAdmin"], DSO)
        self.assertEqual(command["choiceArgument"]["transfer"]["inputHoldingCids"], [cid(1)])
        self.assertIn(("POST", "/registry/transfer-instruction/v1/transfer-factory", None), self.scan.asked)
        self.assertIn(("GET", "/open-and-issuing-mining-rounds", None), self.scan.asked)

    def test_an_accepted_offer_passes_the_custody_check_and_is_paid(self):
        self.payout(TOKEN_CC)
        self.poll()
        self.custody(self.net.accept(cid(0x61)), 16 * UNIT)
        said, _ = self.poll()
        self.assertEqual([(list(line)[0], line["custodyCheck"]) for line in said], [("paid", "ok")])
        self.assertFalse((self.work / b.CUSTODY_STOP_FILE).exists())

    def test_the_worker_leaves_the_builders_pending_custody_check_alone(self):
        self.payout(TOKEN_CC)
        self.poll()
        record = self.work / "custody-check.json"
        record.write_text('{"commandId": "builder"}')
        self.custody(self.net.accept(cid(0x61)), 16 * UNIT)
        said, _ = self.poll()
        self.assertEqual([(list(line)[0], line["custodyCheck"]) for line in said], [("paid", "ok")])
        self.assertEqual(record.read_text(), '{"commandId": "builder"}')

    def test_a_custody_that_did_not_fall_by_the_amount_stops_canton_coin_payouts(self):
        self.payout(TOKEN_CC)
        self.poll()
        self.custody(self.net.accept(cid(0x61)), 17 * UNIT)   # 3 fell, not 4
        said, _ = self.poll()
        self.assertEqual([line["custodyCheck"] for line in said], ["stopped"])   # the receiver was paid: the payout is marked
        self.assertTrue((self.work / b.CUSTODY_STOP_FILE).exists())
        self.payout(TOKEN_CC, pid="cd" * 32, n=31)
        _, lines = self.poll()
        self.assertIn("withdrawals are stopped", lines[0]["why"])
        self.assertEqual(len(self.net.transfers), 1)

    def test_a_completed_transfer_is_checked_at_its_own_update(self):
        self.net.mode = "completed"
        self.payout(TOKEN_CC)
        self.custody(201, 16 * UNIT)   # the transfer's update is the first offset after 200
        said, _ = self.poll()
        self.assertEqual([line["custodyCheck"] for line in said], ["ok"])

    def test_the_floor_leaves_nothing_under_the_minimum(self):
        self.payout(TOKEN_CC, amount="19.5")   # 0.5 would stay, under 1.118016
        _, lines = self.poll()
        self.assertIn("would leave 0.5 CC", lines[0]["why"])
        self.assertEqual(self.net.transfers, [])
        self.payout(TOKEN_CC, amount="20.0", pid="cd" * 32, n=31)   # all of it is fine
        self.worker.told.clear()
        self.poll()
        self.assertEqual(len(self.net.transfers), 1)

    def test_a_fee_in_an_open_round_keeps_the_payout_waiting(self):
        self.scan.doc = rounds_doc(transfer="0.01")
        self.payout(TOKEN_CC)
        _, lines = self.poll()
        self.assertIn("charges a create, transfer or lock fee", lines[0]["why"])
        self.assertEqual(self.net.transfers, [])

    def test_a_lapsed_offer_asks_the_registry_for_the_withdraw_context(self):
        self.payout(TOKEN_CC)
        self.poll()
        self.now += HOURS * 3600
        self.poll()
        self.assertIn(("POST", f"/registry/transfer-instruction/v1/{cid(0x61)}/choice-contexts/withdraw", None), self.scan.asked)

    def test_a_registry_that_is_down_leaves_the_payout_waiting(self):
        self.scan.status = 500
        self.payout(TOKEN_CC)
        _, lines = self.poll()
        self.assertEqual((len(lines), self.net.transfers), (1, []))


class Switch(unittest.TestCase):
    def test_the_worker_is_off_by_default_and_payouts_need_a_work_folder(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=False), unittest.mock.patch.object(intake, "ledger_of") as made, contextlib.redirect_stderr(io.StringIO()) as err:
            for name in ("CZE_INTAKE", "CZE_PAYOUT_OFFERS"):
                os.environ.pop(name, None)
            self.assertEqual(intake.main(["--gateway-party", GATEWAY]), 0)
        made.assert_not_called()
        self.assertIn("off", err.getvalue())
        with unittest.mock.patch.dict(os.environ, {}, clear=False), self.assertRaises(SystemExit):
            intake.main(["--payout-offers", "--once", "--gateway-party", GATEWAY, "--ledger-user", "operator"])

    def test_the_offer_time_and_the_work_folder_come_from_the_environment(self):
        with unittest.mock.patch.dict(os.environ, {"CZE_PAYOUT_OFFERS": "1", "CZE_OFFER_HOURS": "3", "CZE_WORK_DIR": "/w"}):
            args = intake.parser().parse_args([])
        self.assertEqual((args.payout_offers, args.offer_hours, args.work_dir), (True, 3.0, "/w"))
        self.assertEqual(intake.parser().parse_args([]).offer_hours, 24.0)


    def test_the_settings_reach_the_builders_expiry_rules_and_a_bad_one_stops_the_start(self):
        import secrets
        with tempfile.TemporaryDirectory() as work:
            keyfile = Path(work) / "registry.bearer"
            keyfile.write_text(secrets.token_hex(16) + "\n")
            keyfile.chmod(0o600)
            base = ["--gateway-party", GATEWAY, "--ledger-user", "operator", "--payout-offers", "--work-dir", work, "--registry", f"{DSO}=http://127.0.0.1:1"]
            args = intake.parser().parse_args(base + ["--registry-token-file", f"{DSO}={keyfile}", "--expiring-instrument", DSO, "--custody-floor-days", "20", "--offer-hours", "6"])
            ledger = intake.ledger_of(args)
            worker = payout.Payouts.from_args(args, ledger, intake.settings_of(args))
            self.assertEqual((ledger.cfg.expiring, ledger.cfg.custody_floor_days, worker.lifetime.total_seconds(), worker.journal.path), ((DSO,), 20, 6 * 3600, Path(work) / payout.JOURNAL))
            for more in (["--expiring-instrument", DSO], ["--offer-hours", "0"]):   # an expiring instrument needs its registry's token; the offer time must be positive
                with self.subTest(more=more), self.assertRaises((SystemExit, b.BuilderError)):
                    bad = intake.parser().parse_args(base + more)
                    payout.Payouts.from_args(bad, intake.ledger_of(bad), intake.settings_of(bad))


class Limits(PayoutCase):
    def least(self, instrument=TKB, amount="5"):
        return {(instrument["admin"], instrument["id"]): intake.b.decimal(amount)}

    def test_a_payout_below_its_tokens_least_amount_gets_no_offer_and_no_ledger_call(self):
        self.worker = self.make(min_payout=self.least())
        self.payout(amount="4.9999999999")
        said, lines = self.poll()
        self.assertEqual((said, self.net.transfers, self.net.submitted), ([], [], []))
        self.assertEqual(lines, [{"waiting": PID, "why": "below the least payout"}])
        self.assertEqual((self.entry()["state"], self.entry()["why"], self.entry()["n"]), ("waiting", "below the least payout", 0))
        self.assertEqual(self.poll(), ([], []))   # said once
        self.assertEqual(self.net.transfers, [])

    def test_a_payout_at_or_above_the_least_amount_is_offered_as_before(self):
        self.worker = self.make(min_payout=self.least())
        self.payout(amount="5.0")
        self.payout(amount="7.5", pid="cd" * 32, n=31)
        said, _ = self.poll()
        self.assertEqual(sorted(line["offered"] for line in said), sorted([PID, "cd" * 32]))
        self.assertEqual(len(self.net.transfers), 2)
        self.assertIsNone(self.entry().get("why"))

    def test_the_least_amount_is_per_token(self):
        self.worker = self.make(min_payout=self.least(CC, "100"))
        self.payout(which=TOKEN_TKB, amount="2.0")   # the minimum is of the other token
        said, _ = self.poll()
        self.assertEqual([list(line)[0] for line in said], ["offered"])

    def test_a_held_back_payout_is_offered_once_the_least_amount_is_lowered(self):
        self.worker = self.make(min_payout=self.least())
        self.payout(amount="4.0")
        self.poll()
        self.worker = self.make(min_payout=self.least(amount="1"))
        said, _ = self.poll()
        self.assertEqual([list(line)[0] for line in said], ["offered"])
        self.assertEqual((self.entry()["state"], self.entry()["n"], self.entry()["why"]), ("offered", 1, None))

    def test_the_offers_are_capped_and_the_last_is_said_once(self):
        self.worker = self.make(max_offers=2)
        self.payout()
        self.poll()
        self.now += HOURS * 3600
        self.poll()   # the lapsed offer is withdrawn
        self.poll()   # and the second is made
        self.assertEqual((len(self.net.transfers), self.entry()["n"]), (2, 2))
        self.now += HOURS * 3600
        self.poll()   # withdrawn
        said, lines = self.poll()
        self.assertEqual((said, self.net.submitted[-1]["commands"][0]["ExerciseCommand"]["choice"]), ([], "TransferInstruction_Withdraw"))
        self.assertEqual(lines, [{"waiting": PID, "why": "offers used up", "offers": 2}])
        self.assertEqual((len(self.net.transfers), self.entry()["why"]), (2, "offers used up"))
        self.now += 10 * HOURS * 3600
        self.assertEqual(self.poll(), ([], []))
        self.assertEqual(len(self.net.transfers), 2)

    def test_a_rejected_offer_counts_and_is_not_offered_again_when_used_up(self):
        self.worker = self.make(max_offers=1)
        self.payout()
        self.poll()
        self.net.archive(cid(0x61), "TransferInstruction_Reject", FAILED)
        self.now += HOURS * 3600
        _, lines = self.poll()
        self.assertEqual(lines, [{"waiting": PID, "why": "offers used up", "offers": 1}])
        self.assertEqual(len(self.net.transfers), 1)

    def test_failed_submits_count_as_offers_and_the_retries_stop(self):
        self.worker = self.make(max_offers=3)
        self.net.refuse_transfer = True
        self.payout()
        for _ in range(12):
            self.poll()
            self.now += 1
        self.assertEqual((len(self.net.transfers), self.entry()["n"], self.entry()["why"]), (3, 3, "offers used up"))
        self.now += 10 * HOURS * 3600
        self.poll()
        self.assertEqual(len(self.net.transfers), 3)

    def test_the_defaults_change_nothing(self):
        self.assertEqual((self.worker.min_payout, self.worker.max_offers), ({}, 0))
        self.net.refuse_transfer = True
        self.payout(amount="0.0000000001")
        for _ in range(12):
            self.poll()
            self.now += 1
        self.assertGreater(len(self.net.transfers), 3)   # no cap: it is tried again and again

    def test_the_settings_are_read_from_the_arguments_and_said_at_the_start(self):
        with tempfile.TemporaryDirectory() as work:
            base = ["--gateway-party", GATEWAY, "--ledger-user", "operator", "--payout-offers", "--work-dir", work]
            args = intake.parser().parse_args(base + ["--min-payout", f"{ISSUER}/TKB=10", "--min-payout", f"{DSO}/Amulet=0.5", "--max-offers", "4"])
            worker = payout.Payouts.from_args(args, intake.ledger_of(args), intake.settings_of(args))
            self.assertEqual(worker.describe(), {"offerHours": 24.0, "minPayout": {f"{DSO}/Amulet": "0.5", f"{ISSUER}/TKB": "10"}, "maxOffers": 4})
            default = intake.parser().parse_args(base)
            self.assertEqual(payout.Payouts.from_args(default, intake.ledger_of(default), intake.settings_of(default)).describe(), {"offerHours": 24.0, "minPayout": {}, "maxOffers": 0})
            for more in (["--max-offers", "-1"], ["--min-payout", f"{ISSUER}/TKB"], ["--min-payout", f"{ISSUER}/TKB=1", "--min-payout", f"{ISSUER}/TKB=2"]):
                bad = intake.parser().parse_args(base + more)
                with self.subTest(more=more), self.assertRaises(SystemExit):
                    payout.Payouts.from_args(bad, intake.ledger_of(bad), intake.settings_of(bad))

    def test_the_cap_can_come_from_the_environment(self):
        with unittest.mock.patch.dict(os.environ, {"CZE_MAX_OFFERS": "5"}):
            self.assertEqual(intake.parser().parse_args([]).max_offers, 5)
        self.assertEqual(intake.parser().parse_args([]).max_offers, 0)


import unittest.mock

if __name__ == "__main__":
    unittest.main()
