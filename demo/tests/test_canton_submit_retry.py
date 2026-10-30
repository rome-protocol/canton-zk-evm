"""Tests for the retry of Network.submit in demo/canton.py, with a fake participant. Run: python3 -W error::ResourceWarning -m unittest discover -s demo/tests -p 'test_canton_submit_retry.py'"""
import http.server, json, os, socket, sys, tempfile, threading, unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import canton

TIMEOUT_TEXT = "The server was not able to produce a timely response to your request. Please try again in a short while!"
TIMEOUT_503 = TIMEOUT_TEXT   # as the participant's HTTP server answers: plain text, not JSON
JSON_503 = {"code": "SERVER_IS_OVERLOADED", "cause": TIMEOUT_TEXT}
NOT_FOUND = {"code": "CONTRACT_NOT_FOUND", "cause": "Contract could not be found with id 00ab"}
DUPLICATE = {"code": "DUPLICATE_COMMAND", "cause": "A command with the given command id has already been successfully processed", "errorCategory": 10}
IN_FLIGHT = {"code": "SUBMISSION_ALREADY_IN_FLIGHT", "cause": "Another command with the same change id is being processed"}
BAD = {"code": "INVALID_ARGUMENT", "cause": "bad command"}
OK = {"completionOffset": 7}
COMMAND = {"CreateCommand": {"templateId": canton.TOKEN, "createArguments": {}}}


class FakeParticipant(http.server.BaseHTTPRequestHandler):
    answers: list = []   # (status, body) for each try, in turn; "stall" holds the request until the client gives up
    bodies: list = []    # the request body of each try
    reads: list = []     # the request body of each completions read
    gets: list = []      # the path of each GET
    completions = []     # the completions answer (a list, or a function of beginExclusive)

    def log_message(self, *args):
        pass

    def do_GET(self):
        FakeParticipant.gets.append(self.path)
        self.reply(200, {"offset": 5})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        if self.path.startswith("/v2/commands/completions"):
            FakeParticipant.reads.append(body)
            return self.reply(200, FakeParticipant.completions(body["beginExclusive"]) if callable(FakeParticipant.completions) else FakeParticipant.completions)
        FakeParticipant.bodies.append(body)
        status, answer = FakeParticipant.answers[min(len(FakeParticipant.bodies), len(FakeParticipant.answers)) - 1]
        self.reply(status, answer)

    def reply(self, status, body):
        text = isinstance(body, str)
        data = (body if text else json.dumps(body)).encode()
        self.send_response(status); self.send_header("content-type", "text/plain" if text else "application/json")
        self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)


class SubmitRetryTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        state = Path(tmp.name)
        (state / "canton").mkdir()
        (state / "canton" / "parties.env").write_text("U_PARTY=u::1\nREGISTRY_PARTY=rg::1\n")
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeParticipant)
        threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        env = {"CZE_STATE_DIR": str(state), "CZE_CANTON": "local", "CZE_USERS_LEDGER_URL": f"http://127.0.0.1:{server.server_address[1]}"}
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        FakeParticipant.bodies, FakeParticipant.reads, FakeParticipant.gets, FakeParticipant.completions = [], [], [], []
        sleep = mock.patch.object(canton.time, "sleep")
        self.sleeps = sleep.start()
        self.addCleanup(sleep.stop)
        self.net = canton.Network()

    def submit(self, answers, command=COMMAND):
        FakeParticipant.answers = answers
        return self.net.submit("users", ["u"], command)

    def completed(self, status=None):
        """The completions answer that holds this command's completion (the id the last try sent), with an offset checkpoint after it."""
        done = {"commandId": self.ids()[0] if self.ids() else None, "offset": 6, "updateId": "u1"}
        if status:
            done["status"] = status
        return [{"completionResponse": {"Completion": {"value": done}}}, {"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 7}}}}]

    def ids(self):
        return [b["commandId"] for b in FakeParticipant.bodies]

    def test_a_503_then_success_sends_the_same_command_again(self):
        self.assertEqual(self.submit([(503, TIMEOUT_503), (200, OK)]), OK)
        self.assertEqual(len(FakeParticipant.bodies), 2)
        self.assertEqual(FakeParticipant.bodies[0], FakeParticipant.bodies[1])
        self.sleeps.assert_called_once_with(canton.SUBMIT_RETRY_WAITS[0])

    def test_a_503_then_a_duplicate_counts_as_committed(self):
        self.assertEqual(self.submit([(503, TIMEOUT_503), (409, DUPLICATE)]), {"duplicate": True})
        self.assertEqual(len(set(self.ids())), 1)

    def test_a_503_every_time_fails_after_the_bounded_tries_with_the_message(self):
        with self.assertRaises(canton.Refused) as raised:
            self.submit([(503, TIMEOUT_503)])
        self.assertEqual(len(FakeParticipant.bodies), len(canton.SUBMIT_RETRY_WAITS) + 1)
        self.assertEqual(len(set(self.ids())), 1)
        self.assertIn("503", str(raised.exception))
        self.assertIn("not able to produce a timely response", str(raised.exception))
        self.assertEqual([c.args[0] for c in self.sleeps.call_args_list], list(canton.SUBMIT_RETRY_WAITS))

    def test_the_503_with_a_json_body_is_retried_too(self):
        self.assertEqual(self.submit([(503, JSON_503), (200, OK)]), OK)
        self.assertEqual(len(FakeParticipant.bodies), 2)

    def test_the_plain_text_503_is_retried_and_its_message_kept(self):
        with self.assertRaises(canton.Refused) as raised:
            self.submit([(503, TIMEOUT_TEXT)])
        self.assertEqual(len(FakeParticipant.bodies), len(canton.SUBMIT_RETRY_WAITS) + 1)
        self.assertIsNone(raised.exception.code)
        self.assertEqual(raised.exception.status, 503)
        self.assertIn("not able to produce a timely response", str(raised.exception))

    def test_a_503_then_contract_not_found_with_a_completion_counts_as_committed(self):
        FakeParticipant.answers = [(503, TIMEOUT_503), (404, NOT_FOUND)]
        FakeParticipant.completions = lambda begin: self.completed()
        self.assertEqual(self.net.submit("users", ["u"], COMMAND), {"duplicate": True})
        self.assertEqual(len(FakeParticipant.bodies), 2)
        self.assertEqual(len(FakeParticipant.reads), 1)
        read = FakeParticipant.reads[0]
        self.assertEqual((read["beginExclusive"], read["userId"], read["parties"]), (5, "demo", ["u::1"]))
        self.assertEqual(FakeParticipant.gets, ["/v2/state/ledger-end"])

    def test_a_503_then_contract_not_found_without_a_completion_raises_the_404(self):
        FakeParticipant.completions = [{"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 7}}}}]
        with self.assertRaises(canton.Refused) as raised:
            self.submit([(503, TIMEOUT_503), (404, NOT_FOUND)])
        self.assertEqual(raised.exception.status, 404)
        self.assertEqual(raised.exception.code, "CONTRACT_NOT_FOUND")
        self.assertEqual(len(FakeParticipant.reads), 1)

    def test_a_failed_completion_raises_the_error(self):
        FakeParticipant.answers = [(503, TIMEOUT_503), (404, NOT_FOUND)]
        FakeParticipant.completions = lambda begin: self.completed({"code": 5, "message": "contract not found"})
        with self.assertRaises(canton.Refused):
            self.net.submit("users", ["u"], COMMAND)

    def test_tries_that_run_out_on_a_503_read_the_completion(self):
        FakeParticipant.completions = lambda begin: self.completed()
        self.assertEqual(self.submit([(503, TIMEOUT_503)]), {"duplicate": True})
        self.assertEqual(len(FakeParticipant.bodies), len(canton.SUBMIT_RETRY_WAITS) + 1)
        self.assertEqual(len(FakeParticipant.reads), 1)

    def test_tries_that_run_out_in_flight_read_the_completion(self):
        FakeParticipant.completions = lambda begin: self.completed()
        self.assertEqual(self.submit([(503, TIMEOUT_503)] + [(409, IN_FLIGHT)] * 3), {"duplicate": True})
        self.assertEqual(len(FakeParticipant.reads), 1)

    def test_tries_that_run_out_in_flight_with_no_completion_raise(self):
        with self.assertRaises(canton.Refused) as raised:
            self.submit([(503, TIMEOUT_503)] + [(409, IN_FLIGHT)] * 3)
        self.assertEqual(raised.exception.code, "SUBMISSION_ALREADY_IN_FLIGHT")

    def test_a_completions_read_that_fails_raises_the_original_error(self):
        FakeParticipant.completions = "not a list"
        with self.assertRaises(canton.Refused) as raised:
            self.submit([(503, TIMEOUT_503), (404, NOT_FOUND)])
        self.assertEqual(raised.exception.status, 404)

    def test_a_full_page_without_the_command_is_followed_by_the_next(self):
        pages = {5: [{"completionResponse": {"OffsetCheckpoint": {"value": {"offset": 9}}}}] * canton.COMPLETION_LIMIT}
        FakeParticipant.completions = lambda begin: pages.get(begin) or self.completed()
        self.assertEqual(self.submit([(503, TIMEOUT_503), (404, NOT_FOUND)]), {"duplicate": True})
        self.assertEqual([r["beginExclusive"] for r in FakeParticipant.reads], [5, 9])

    def test_a_400_is_not_retried(self):
        with self.assertRaises(canton.Refused) as raised:
            self.submit([(400, BAD)])
        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(len(FakeParticipant.bodies), 1)
        self.assertEqual(FakeParticipant.reads, [])
        self.sleeps.assert_not_called()

    def test_a_duplicate_on_the_first_try_is_an_error(self):
        with self.assertRaises(canton.Refused):
            self.submit([(409, DUPLICATE)])
        self.assertEqual(len(FakeParticipant.bodies), 1)

    def test_a_try_still_in_flight_is_waited_for(self):
        self.assertEqual(self.submit([(503, TIMEOUT_503), (409, IN_FLIGHT), (409, DUPLICATE)]), {"duplicate": True})
        self.assertEqual(len(FakeParticipant.bodies), 3)

    def test_the_command_id_is_the_same_on_every_try_and_new_for_each_command(self):
        self.submit([(503, TIMEOUT_503), (503, TIMEOUT_503), (200, OK)])
        first = self.ids()
        self.assertEqual(len(first), 3)
        self.assertEqual(len(set(first)), 1)
        FakeParticipant.bodies = []
        self.submit([(503, TIMEOUT_503), (200, OK)])
        self.assertEqual(len(set(self.ids())), 1)
        self.assertNotEqual(self.ids()[0], first[0])

    def test_a_read_timeout_of_the_request_is_sent_again_with_the_same_id(self):
        real = canton.urllib.request.urlopen
        calls = []

        def urlopen(request, timeout=None):
            calls.append(json.loads(request.data)["commandId"])
            if len(calls) == 1:
                raise TimeoutError("timed out")
            return real(request, timeout=timeout)
        with mock.patch.object(canton.urllib.request, "urlopen", urlopen):
            self.assertEqual(self.submit([(200, OK)]), OK)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])

    def test_a_refused_connection_is_not_retried(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        self.net.urls["users"] = f"http://127.0.0.1:{port}"
        with self.assertRaises(canton.urllib.error.URLError):
            self.submit([(200, OK)])
        self.sleeps.assert_not_called()


if __name__ == "__main__":
    unittest.main()
