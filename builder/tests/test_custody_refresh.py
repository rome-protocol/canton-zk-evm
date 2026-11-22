"""The operator's refresh step for an instrument whose holdings run out (network/external/setup.py --custody-refresh-step dry-run|run): it merges the gateway's
usable holdings into new ones, K inputs to a transfer and one pass over the holdings there at its start, checks each transfer at the ledger point before it and
at it, and writes the builder's stop file on a difference. Against a fake participant (a stateful JSON Ledger API with a history of offsets) and a fake
registry. Run: python3 -m unittest discover -s builder/tests"""
import base64, contextlib, http.server, io, json, os, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(ROOT / "network" / "canton"))
sys.path.insert(0, str(ROOT / "network" / "external"))
import builder as b
import setup

ADMIN = "dso::1220" + "ab" * 32
INSTR = {"admin": ADMIN, "id": "Amulet"}
GW, OP, CF = "gateway::1220" + "cd" * 32, "operator::1220" + "01" * 32, "confirmer::1220" + "02" * 32
FACTORY = "factory-1"
TOKEN, SCAN_TOKEN = "operator-token", "scan-token"
RATE, NOW, CC = "0.0002588", 10000, b.UNIT
FLOOR = b.base_units("1.118016")   # 30 days of 144 rounds at RATE
CONTRACT = "00" + "ab" * 32 + "5e01"
DISCLOSED = {"templateId": "#splice-amulet:Splice.AmuletRules:AmuletRules", "contractId": CONTRACT, "createdEventBlob": base64.b64encode(b"blob").decode(), "synchronizerId": "sync::1"}
CONTEXT = {"choiceContextData": {"values": {"amulet-rules": {"tag": "AV_ContractId", "value": CONTRACT}}}, "disclosedContracts": [DISCLOSED]}


def rounds_doc(rate=RATE, inputs="100", transfer_fee="0"):
    payload = {"round": {"number": str(NOW)}, "amuletPrice": "1.0", "tickDuration": {"microseconds": "600000000"},
               "transferConfigUsd": {"createFee": {"fee": "0"}, "holdingFee": {"rate": rate}, "lockHolderFee": {"fee": "0"},
                                     "transferFee": {"initialRate": transfer_fee, "steps": []}, "maxNumInputs": inputs}}
    return {"open_mining_rounds": [{"contract": {"payload": payload}}], "issuing_mining_rounds": []}


def hold(cid, amount, created=NOW, owner=GW, lock=None, instrument=INSTR):
    """(contract id, Holding view) of `amount` coin made in round `created`."""
    meta = {"values": {"created-in-round": str(created), "rate-per-round": RATE}}
    return cid, {"owner": owner, "instrumentId": instrument, "amount": amount, "lock": lock, "meta": meta}


def custody(held, owner=GW, instrument=INSTR):
    return sum(b.base_units(v["amount"]) for _, v in held if v["owner"] == owner and v["instrumentId"] == instrument)


class Registry:
    """A fake validator scan proxy: the open rounds, and the standard's transfer-factory request (recorded, with its token)."""

    def __init__(self, doc=None, status=200):
        self.doc, self.status, self.asked = rounds_doc() if doc is None else doc, status, []
        reg = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

            def do_GET(self):
                reg.asked.append(("GET", self.path, self.headers.get("authorization"), None))
                self.send(reg.status, reg.doc) if self.path == "/open-and-issuing-mining-rounds" else self.send(404, {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                reg.asked.append(("POST", self.path, self.headers.get("authorization"), body))
                self.send(200, {"factoryId": FACTORY, "transferKind": "direct", "choiceContext": CONTEXT})
        self.server = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()

    def posts(self):
        return [a for a in self.asked if a[0] == "POST"]


class Participant:
    """A fake participant. `states` is the gateway's holdings at each offset; a transfer consumes its inputs and makes one holding of their sum (plus
    `skew[n]` base units for the n-th submit, a difference to find). `after[n]` runs once the n-th submit has committed (another block, say)."""

    def __init__(self, held, registered=None):
        self.offset, self.states, self.reads, self.submits, self.commits, self.after, self.skew = 40, {40: list(held)}, [], [], {}, {}, {}
        self.refuse_at, self.lose_reply_at, self.drop_at, self.refuse_offsets, self.completions_fail, self.bad_auth = set(), set(), set(), set(), False, 0
        self.registered = [("tok-1", {"operator": OP, "confirmer": CF, "gateway": GW, "builder": "b::1", "chainId": 1, "evmToken": "22" * 20, "instrumentId": INSTR,
                                  "factory": FACTORY})] if registered is None else registered
        node = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def send(self, code, body):
                data = json.dumps(body).encode()
                self.send_response(code); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)

            def auth(self):
                if self.headers.get("authorization") != f"Bearer {TOKEN}":
                    node.bad_auth += 1

            def do_GET(self):
                self.auth()
                self.send(200, {"offset": node.offset}) if self.path == "/v2/state/ledger-end" else self.send(404, {})

            def do_POST(self):
                self.auth()
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                path = self.path.split("?")[0]
                if path == "/v2/state/active-contracts-page":
                    return self.send(*node.active(body))
                if path == "/v2/commands/completions":
                    return self.send(*node.completions(body))
                if path == "/v2/commands/submit-and-wait":
                    return self.send(*node.submit(body))
                self.send(404, {})
        self.server = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, args=(0.01,), daemon=True).start()

    def close(self):
        self.server.shutdown(); self.server.server_close()

    def commit(self, new):
        self.offset += 1
        self.states[self.offset] = list(new)
        return self.offset

    def active(self, body):
        if list(body["eventFormat"]["filtersByParty"]) != [GW]:   # read as the gateway
            return 403, {"code": "PERMISSION_DENIED"}
        flt = next(iter(body["eventFormat"]["filtersByParty"].values()))["cumulative"][0]["identifierFilter"]
        at = body.get("activeAtOffset", self.offset)
        if "InterfaceFilter" in flt:
            self.reads.append(at)
            if at in self.refuse_offsets:
                return 400, {"code": "OFFSET_AFTER_LEDGER_END"}
            events = [{"contractEntry": {"JsActiveContract": {"createdEvent": {"contractId": cid, "interfaceViews": [{"viewStatus": {"code": 0}, "viewValue": view}]}}}}
                      for cid, view in self.states[at]]
        elif flt["TemplateFilter"]["value"]["templateId"].endswith(":GatewayToken"):
            events = [{"contractEntry": {"JsActiveContract": {"createdEvent": {"contractId": cid, "createArgument": args}}}} for cid, args in self.registered]
        else:
            events = []
        return 200, {"activeAtOffset": at, "activeContracts": events}

    def submit(self, body):
        self.submits.append(body)
        n = len(self.submits)
        exercise = body["commands"][0]["ExerciseCommand"]
        inputs = exercise["choiceArgument"]["transfer"]["inputHoldingCids"]
        now = self.states[self.offset]
        if n in self.refuse_at or any(i not in dict(now) for i in inputs):
            return 409, {"code": "CONTRACT_NOT_FOUND", "cause": "an input is gone"}
        if n in self.drop_at:
            return 500, {"cause": "the participant did not answer"}
        total = sum(b.base_units(dict(now)[i]["amount"]) for i in inputs) + self.skew.get(n, 0)
        out = hold(f"out-{n}", b.canton_amount(total))
        offset = self.commit([h for h in now if h[0] not in inputs] + [out])
        self.commits[body["commandId"]] = (offset, f"update-{n}")
        if n in self.lose_reply_at:
            return 500, {"cause": "the reply was lost"}
        if n in self.after:
            self.after[n](self)
        return 200, {"updateId": f"update-{n}", "completionOffset": offset}

    def completions(self, body):
        if self.completions_fail:
            return 500, {"cause": "down"}
        items = [{"completionResponse": {"OffsetCheckpoint": {"value": {"offset": self.offset}}}}]
        for command_id, (offset, update) in self.commits.items():
            items.append({"completionResponse": {"Completion": {"value": {"commandId": command_id, "offset": offset, "updateId": update, "status": {"code": 0}}}}})
        return 200, [i for i in items if next(iter(i["completionResponse"].values()))["value"]["offset"] > body.get("beginExclusive", 0)]


class Rig(unittest.TestCase):
    def setUp(self):
        b.REGISTRY_DOWN.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        parties = self.dir / "state" / "canton" / "parties.env"
        parties.parent.mkdir(parents=True)
        parties.write_text(f"OPERATOR_PARTY={OP}\nCONFIRMER_PARTY={CF}\nGATEWAY_PARTY={GW}\n")
        self.work = self.dir / "work"
        for name, text in (("operator.token", TOKEN), ("scan.token", SCAN_TOKEN)):
            (self.dir / name).write_text(text + "\n")
            (self.dir / name).chmod(0o600)
        env = {"CZE_STATE_DIR": str(self.dir / "state"), "CZE_WORK_DIR": str(self.work), "CZE_TOKEN_FILE_OPERATOR": str(self.dir / "operator.token")}
        patch = mock.patch.dict(os.environ, env)
        patch.start()
        self.addCleanup(patch.stop)
        for name in ("CZE_LEDGER_NO_AUTH", "CZE_TOKEN_FILE_ADMIN", "CZE_TOKEN_FILE_CONFIRMER", "CZE_TOKEN_FILE_BUILDER", "CZE_USER_PREFIX"):
            os.environ.pop(name, None)
        self.registry = Registry()
        self.addCleanup(self.registry.close)

    def start(self, *held, **kw):
        self.node = Participant(held, **kw)
        self.addCleanup(self.node.close)
        return self.node

    def run_step(self, mode="run", *extra, instrument=f"{ADMIN}/Amulet", registry=True):
        """(exit status, the JSON line it printed or None, standard error): main's own result, or the SystemExit message of a refusal."""
        argv = ["--ledger-url", self.node.url, "--custody-refresh-step", mode, "--instrument", instrument]
        if registry:
            argv += ["--registry", f"{ADMIN}={self.registry.url}", "--registry-token-file", f"{ADMIN}={self.dir / 'scan.token'}"]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = setup.main([*argv, *extra])
            except SystemExit as e:
                code = e.code if isinstance(e.code, int) else 1
                err.write(str(e.code) if not isinstance(e.code, int) else "")
        text = out.getvalue().strip()
        return code, (json.loads(text.splitlines()[-1]) if text else None), err.getvalue()

    def stop(self):
        return b.read_custody_stop(self.cfg())

    def cfg(self):
        return b.Config(ws_url="", engine_url="", jwt_secret=b"", ledger_url="", ledger_user="", ledger_token="", party="", fee_recipient="", genesis="",
                        work_dir=str(self.work), make_input_cmd="", prove_cmd="")

    def now(self):
        return self.node.states[self.node.offset]

    def inputs(self, n):
        return self.node.submits[n]["commands"][0]["ExerciseCommand"]["choiceArgument"]["transfer"]["inputHoldingCids"]


class Plan(unittest.TestCase):
    """refresh_chunks: the holdings as (contract id, base units, expiry round), into the transfers of one pass."""

    def test_k_to_a_transfer_nearest_expiry_first_ties_to_the_larger_then_the_lower_id(self):
        held = [("c", 5 * CC, 30), ("a", 5 * CC, 30), ("b", 9 * CC, 30), ("d", 5 * CC, 10), ("e", 5 * CC, 20)]
        chunks = setup.refresh_chunks(held, FLOOR, 2)
        self.assertEqual([[h[0] for h in c] for c in chunks], [["d", "e"], ["b", "a"], ["c"]])

    def test_a_tail_under_the_floor_takes_the_largest_holding_of_the_one_before_that_can_spare_it(self):
        held = [("a", 3 * CC, 10), ("b", 3 * CC, 11), ("c", 4 * CC, 12), ("d", 3 * CC, 13), ("e", CC // 10, 14)]
        chunks = setup.refresh_chunks(held, FLOOR, 2)
        self.assertEqual([{h[0] for h in c} for c in chunks], [{"a", "b"}, {"d"}, {"e", "c"}])   # c (4 CC) goes to the tail: d alone is still over the floor
        self.assertTrue(all(sum(h[1] for h in c) >= FLOOR for c in chunks))

    def test_every_holding_under_the_floor_is_merged_all_the_same_and_reported(self):
        held = [("a", CC // 4, 10), ("b", CC // 4, 11), ("c", CC // 4, 12)]
        chunks = setup.refresh_chunks(held, FLOOR, 2)
        self.assertEqual([len(c) for c in chunks], [2, 1])

    def test_a_tail_that_cannot_reach_the_floor_is_refused(self):
        held = [("a", FLOOR, 10), ("b", FLOOR, 11), ("c", CC // 10, 12)]
        with self.assertRaises(SystemExit) as why:
            setup.refresh_chunks(held, FLOOR, 1)
        self.assertIn("under the minimum", str(why.exception))


class Dry(Rig):
    def test_a_dry_run_reads_and_plans_and_sends_nothing(self):
        self.start(hold("h1", "3.0"), hold("h2", "2.0"))
        code, out, _ = self.run_step("dry-run")
        self.assertEqual(code, 0)
        self.assertEqual((out["dryRun"], out["round"], out["floor"], out["floorDays"], out["maxInputs"], out["custody"]), (True, NOW, "1.118016", 30, 50, "5.0"))
        self.assertEqual([(t["inputs"], t["amount"], t["submitted"]) for t in out["transfers"]], [(2, "5.0", False)])
        self.assertEqual((self.node.submits, self.registry.posts()), ([], []))
        self.assertFalse(b.custody_stop_path(self.cfg()).exists())

    def test_the_rounds_are_read_with_the_registrys_token_and_the_ledger_with_the_operators(self):
        self.start(hold("h1", "3.0"))
        self.run_step("dry-run")
        self.assertEqual([(m, p, a) for m, p, a, _ in self.registry.asked], [("GET", "/open-and-issuing-mining-rounds", f"Bearer {SCAN_TOKEN}")])
        self.assertEqual(self.node.bad_auth, 0)

    def test_no_usable_holding_is_nothing_to_do(self):
        self.start()
        code, out, _ = self.run_step("run")
        self.assertEqual((code, out["transfers"], out["ok"]), (0, [], True))
        self.assertEqual(self.node.submits, [])


class Arguments(Rig):
    def test_the_floor_days_are_the_steps_own_argument_and_default_to_30(self):
        self.start(hold("h1", "3.0"))
        self.assertEqual(self.run_step("dry-run")[1]["floor"], "1.118016")
        out = self.run_step("dry-run", "--custody-floor-days", "10")[1]
        self.assertEqual((out["floor"], out["floorDays"]), ("0.372672", 10))   # 10 days of 144 rounds at RATE

    def test_a_floor_that_is_not_a_positive_number_is_refused_before_anything_is_read(self):
        self.start(hold("h1", "3.0"))
        for bad in ("0", "-1", "nan", "inf", "x"):
            with self.subTest(bad):
                code, out, err = self.run_step("run", "--custody-floor-days", bad)
                self.assertNotEqual(code, 0)
                self.assertRegex(err, r"error: .*--custody-floor-days")
        self.assertEqual((self.node.reads, self.node.submits, self.registry.asked), ([], [], []))

    def test_the_cap_defaults_to_50_and_the_rounds_own_limit_wins_when_lower(self):
        self.start(*[hold(f"h{i:02}", "2.0") for i in range(60)])
        out = self.run_step("dry-run")[1]
        self.assertEqual((out["maxInputs"], [t["inputs"] for t in out["transfers"]]), (50, [50, 10]))
        self.registry.doc = rounds_doc(inputs="20")
        out = self.run_step("dry-run", "--max-transfer-inputs", "30")[1]
        self.assertEqual((out["maxInputs"], [t["inputs"] for t in out["transfers"]]), (20, [20, 20, 20]))
        out = self.run_step("dry-run", "--max-transfer-inputs", "7")[1]
        self.assertEqual(out["maxInputs"], 7)

    def test_a_cap_under_one_is_refused(self):
        self.start(hold("h1", "3.0"))
        code, _, err = self.run_step("run", "--max-transfer-inputs", "0")
        self.assertNotEqual(code, 0)
        self.assertIn("--max-transfer-inputs must be at least 1", err)
        self.assertEqual(self.node.submits, [])

    def test_the_instrument_needs_its_registry_and_its_token(self):
        self.start(hold("h1", "3.0"))
        self.assertIn("needs --registry", self.run_step("run", registry=False)[2])
        out, err = io.StringIO(), io.StringIO()
        argv = ["--ledger-url", self.node.url, "--custody-refresh-step", "run", "--instrument", f"{ADMIN}/Amulet", "--registry", f"{ADMIN}={self.registry.url}"]
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), self.assertRaises(SystemExit):
            setup.main(argv)
        self.assertIn("needs --registry-token-file", err.getvalue())
        self.assertEqual(self.node.submits, [])

    def test_the_instrument_is_an_admin_party_and_an_id(self):
        self.start(hold("h1", "3.0"))
        for bad in ("Amulet", "x/Amulet", f"{ADMIN}/", f"{ADMIN}/a/b"):
            with self.subTest(bad):
                self.assertNotEqual(self.run_step("run", instrument=bad)[0], 0)
        self.assertEqual(self.node.submits, [])

    def test_the_step_takes_no_other_step_no_demo_and_not_the_flag_dry_run(self):
        self.start(hold("h1", "3.0"))
        for extra in (["--dry-run"], ["--demo"], ["--gas-cap-step", "propose"], ["--package-step", "check"], ["--withdraw-proposal", "gas-cap"]):
            with self.subTest(extra):
                self.assertNotEqual(self.run_step("run", *extra)[0], 0)
        self.assertEqual(self.node.submits, [])

    def test_its_arguments_are_for_the_step_alone(self):
        self.start(hold("h1", "3.0"))
        for flag in (["--instrument", f"{ADMIN}/Amulet"], ["--custody-floor-days", "30"], ["--max-transfer-inputs", "5"], ["--registry", f"{ADMIN}=http://127.0.0.1:1"]):
            with self.subTest(flag):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    setup.main(["--ledger-url", self.node.url, "--pause-step", "unpause", *flag])

    def test_the_operators_token_is_needed(self):
        self.start(hold("h1", "3.0"))
        os.environ.pop("CZE_TOKEN_FILE_OPERATOR")
        code, _, err = self.run_step("run")
        self.assertNotEqual(code, 0)
        self.assertIn("CZE_TOKEN_FILE_OPERATOR", err)


class Rounds(Rig):
    def test_a_round_that_cannot_be_read_refuses_the_step_before_anything_is_sent(self):
        for doc, status in ((None, 500), ({"open_mining_rounds": []}, 200), (rounds_doc(rate="0"), 200)):
            with self.subTest((status, doc and list(doc))):
                self.registry.doc, self.registry.status = doc, status
                b.REGISTRY_DOWN.clear()
                self.start(hold("h1", "3.0"))
                code, out, err = self.run_step("run")
                self.assertNotEqual(code, 0)
                self.assertIn("open round", err)
                self.assertEqual(self.node.submits, [])

    def test_a_fee_at_transfer_refuses_the_step(self):
        self.registry.doc = rounds_doc(transfer_fee="0.01")
        self.start(hold("h1", "3.0"))
        code, _, err = self.run_step("run")
        self.assertNotEqual(code, 0)
        self.assertIn(b.CUSTODY_FEE, err)
        self.assertEqual(self.node.submits, [])


class Inputs(Rig):
    def test_locked_holdings_and_other_owners_and_instruments_are_not_inputs_but_custody_counts_the_locked(self):
        other = {"admin": ADMIN, "id": "Other"}
        self.start(hold("h1", "3.0"), hold("locked", "2.0", lock={"holders": [GW]}), hold("theirs", "4.0", owner="someone::1220" + "ee" * 32), hold("other", "9.0", instrument=other))
        out = self.run_step("run")[1]
        self.assertEqual(self.inputs(0), ["h1"])
        self.assertEqual(out["custody"], "5.0")

    def test_a_holding_at_or_past_its_expiry_round_is_skipped_and_reported(self):
        # 1.0 CC at RATE is 3864 rounds: made in round 0 it ran out long ago; made 3863 rounds ago it runs out in the round after the newest
        self.start(hold("fresh", "3.0"), hold("old", "1.0", created=0), hold("edge", "1.0", created=NOW - 3863))
        code, out, _ = self.run_step("run")
        self.assertEqual(code, 0)
        self.assertEqual(self.inputs(0), ["fresh"])
        self.assertEqual(sorted(s["contractId"] for s in out["skipped"]), ["edge", "old"])

    def test_a_holding_that_expires_the_round_after_next_is_an_input(self):
        self.start(hold("soon", "1.0", created=NOW - 3862), hold("fresh", "3.0"))
        self.run_step("run")
        self.assertEqual(self.inputs(0), ["soon", "fresh"])


class Transfers(Rig):
    def test_one_holding_is_one_transfer_to_the_gateway_itself_and_the_new_holding_has_the_same_amount(self):
        node = self.start(hold("h1", "3.0"))
        code, out, _ = self.run_step("run")
        self.assertEqual((code, out["ok"]), (0, True))
        (sent,) = node.submits
        exercise = sent["commands"][0]["ExerciseCommand"]
        self.assertEqual((exercise["templateId"], exercise["contractId"], exercise["choice"]),
                         ("#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory", FACTORY, "TransferFactory_Transfer"))
        arg = exercise["choiceArgument"]
        transfer = arg["transfer"]
        self.assertEqual((arg["expectedAdmin"], transfer["sender"], transfer["receiver"], transfer["amount"], transfer["instrumentId"], transfer["inputHoldingCids"], transfer["meta"]),
                         (ADMIN, GW, GW, "3.0", INSTR, ["h1"], {"values": {}}))
        self.assertEqual(arg["extraArgs"], {"context": CONTEXT["choiceContextData"], "meta": {"values": {}}})
        self.assertEqual(sent["disclosedContracts"], [DISCLOSED])
        self.assertEqual((sent["actAs"], sent["userId"]), ([GW], "ostia-operator"))
        self.assertEqual([(h[0], h[1]["amount"]) for h in self.now()], [("out-1", "3.0")])
        self.assertEqual(out["transfers"][0]["updateId"], "update-1")

    def test_the_registry_is_asked_for_each_transfer_with_its_token_and_its_own_transfer(self):
        self.start(hold("h1", "3.0"), hold("h2", "2.0"))
        self.run_step("run", "--max-transfer-inputs", "1")
        posts = self.registry.posts()
        self.assertEqual([p[2] for p in posts], [f"Bearer {SCAN_TOKEN}"] * 2)
        self.assertEqual([p[3]["choiceArguments"]["transfer"]["inputHoldingCids"] for p in posts], [self.inputs(0), self.inputs(1)])

    def test_the_factory_is_the_gateway_tokens_own(self):
        self.start(hold("h1", "3.0"), registered=[("tok-1", {"operator": OP, "confirmer": CF, "gateway": GW, "instrumentId": INSTR, "factory": "another-factory"})])
        code, _, err = self.run_step("run")
        self.assertNotEqual(code, 0)
        self.assertIn("transfer factory", err)   # the registry names FACTORY, not the token's
        self.assertEqual(self.node.submits, [])

    def test_no_gateway_token_for_the_instrument_refuses_the_step(self):
        self.start(hold("h1", "3.0"), registered=[])
        code, _, err = self.run_step("run")
        self.assertNotEqual(code, 0)
        self.assertIn("no registered token", err)
        self.assertEqual(self.node.submits, [])

    def test_two_factories_for_the_instrument_refuse_the_step(self):
        named = lambda f: {"operator": OP, "confirmer": CF, "gateway": GW, "instrumentId": INSTR, "factory": f}
        self.start(hold("h1", "3.0"), registered=[("t1", named("f1")), ("t2", named("f2"))])
        code, _, err = self.run_step("run")
        self.assertNotEqual(code, 0)
        self.assertIn("more than one", err)
        self.assertEqual(self.node.submits, [])


class OnePass(Rig):
    def test_it_makes_ceil_m_over_k_transfers_over_the_holdings_present_at_its_start_and_never_takes_its_own_output(self):
        held = [hold(f"h{i:02}", "2.0", created=NOW - i) for i in range(12)]
        node = self.start(*held)
        code, out, _ = self.run_step("run", "--max-transfer-inputs", "5")
        self.assertEqual(code, 0)
        self.assertEqual(len(node.submits), 3)   # ceil(12 / 5)
        sent = [self.inputs(i) for i in range(3)]
        self.assertEqual([len(s) for s in sent], [5, 5, 2])
        self.assertEqual(sorted(c for s in sent for c in s), sorted(h[0] for h in held))   # each of the twelve once, and none of the three outputs
        self.assertFalse(any(c.startswith("out-") for s in sent for c in s))
        self.assertEqual([h[0] for h in self.now()], ["out-1", "out-2", "out-3"])
        self.assertEqual(custody(self.now()), custody(held))

    def test_nearest_expiry_goes_first(self):
        # the holdings made earliest run out first
        held = [hold("late", "2.0", created=NOW), hold("early", "2.0", created=NOW - 50), hold("middle", "2.0", created=NOW - 20)]
        self.start(*held)
        self.run_step("run", "--max-transfer-inputs", "2")
        self.assertEqual((self.inputs(0), self.inputs(1)), (["early", "middle"], ["late"]))

    def test_a_single_holding_is_one_transfer_and_a_second_run_does_it_again(self):
        node = self.start(hold("h1", "3.0"))
        self.run_step("run")
        self.run_step("run")
        self.assertEqual((len(node.submits), self.inputs(1)), (2, ["out-1"]))   # the second run is a pass of its own, over what is there then

    def test_every_output_is_at_least_the_floor(self):
        # six holdings made 4,400 rounds ago run out before the 0.1 CC one made now: with K = 3 the last transfer would be the small one alone
        held = [hold(f"h{i}", "1.2", created=NOW - 4400) for i in range(6)] + [hold("tiny", "0.1")]
        node = self.start(*held)
        code, out, _ = self.run_step("run", "--max-transfer-inputs", "3")
        self.assertEqual(code, 0)
        self.assertEqual(sorted(len(self.inputs(i)) for i in range(3)), [2, 2, 3])
        self.assertIn("tiny", [c for i in range(3) for c in self.inputs(i)])
        self.assertEqual(len(node.submits), 3)
        self.assertTrue(all(b.base_units(t["amount"]) >= FLOOR for t in out["transfers"]))
        self.assertTrue(all(b.base_units(h[1]["amount"]) >= FLOOR for h in self.now()))

    def test_when_all_custody_is_under_the_floor_it_merges_and_says_so(self):
        node = self.start(hold("a", "0.3"), hold("b", "0.2"))
        code, out, _ = self.run_step("run")
        self.assertEqual((code, out["underFloor"], len(node.submits)), (0, True, 1))
        self.assertEqual(self.run_step("dry-run")[1]["underFloor"], True)

    def test_above_the_floor_it_is_not_flagged(self):
        self.start(hold("a", "3.0"))
        self.assertFalse(self.run_step("dry-run")[1]["underFloor"])

    def test_a_split_that_cannot_reach_the_floor_is_refused_before_anything_is_sent(self):
        node = self.start(hold("a", "1.2"), hold("b", "1.2"), hold("tiny", "0.1"))   # K = 1: the 0.1 CC holding is a transfer of its own
        code, _, err = self.run_step("run", "--max-transfer-inputs", "1")
        self.assertNotEqual(code, 0)
        self.assertIn("under the minimum", err)
        self.assertEqual(node.submits, [])


class Checked(Rig):
    def test_each_transfer_is_read_at_its_completion_offset_less_one_and_at_it(self):
        node = self.start(*[hold(f"h{i}", "2.0") for i in range(4)])
        node.reads.clear()
        code, out, _ = self.run_step("run", "--max-transfer-inputs", "2")
        self.assertEqual(code, 0)
        # the transfers complete at offsets 41 and 42: read at (40, 41) and at (41, 42)
        self.assertEqual(node.reads[-4:], [40, 41, 41, 42])
        self.assertEqual([(t["custodyBefore"], t["custodyAfter"], t["checked"]) for t in out["transfers"]], [("8.0", "8.0", True), ("8.0", "8.0", True)])

    def test_a_block_between_two_transfers_gives_no_false_stop(self):
        def block(node):   # a deposit lands, as a block does, between the two transfers
            node.commit(node.states[node.offset] + [hold("deposit", "5.0")])
        node = self.start(*[hold(f"h{i}", "2.0") for i in range(4)])
        node.after[1] = block
        code, out, _ = self.run_step("run", "--max-transfer-inputs", "2")
        self.assertEqual((code, out["ok"], self.stop()), (0, True, None))
        self.assertEqual(len(node.submits), 2)
        self.assertEqual([(t["custodyBefore"], t["custodyAfter"]) for t in out["transfers"]], [("8.0", "8.0"), ("13.0", "13.0")])   # the second sees the 5.0 on both sides

    def test_a_block_that_commits_after_the_transfer_before_its_check_is_not_a_difference(self):
        node = self.start(hold("h1", "3.0"))
        real = setup.read_custody
        def late(*a, **k):   # a deposit commits after the transfer and before the step reads at its offset
            if not getattr(late, "done", False):
                late.done = True
                node.commit(node.states[node.offset] + [hold("deposit", "5.0")])
            return real(*a, **k)
        with mock.patch.object(setup, "read_custody", late):
            code, out, _ = self.run_step("run")
        self.assertEqual((code, out["ok"], self.stop()), (0, True, None))

    def test_one_base_unit_more_writes_the_stop_sends_nothing_further_and_prints_both_numbers(self):
        node = self.start(*[hold(f"h{i}", "2.0") for i in range(6)])
        node.skew[1] = 1
        code, out, err = self.run_step("run", "--max-transfer-inputs", "2")
        self.assertEqual(code, 1)
        self.assertEqual(len(node.submits), 1)   # no further transfer
        self.assertFalse(out["ok"])
        self.assertEqual((out["transfers"][0]["custodyBefore"], out["transfers"][0]["custodyAfter"], out["transfers"][0]["checked"]), ("12.0", "12.0000000001", False))
        stop = self.stop()
        self.assertEqual((stop["custodyBefore"], stop["custodyAfter"], stop["updateId"], stop["instrument"]), ("12.0", "12.0000000001", "update-1", INSTR))
        self.assertEqual((stop["withdrawn"], stop["deposits"]), ("0.0", "0.0"))
        self.assertIn("custody", stop["reason"])
        self.assertIn("12.0000000001", err)   # on standard error too
        self.assertEqual(out["stopped"], stop["reason"])

    def test_one_base_unit_less_writes_the_stop_too(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"))
        node.skew[1] = -1
        code, out, _ = self.run_step("run")
        self.assertEqual((code, out["transfers"][0]["custodyAfter"]), (1, "3.9999999999"))
        self.assertIsNotNone(self.stop())

    def test_the_builders_own_code_reads_the_stop_and_holds_canton_coin_withdrawals(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"))
        node.skew[1] = 1
        self.run_step("run")
        cfg = self.cfg()
        cfg.expiring = (ADMIN,)
        rules = b.ExpiryRules(cfg, b.ChoiceContexts({}))
        self.assertEqual(rules.held_up(), b.CUSTODY_STOPPED)

    def test_a_read_the_participant_refuses_writes_the_stop(self):
        node = self.start(hold("h1", "3.0"))
        node.refuse_offsets = {41}   # the transfer completes at offset 41: read at 40 (before) and 41
        code, out, _ = self.run_step("run")
        self.assertEqual(code, 1)
        self.assertIn("refused", self.stop()["reason"])
        self.assertIn("HTTP 400", self.stop()["reason"])
        self.assertFalse(out["ok"])

    def test_a_stop_that_is_there_already_refuses_the_step_before_anything_is_sent(self):
        node = self.start(hold("h1", "3.0"))
        b.write_json_file(b.custody_stop_path(self.cfg()), {"reason": "earlier"})
        code, _, err = self.run_step("run")
        self.assertNotEqual(code, 0)
        self.assertIn("custody-clear", err)
        self.assertEqual((node.submits, self.registry.posts()), ([], []))

    def test_a_dry_run_with_a_stop_there_says_so_too_and_changes_nothing(self):
        self.start(hold("h1", "3.0"))
        b.write_json_file(b.custody_stop_path(self.cfg()), {"reason": "earlier"})
        self.assertNotEqual(self.run_step("dry-run")[0], 0)
        self.assertEqual(self.stop(), {"reason": "earlier"})

    def test_the_builders_kept_custody_check_is_left_alone_by_a_stop(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"))
        node.skew[1] = 1
        record = {"commandId": "c-1", "begin": 1, "gateway": GW, "plan": [], "submittedAt": 1}
        b.write_json_file(b.custody_check_path(self.cfg()), record)
        self.run_step("run")
        self.assertEqual(json.loads(b.custody_check_path(self.cfg()).read_text()), record)
        self.assertIsNotNone(self.stop())

    def test_custody_clear_takes_the_stop_away_and_the_step_runs_again(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"))
        node.skew[1] = 1
        self.run_step("run")
        with mock.patch.dict(os.environ, {"CZE_WORK_DIR": str(self.work)}):
            self.assertTrue(b.custody_clear("run")["cleared"])
        node.skew.clear()
        self.assertEqual(self.run_step("run")[0], 0)

    def test_a_clean_run_leaves_no_stop_file(self):
        self.start(hold("h1", "2.0"))
        self.run_step("run")
        self.assertFalse(b.custody_stop_path(self.cfg()).exists())


class Failures(Rig):
    def test_a_transfer_the_participant_refuses_changes_nothing_writes_no_stop_and_ends_the_run(self):
        node = self.start(*[hold(f"h{i}", "2.0") for i in range(4)])
        node.refuse_at = {2}
        code, out, err = self.run_step("run", "--max-transfer-inputs", "2")
        self.assertEqual(code, 1)
        self.assertEqual(len(node.submits), 2)
        self.assertEqual([t["submitted"] for t in out["transfers"]], [True, False])
        self.assertIn("run it again", out["error"])
        self.assertIsNone(self.stop())
        self.assertEqual(custody(self.now()), 8 * CC)

    def test_a_clash_with_a_block_that_took_an_input_is_a_refusal_and_the_next_run_reads_afresh(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"), hold("h3", "2.0"))
        node.after[1] = lambda n: n.commit([h for h in n.states[n.offset] if h[0] != "h3"] + [hold("change", "2.0")])   # a block took h3 for a withdrawal
        code, out, _ = self.run_step("run", "--max-transfer-inputs", "2")
        self.assertEqual((code, len(node.submits)), (1, 2))
        self.assertEqual(self.run_step("run")[0], 0)

    def test_a_reply_that_was_lost_after_the_commit_is_found_again_by_its_command_id_and_checked(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"))
        node.lose_reply_at = {1}
        code, out, _ = self.run_step("run")
        self.assertEqual((code, out["ok"]), (0, True))
        self.assertEqual((out["transfers"][0]["updateId"], out["transfers"][0]["checked"]), ("update-1", True))
        self.assertEqual(node.reads[-2:], [40, 41])

    def test_a_lost_reply_whose_commit_changed_custody_writes_the_stop(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"))
        node.lose_reply_at, node.skew[1] = {1}, 1
        code, _, _ = self.run_step("run")
        self.assertEqual(code, 1)
        self.assertIsNotNone(self.stop())

    def test_a_transfer_with_no_answer_and_no_completion_writes_the_stop_and_ends_the_run(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"), hold("h3", "2.0"))
        node.drop_at = {1}
        code, out, _ = self.run_step("run", "--max-transfer-inputs", "2")
        self.assertEqual((code, len(node.submits)), (1, 1))
        self.assertIn("not known", self.stop()["reason"])
        self.assertFalse(out["ok"])

    def test_a_transfer_with_no_answer_and_completions_that_cannot_be_read_writes_the_stop(self):
        node = self.start(hold("h1", "2.0"))
        node.drop_at, node.completions_fail = {1}, True
        self.assertEqual(self.run_step("run")[0], 1)
        self.assertIn("not known", self.stop()["reason"])

    def test_a_transient_failure_of_a_check_read_is_not_a_stop_until_it_has_been_tried_again(self):
        node = self.start(hold("h1", "3.0"))
        real = b.Ledger.active_holdings
        calls = []
        def flaky(ledger, offset=None):
            calls.append(offset)
            if len(calls) == 3:   # the second read of the check fails once, and the check is made again
                raise OSError("connection reset")
            return real(ledger, offset)
        with mock.patch.object(b.Ledger, "active_holdings", flaky), mock.patch.object(setup.time, "sleep"):
            code, out, _ = self.run_step("run")
        self.assertEqual((code, out["ok"], self.stop()), (0, True, None))

    def test_a_check_read_that_keeps_failing_writes_the_stop(self):
        node = self.start(hold("h1", "3.0"))
        real = b.Ledger.active_holdings
        def broken(ledger, offset=None):
            if offset is not None:
                raise OSError("connection reset")
            return real(ledger, offset)
        with mock.patch.object(b.Ledger, "active_holdings", broken), mock.patch.object(setup.time, "sleep"):
            code, _, _ = self.run_step("run")
        self.assertEqual(code, 1)
        self.assertIn("could not be read", self.stop()["reason"])


class Secrets(Rig):
    def test_no_token_is_printed(self):
        node = self.start(hold("h1", "2.0"), hold("h2", "2.0"))
        node.skew[1] = 1
        _, out, err = self.run_step("run")
        text = json.dumps(out) + err
        self.assertNotIn(TOKEN, text)
        self.assertNotIn(SCAN_TOKEN, text)


if __name__ == "__main__":
    unittest.main()
