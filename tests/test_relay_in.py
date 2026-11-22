"""Tests for worker/relay_in.py (the Canton router's in-relayer, flow C) against stand-ins only: the fake chain of test_worker.py for Ostia and for the source chain, a fake Canton snapshot, and a
local stand-in for the bridge service. No real endpoint is used.
Run: python3 -W error::ResourceWarning -m unittest tests/test_relay_in.py"""
import contextlib, io, json, os, sys, unittest, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from eth_abi import decode, encode
from eth_utils import keccak

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_worker as tw
from test_worker import FakeChain, Revert, Server
import canton, chain, claim_sepolia, main as worker_main, relay_in, relay_out

PARTY, REFUND, TOKEN, UNLISTED = "alice::1220" + "ab" * 32, "0x" + "5b" * 20, "0x" + "11" * 20, "0x" + "22" * 20
SOURCE_BRIDGE, OSTIA_BRIDGE, ROUTER, BOOK = tw.SEPOLIA_BRIDGE, "0x" + "e5" * 20, tw.ROUTER, tw.BOOK
NET = 75
CFG = {**tw.CFG, "coins": [TOKEN], "floor": 0, "chunk": 50, "from_block": 0, "ostia_from": 0, "cooldown": 300, "open_per_hour": 3, "src_net": 0}
NOW = 1_800_000_000.0
FORWARD, MARK, REFUND_SIG = ("%s(string,uint32,address,address)" % n for n in ("forward", "mark", "refund"))
FOUR = ["string", "uint32", "address", "address"]


def inbox_of(party, net, refund):
    return "0x" + keccak(encode(["string", "uint32", "address"], [party, net, refund]))[12:].hex()


INBOX = inbox_of(PARTY, 0, REFUND)


def opened_log(party=PARTY, net=0, refund=REFUND, inbox=None, block=10):
    data = encode(["string", "uint32"], [party, net])
    return {"address": ROUTER, "blockNumber": hex(block), "data": "0x" + data.hex(),
            "topics": [relay_in.INBOX_OPENED, "0x" + "00" * 12 + (inbox or inbox_of(party, net, refund))[2:], "0x" + "00" * 32, "0x" + "00" * 12 + refund[2:]]}


def bridge_log(count, dest=INBOX, network=NET, kind=0, origin=NET, coin=TOKEN, amount=900, block=10):
    data = encode(["uint8", "uint32", "address", "uint32", "address", "uint256", "bytes", "uint32"], [kind, origin, coin, network, dest, amount, b"\x01", count])
    return {"address": SOURCE_BRIDGE, "blockNumber": hex(block), "topics": [relay_in.BRIDGE_EVENT], "data": "0x" + data.hex()}


def leaf(count=7, dest=INBOX, amount=900):
    return {**tw.LEAF, "deposit_count": count, "destination_network": NET, "destination_address": dest, "amount": str(amount), "origin_address": TOKEN}


def snapshot(**chain_fields):
    return SimpleNamespace(chain={"chainId": 770101, "pausedUntil": None, "withdrawalQuota": "10.0", "quotaWindow": "86400", "withdrawn": [], **chain_fields}, accepted={PARTY}, instrument={TOKEN: "dso::1/Amulet"})


def iso(seconds):
    return (datetime.fromtimestamp(NOW, timezone.utc) + timedelta(seconds=seconds)).isoformat()


class InBase(tw.Base):
    def setUp(self):
        super().setUp()
        self.ostia, self.source = FakeChain("Ostia"), FakeChain("Sepolia")
        self.b = {"in_open": True, "fee_in": 100, "bal": {}, "at": {}, "claimed": set(), "listed": True, "unit": {0: 10, 74: 100}}
        b, o = self.b, self.ostia
        o.on(ROUTER, "book()", [], ["address"], lambda: (BOOK,))
        o.on(ROUTER, "bridge()", [], ["address"], lambda: (OSTIA_BRIDGE,))
        o.on(OSTIA_BRIDGE, "networkID()", [], ["uint32"], lambda: (NET,))
        o.on(ROUTER, "inboxOf(string,uint32,address)", ["string", "uint32", "address"], ["address"], lambda p, n, a: (inbox_of(p, n, a.lower()),))
        o.on(BOOK, "unitOf(uint32)", ["uint32"], ["uint256"], lambda n: (b["unit"].get(n, 0),))
        o.on(BOOK, "inOpen()", [], ["bool"], lambda: (b["in_open"],))
        o.on(BOOK, "checkIn(address)", ["address"], [relay_out.ASSET], lambda t: ((1, b"\0" * 32, 0, b["fee_in"], 0, 0, 0),) if b["in_open"] and b["listed"] else (_ for _ in ()).throw(Revert()))
        o.on(BOOK, "assets(address)", ["address"], [relay_out.ASSET], lambda t: ((1 if b["listed"] and t.lower() == TOKEN else 0, b"\0" * 32, 0, b["fee_in"], 0, 0, 0),))
        o.on(TOKEN, "balanceOf(address)", ["address"], ["uint256"], lambda who: (b["bal"].get(who.lower(), 0),))
        o.on(ROUTER, "refundAt(address,address)", ["address", "address"], ["uint256"], lambda i, t: (b["at"].get(i.lower(), 0),))
        o.on(OSTIA_BRIDGE, "isClaimed(uint32,uint32)", ["uint32", "uint32"], ["bool"], lambda c, n: ((c, n) in b["claimed"],))
        self.snap = snapshot()
        self.canton = SimpleNamespace(snapshot=lambda: self.snap)
        self.aggkit = claim_sepolia.Aggkit("http://127.0.0.1:1")
        self.cfg = dict(CFG)
        self.router = relay_in.InRouter(o, ROUTER)

    def ctx(self):
        return SimpleNamespace(router=self.router, rpc=self.ostia, source=self.source, source_bridge=SOURCE_BRIDGE, aggkit=self.aggkit, canton=self.canton, signer=self.signer, cfg=self.cfg)

    def serve(self, **overrides):
        routes = {"bridges": {"bridges": [leaf()]}, "l1-info-tree-index": 3, "injected-l1-info-leaf": {"l1_info_tree_index": 5}, "claim-proof": tw.PROOF, **overrides}
        self.server = Server(routes)
        self.addCleanup(self.server.stop)
        self.aggkit = claim_sepolia.Aggkit(self.server.url)

    def run_once(self, now=NOW):
        relay_in.run_once(self.ctx(), self.records, self.logs.append, now)

    def know_inbox(self):
        self.records.put("inbox:" + INBOX, kind="inbox", party=PARTY, net=0, refund=REFUND)

    def add_leaf(self, count=7):
        self.know_inbox()
        self.records.put(f"leaf:{count}", kind="leaf", state="pending", count=count, inbox=INBOX, coin=TOKEN, origin=NET, amount="900", tries=0)

    def selector(self, i=-1):
        return bytes(self.ostia.sent[i]["data"])[:4]

    def args(self, i=-1):
        return decode(FOUR, bytes(self.ostia.sent[i]["data"])[4:])

    def stick(self):
        """The one sent transaction has had no receipt for longer than the wait."""
        [(key, sent)] = self.records.where("sent")
        self.records.get(key)["at"] -= 10_000


class IntakeTests(InBase):
    def ask(self, **q):
        body = json.dumps({"party": PARTY, "refundNetwork": 0, "refundAddress": REFUND, **q}).encode()
        return relay_in.intake(body, self.ctx(), self.records, NOW)

    def test_a_valid_request_is_queued_with_the_address_the_router_works_out_and_asked_once(self):
        self.assertEqual(self.ask(), (202, {"inbox": INBOX, "status": "queued"}))
        self.assertEqual(self.records.get("open:" + INBOX)["state"], "queued")
        self.assertEqual(self.ask()[0], 200)   # the same inbox again: no second request
        self.assertEqual(len(self.records.where("queued")), 1)

    def test_a_request_that_is_malformed_names_a_network_that_cannot_take_a_refund_or_has_no_acceptance_is_refused(self):
        cases = [({"party": "a b"}, 400), ({"party": ""}, 400), ({"party": "x" * 300}, 400), ({"refundNetwork": -1}, 400), ({"refundNetwork": "0"}, 400), ({"refundNetwork": 2**32}, 400),
                 ({"refundAddress": "0x" + "00" * 20}, 400), ({"refundAddress": "0x12"}, 400), ({"refundNetwork": NET}, 422), ({"refundNetwork": 9}, 422), ({"party": "bob::1220" + "cd" * 32}, 422)]
        for q, code in cases:
            with self.subTest(q):
                self.assertEqual(self.ask(**q)[0], code)
        self.assertEqual(relay_in.intake(b"not json", self.ctx(), self.records, NOW)[0], 400)
        self.assertEqual(self.records.data["items"], {})

    def test_it_says_when_flow_c_is_closed_when_canton_cannot_be_read_and_when_too_many_are_asked(self):
        self.b["in_open"] = False
        self.assertEqual(self.ask()[0], 503)
        self.b["in_open"] = True
        self.canton = SimpleNamespace(snapshot=lambda: (_ for _ in ()).throw(canton.Fail("down")))
        self.assertEqual(self.ask()[0], 502)
        self.canton = SimpleNamespace(snapshot=lambda: self.snap)
        for n in range(3):
            self.assertEqual(self.ask(refundAddress="0x" + f"{n + 1:040x}")[0], 202)
        self.assertEqual(self.ask(refundAddress="0x" + "99" * 20)[0], 429)

    def test_the_intake_answers_over_loopback_with_a_size_limit_and_no_other_path(self):
        server = relay_in.serve(0, lambda raw: relay_in.intake(raw, self.ctx(), self.records, NOW))
        self.addCleanup(lambda: (server.shutdown(), server.server_close()))
        url = f"http://127.0.0.1:{server.server_address[1]}"
        post = lambda path, body: urllib.request.urlopen(urllib.request.Request(url + path, body, {"content-type": "application/json"}), timeout=5)
        with post("/open", json.dumps({"party": PARTY, "refundNetwork": 0, "refundAddress": REFUND}).encode()) as r:
            self.assertEqual((r.status, json.load(r)["inbox"]), (202, INBOX))
        for path, body, code in (("/other", b"{}", 404), ("/open", b"x" * 5000, 413)):
            with self.assertRaises(urllib.error.HTTPError) as why:
                post(path, body)
            self.assertEqual(why.exception.code, code)
            why.exception.close()
        self.assertEqual(server.server_address[0], "127.0.0.1")


class OpenAndDiscoverTests(InBase):
    def test_a_queued_request_is_sent_as_open_inbox_and_the_inbox_is_known_only_from_its_event(self):
        relay_in.intake(json.dumps({"party": PARTY, "refundNetwork": 0, "refundAddress": REFUND}).encode(), self.ctx(), self.records, NOW)
        self.run_once()
        self.assertEqual(self.selector(), chain.selector("openInbox(string,uint32,address)"))
        self.assertEqual(decode(["string", "uint32", "address"], bytes(self.ostia.sent[0]["data"])[4:])[:2], (PARTY, 0))
        self.ostia.mine(0, block=120)
        self.ostia.final, self.ostia.logs = 120, [opened_log(block=120)]
        self.run_once()
        self.assertEqual((self.records.get("open:" + INBOX)["state"], self.records.get("inbox:" + INBOX)["party"]), ("done", PARTY))

    def test_an_event_whose_inbox_is_not_the_one_the_router_works_out_is_ignored(self):
        self.ostia.logs = [opened_log(inbox="0x" + "77" * 20), opened_log(party="bob::1", block=11)]
        self.run_once()
        self.assertEqual(list(self.records.data["items"]), ["inbox:" + inbox_of("bob::1", 0, REFUND)])
        self.assertEqual(self.records.data["cursors"]["ostia"], 100)

    def test_a_request_waits_while_flow_c_is_closed_and_a_replaced_open_is_asked_again(self):
        self.records.put("open:" + INBOX, kind="open", state="queued", party=PARTY, net=0, refund=REFUND, asked=NOW)
        self.b["in_open"] = False
        self.run_once()
        self.assertEqual(self.ostia.sent, [])
        self.b["in_open"] = True
        self.run_once()
        self.stick()
        self.run_once()
        self.assertEqual((len(self.ostia.sent), self.records.get("open:" + INBOX)["state"]), (2, "queued"))   # the second is the transfer of nothing that frees the nonce
        self.run_once()
        self.assertEqual((len(self.ostia.sent), self.selector()), (3, chain.selector("openInbox(string,uint32,address)")))


class SourceTests(InBase):
    def test_only_asset_leaves_for_this_network_and_an_open_inbox_are_kept_and_only_final_blocks_are_read(self):
        self.know_inbox()
        self.source.logs = [bridge_log(1), bridge_log(2, network=0), bridge_log(3, kind=1), bridge_log(4, dest="0x" + "77" * 20), bridge_log(5, origin=0, coin=UNLISTED), bridge_log(6, block=101)]
        self.run_once()
        kept = {k: v for k, v in self.records.data["items"].items() if k.startswith("leaf:")}
        self.assertEqual(sorted(kept), ["leaf:1", "leaf:5"])
        self.assertEqual((kept["leaf:1"]["state"], kept["leaf:1"]["inbox"], kept["leaf:1"]["amount"]), ("pending", INBOX, "900"))
        self.assertEqual(self.records.data["cursors"]["source"], 100)


class ClaimTests(InBase):
    def test_when_canton_can_pay_and_the_router_takes_it_the_claim_pays_it_to_the_party_in_one_call(self):
        self.serve()
        self.add_leaf()
        self.run_once()
        self.assertEqual(self.selector(), chain.selector(relay_in.CLAIM_PAY))
        args = decode([relay_in.CLAIM_ARGS, "string", "uint32", "address"], bytes(self.ostia.sent[0]["data"])[4:])
        c = args[0]
        self.assertEqual((c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10]), (int(tw.LEAF["global_index"]), bytes.fromhex("aa" * 32), bytes.fromhex("bb" * 32), NET, TOKEN, NET, INBOX, 900, b"\x01"))
        self.assertEqual(list(c[0]), [bytes.fromhex(h[2:]) for h in tw.HASHES])
        self.assertEqual(args[1:], (PARTY, 0, REFUND))
        self.assertEqual(self.records.get("leaf:7")["state"], "sent")
        self.assertTrue(any(p.startswith("/bridge/v1/claim-proof?network_id=0&leaf_index=5&") for p in self.server.seen))   # the injected root's index, not the deposit's own

    def test_when_canton_cannot_pay_now_or_the_router_will_not_forward_it_only_claims_into_the_inbox(self):
        for name, change in (("no acceptance", lambda: setattr(self.snap, "accepted", set())), ("paused", lambda: self.snap.chain.update(pausedUntil=iso(3600))),
                             ("quota used", lambda: self.snap.chain.update(withdrawn=[{"tallyToken": "dso::1/Amulet", "tallyAmount": "9.9999999950", "countedUntil": iso(3600)}])),
                             ("flow closed", lambda: self.b.update(in_open=False))):
            with self.subTest(name):
                self.setUp()
                self.serve()
                self.add_leaf()
                change()
                self.run_once()
                self.assertEqual(self.selector(), chain.selector(relay_in.CLAIM_HOLD))

    def test_a_pay_claim_that_is_left_out_is_replaced_and_the_leaf_is_then_claimed_into_the_inbox_only(self):
        self.serve()
        self.add_leaf()
        self.run_once()
        self.stick()
        self.run_once()
        self.assertEqual((self.records.get("leaf:7")["state"], self.records.get("leaf:7")["hold"]), ("pending", True))
        self.run_once()
        self.assertEqual(self.selector(), chain.selector(relay_in.CLAIM_HOLD))

    def test_a_claim_counts_only_in_a_final_block_and_a_reverted_one_is_tried_again_up_to_three_times(self):
        self.serve()
        self.add_leaf()
        self.run_once()
        self.ostia.mine(0, block=120)
        self.ostia.final = 110
        self.run_once()
        self.assertEqual(self.records.get("leaf:7")["state"], "sent")
        self.ostia.final = 120
        self.run_once()
        self.assertEqual(self.records.get("leaf:7")["state"], "claimed")
        self.records.put("leaf:7", state="pending", tries=0)
        for i in range(3):
            self.run_once()
            self.ostia.mine(len(self.ostia.sent) - 1, status=0, block=120)
            self.run_once()
        self.assertEqual((self.records.get("leaf:7")["state"], len(self.ostia.sent)), ("failed", 4))

    def test_it_waits_at_each_step_the_bridge_service_has_not_reached(self):
        self.add_leaf()
        for override in ({"bridges": {"bridges": []}}, {"l1-info-tree-index": None}, {"injected-l1-info-leaf": None}, {"claim-proof": None}):
            with self.subTest(list(override)):
                self.serve(**override)
                self.run_once()
                self.assertEqual((self.ostia.sent, self.records.get("leaf:7")["state"]), ([], "pending"))

    def test_a_leaf_that_is_not_the_one_the_event_described_or_a_token_the_router_does_not_take_is_never_claimed(self):
        for name, listed, routes in (("amount", True, {"bridges": {"bridges": [leaf(amount=901)]}}), ("inbox", True, {"bridges": {"bridges": [leaf(dest="0x" + "77" * 20)]}}),
                                     ("origin", True, {"bridges": {"bridges": [{**leaf(), "origin_network": 0}]}}), ("not listed", False, {}), ("bad proof", True, {"claim-proof": {"proof_local_exit_root": [1]}})):
            with self.subTest(name):
                self.setUp()
                self.serve(**routes)
                self.b["listed"] = listed
                self.add_leaf()
                self.run_once()
                self.assertEqual(self.ostia.sent, [])
        self.assertEqual(self.records.get("leaf:7")["state"], "pending")   # a bad proof is the service's fault and is read again

    def test_a_leaf_that_is_claimed_already_or_under_the_floor_is_not_claimed_and_a_cap_or_a_low_balance_waits(self):
        self.serve()
        self.add_leaf()
        self.b["claimed"].add((7, 0))
        self.run_once()
        self.assertEqual((self.ostia.sent, self.records.get("leaf:7")["state"]), ([], "claimed"))
        self.b["claimed"].clear()
        self.records.put("leaf:7", state="pending")
        self.cfg["floor"] = 901
        self.run_once()
        self.assertEqual(self.ostia.sent, [])
        self.cfg.update(floor=0, caps={"hour": 0, "day": 100, "recipient": 10})
        self.run_once()
        self.assertEqual(self.ostia.sent, [])
        self.cfg["caps"] = tw.CFG["caps"]
        self.ostia.balance = 0
        self.run_once()
        self.assertEqual(self.ostia.sent, [])
        self.ostia.balance = 10**18
        self.run_once()
        self.assertEqual(len(self.ostia.sent), 1)

    def test_a_refused_claim_goes_back_and_one_whose_answer_was_lost_is_found_again_one_at_a_time(self):
        self.serve()
        self.add_leaf()
        self.add_leaf(8)
        self.ostia.refuse = "nonce too low"
        self.run_once()
        self.assertEqual((self.records.get("leaf:7")["state"], self.records.get("leaf:8")["state"]), ("pending", "pending"))
        self.ostia.refuse, self.ostia.lose_answer = None, True
        self.run_once()
        self.assertEqual(self.records.get("leaf:7")["state"], "sent")
        self.assertTrue(any("answer is unknown" in line for line in self.logs))
        self.run_once()
        self.assertEqual((len(self.ostia.sent), self.records.get("leaf:8")["state"]), (1, "pending"))

    def test_nothing_secret_is_logged_or_recorded(self):
        self.serve()
        self.add_leaf()
        self.ostia.refuse = "boom"
        self.run_once()
        self.assertNotIn("secret-key-xyz", " ".join(self.logs) + json.dumps(self.records.data))


class SweepTests(InBase):
    def setUp(self):
        super().setUp()
        self.know_inbox()
        self.b["bal"][INBOX] = 1000

    def test_a_held_coin_goes_to_canton_when_canton_can_pay_and_otherwise_starts_the_clock_and_goes_back_after_it(self):
        self.run_once()
        self.assertEqual((self.selector(), self.args()), (chain.selector(FORWARD), (PARTY, 0, REFUND, TOKEN)))
        self.setUp()
        self.snap.accepted = set()
        self.run_once()
        self.assertEqual(self.selector(), chain.selector(MARK))
        self.setUp()
        self.snap.accepted = set()
        self.b["at"][INBOX] = int(NOW) + 100
        self.run_once()
        self.assertEqual(self.ostia.sent, [])   # the clock is running and has not ended
        self.run_once(NOW + 101)
        self.assertEqual(self.selector(), chain.selector(REFUND_SIG))

    def test_a_balance_at_or_below_the_fee_is_swept_to_the_fee_whatever_canton_says_and_an_empty_inbox_is_left_alone(self):
        self.b["bal"][INBOX] = 100
        self.snap.accepted = set()
        self.run_once()
        self.assertEqual(self.selector(), chain.selector(FORWARD))
        self.setUp()
        self.b["bal"][INBOX] = 0
        self.run_once()
        self.assertEqual(self.ostia.sent, [])

    def test_when_flow_c_is_closed_a_held_coin_still_goes_back_after_its_clock(self):
        self.b["in_open"] = False
        self.b["at"][INBOX] = int(NOW) - 1
        self.run_once()
        self.assertEqual(self.selector(), chain.selector(REFUND_SIG))

    def test_a_forward_that_is_left_out_is_not_tried_again_for_the_cooldown_and_the_coin_is_marked_meanwhile(self):
        self.run_once()
        self.stick()
        self.run_once()
        self.assertEqual(self.records.get(f"cool:{INBOX}:{TOKEN}")["until"], NOW + 300)
        self.run_once(NOW + 1)
        self.assertEqual((len(self.ostia.sent), self.selector()), (3, chain.selector(MARK)))   # the second is the transfer of nothing that frees the nonce
        self.ostia.mine(2)
        self.b["at"][INBOX] = int(NOW) + 5000
        self.run_once(NOW + 2)
        self.assertEqual(len(self.ostia.sent), 3)   # still cooling
        self.run_once(NOW + 301)
        self.assertEqual(self.selector(), chain.selector(FORWARD))

    def test_the_oldest_clock_is_served_first(self):
        other = inbox_of("bob::1", 0, REFUND)
        self.records.put("inbox:" + other, kind="inbox", party="bob::1", net=0, refund=REFUND)
        self.snap.accepted = set()
        self.b["bal"][other] = 1000
        self.b["at"].update({INBOX: int(NOW) - 10, other: int(NOW) - 500})
        self.run_once()
        self.assertEqual((self.selector(), self.args()[0]), (chain.selector(REFUND_SIG), "bob::1"))


class CantonReasonTests(unittest.TestCase):
    def test_pause_quota_and_acceptance_decide_whether_canton_can_pay(self):
        at = datetime.fromtimestamp(NOW, timezone.utc)
        reason = lambda snap, amount=10**10: relay_in.canton_reason(snap, PARTY, TOKEN, amount, at)
        self.assertIsNone(reason(snapshot()))
        self.assertIn("accept", reason(SimpleNamespace(**{**vars(snapshot()), "accepted": set()})))
        self.assertIn("paused", reason(snapshot(pausedUntil=iso(60))))
        self.assertIsNone(reason(snapshot(pausedUntil=iso(-60))))
        self.assertIsNone(reason(snapshot(withdrawalQuota=None)))
        counted = [{"tallyToken": "dso::1/Amulet", "tallyAmount": "9.0", "countedUntil": iso(60)}, {"tallyToken": "other", "tallyAmount": "9.0", "countedUntil": iso(60)}]
        self.assertIsNone(reason(snapshot(withdrawn=counted), 10**10))   # 9 + 1 is exactly the quota of 10
        self.assertIn("quota", reason(snapshot(withdrawn=counted), 10**10 + 1))
        self.assertIsNone(reason(snapshot(withdrawn=[{**counted[0], "countedUntil": iso(-60)}]), 10 * 10**10))   # no longer counted
        self.assertIn("quota", reason(snapshot(withdrawn=[{**counted[0], "tallyAmount": "x"}])))   # unreadable: not paid
        self.assertIn("instrument", relay_in.canton_reason(snapshot(), PARTY, UNLISTED, 1, at))


class MainTests(tw.Base):
    def test_a_worker_with_its_switch_off_reads_and_sends_nothing(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(chain, "Rpc", side_effect=AssertionError), contextlib.redirect_stdout(io.StringIO()) as out:
            worker_main.run(["in", "--once"])
        self.assertIn("OSTIA_RELAY_IN is not 1", out.getvalue())

    def test_the_tokens_and_both_endpoints_are_checked_before_anything_is_sent_and_nothing_secret_is_named(self):
        env = {"OSTIA_RELAY_IN": "1", "OSTIA_RPC_URL": tw.SECRET_URL, "OSTIA_ROUTER": ROUTER, "OSTIA_WORKER_STATE_DIR": self.dir.name, "OSTIA_RELAY_IN_KEY_FILE": tw.key_file(self.dir.name),
               "OSTIA_RELAY_IN_SOURCE_RPC_URL": tw.SECRET_URL, "OSTIA_RELAY_IN_SOURCE_BRIDGE": SOURCE_BRIDGE, "OSTIA_RELAY_IN_TOKENS": TOKEN}
        with mock.patch.dict(os.environ, {**env, "OSTIA_RELAY_IN_TOKENS": "nope"}, clear=True), self.assertRaises(SystemExit) as why:
            worker_main.run(["in", "--once"])
        self.assertIn("OSTIA_RELAY_IN_TOKENS", str(why.exception))
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(chain, "Rpc", lambda label, url: FakeChain(label)), mock.patch.object(canton, "Network"), \
                mock.patch.object(canton, "chain_record", lambda net: {"chainId": 5}):
            with self.assertRaises(SystemExit) as why:
                worker_main.run(["in", "--once"])
            self.assertIn("is chain 770101, not 5", str(why.exception))
            self.assertNotIn("secret-key-xyz", str(why.exception))


if __name__ == "__main__":
    unittest.main()
