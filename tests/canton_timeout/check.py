"""One participant stops answering: what Canton's rejection of a command that needs it says, and what the builder reads from it. Needs the nodes of tests/canton_timeout.sh
running; argv: the work folder, the pid of the silent participant's process. Prints "ok: ..." for each check and exits 1 at the first that fails."""
import json, os, signal, sys, time, urllib.error, urllib.request, uuid
from pathlib import Path

WORK, SILENT_PID = Path(sys.argv[1]), int(sys.argv[2])
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "builder"))
import builder as b

SUB = (WORK / "submitter.id").read_text().strip()
ONE, TWO = (WORK / "silent.ids").read_text().split()
SILENT_API, SUB_API = 7575, 7576


def post(port, path, body, timeout=120):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", json.dumps(body).encode(), {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.read().decode()


def fail(text):
    print("FAIL:", text, file=sys.stderr)
    raise SystemExit(1)


def propose(template, args):
    """The silent participant's parties create the proposal; returns its contract id once the submitter's participant shows it."""
    command = {"CreateCommand": {"templateId": f"#timeout-probe:Probe:{template}", "createArguments": args}}
    status, text = post(SILENT_API, "/v2/commands/submit-and-wait-for-transaction",
                        {"commands": {"commands": [command], "commandId": str(uuid.uuid4()), "userId": "sil", "actAs": [ONE, TWO]}})
    if status != 200:
        fail(f"the proposal was refused: {status} {text[:300]}")
    cid = json.loads(text)["transaction"]["events"][0]["CreatedEvent"]["contractId"]
    seen = {"contractId": cid, "eventFormat": {"filtersByParty": {SUB: {"cumulative": [{"wildcardFilter": {"value": {"includeCreatedEventBlob": False}}}]}}, "verbose": False}}
    for _ in range(100):
        if post(SUB_API, "/v2/events/events-by-contract-id", seen)[0] == 200:
            return cid
        time.sleep(0.2)
    fail("the submitter's participant never showed the proposal")


def accept(cid, template, choice):
    command_id = str(uuid.uuid4())
    command = {"ExerciseCommand": {"templateId": f"#timeout-probe:Probe:{template}", "contractId": cid, "choice": choice, "choiceArgument": {}}}
    status, text = post(SUB_API, "/v2/commands/submit-and-wait", {"commands": [command], "commandId": command_id, "userId": "sub", "actAs": [SUB]})
    return command_id, status, text


def completion_of(command_id):
    """The command's completion as the builder reads it (`completion_in`)."""
    for _ in range(30):
        status, text = post(SUB_API, "/v2/commands/completions?limit=100&stream_idle_timeout_ms=1000", {"userId": "sub", "parties": [SUB], "beginExclusive": 0})
        found = b.completion_in(json.loads(text), command_id)[0] if status == 200 else None
        if found:
            return found
        time.sleep(1)
    fail("no completion")


# 1. With the silent participant answering, the choice commits.
status = accept(propose("Proposal", {"a": ONE, "b": SUB}), "Proposal", "Accept")[1]
if status != 200:
    fail(f"the choice did not commit while the participant answered: {status}")
print("ok: the choice commits while the participant answers")

# 2. With it stopped (SIGSTOP: the process answers nothing, as a participant that is offline or too slow), the mediator times out, and the rejection names the
#    parties of that participant that were to confirm: in the JSON API's answer and in the command's completion.
for label, template, args, choice, expected in (("one party", "Proposal", {"a": ONE, "b": SUB}, "Accept", [ONE]),
                                                ("two parties", "Proposal2", {"a": ONE, "c": TWO, "b": SUB}, "Accept2", sorted([ONE, TWO]))):
    cid = propose(template, args)
    os.kill(SILENT_PID, signal.SIGSTOP)
    try:
        command_id, status, text = accept(cid, template, choice)
        found = completion_of(command_id)
    finally:
        os.kill(SILENT_PID, signal.SIGCONT)
    if status != 409 or b.timeout_code(text) != b.MEDIATOR_TIMEOUT:
        fail(f"{label}: the rejection is not the mediator's timeout: {status} {text[:400]}")
    named = b.unresponsive_of_body(text)
    if sorted(named or []) != expected:
        fail(f"{label}: the rejection's context names {named}, not {expected}: {text[:600]}")
    if found["committed"] or b.timeout_code(found["reason"]) != b.MEDIATOR_TIMEOUT or sorted(found.get("unresponsive") or []) != expected:
        fail(f"{label}: the completion does not name {expected}: {found}")
    print(f"ok: {label}: the timeout's rejection and completion name {expected}")
    time.sleep(2)   # the participant is back before the next round
