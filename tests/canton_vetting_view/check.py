"""Does Canton check package vetting per view? Needs the nodes of tests/canton_vetting_view.sh running; argv: the work folder.
Rome takes a pending token-standard transfer from a user, with a choice of a package the user's participant has not vetted. The choice's own view is Rome's alone;
the token's accept is a view of its own that the user's participant takes part in. Once in one transaction (`Intake.Accept`), once as two (the accept, then `Record`).
A user whose participant has vetted the probe package is the control. Prints "ok: ..." for each check, and exits 1 at the first check that fails, including the question itself: vetting is checked per view."""
import json, os, sys, time, urllib.error, urllib.request, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

WORK = Path(sys.argv[1])
ROME = (WORK / "rome.id").read_text().strip()
USERS = {name: (user, admin) for name, user, admin in (line.split() for line in (WORK / "users.ids").read_text().splitlines())}
API = {"rome": 7576, "lacking": 7575, "vetted": 7577}
TOKENS = "#splice-test-token-v1:Splice.Testing.Tokens.TestTokenV1"
FACTORY = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory"
INSTRUCTION = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction"
PROBE = "#vetting-probe:Vetting"
NO_EXTRA = {"context": {"values": {}}, "meta": {"values": {}}}


def fail(text):
    print("FAIL:", text, file=sys.stderr)
    raise SystemExit(1)


def post(port, path, body, timeout=180):
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", json.dumps(body).encode(), {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.read().decode()


def submit(node, command, party_ids):
    user = "rom" if node == "rome" else node
    return post(API[node], "/v2/commands/submit-and-wait-for-transaction",
                {"commands": {"commands": [command], "commandId": str(uuid.uuid4()), "userId": user, "actAs": party_ids}})


def created(text, template):
    """The contract id of the created event of `template` (a name without its package) in a transaction's answer."""
    for event in json.loads(text)["transaction"]["events"]:
        made = event.get("CreatedEvent")
        if made and made["templateId"].split(":", 1)[1] == template:
            return made["contractId"]
    fail(f"no {template} was created: {text[:300]}")


def must(node, command, party_ids, what):
    status, text = submit(node, command, party_ids)
    if status != 200:
        fail(f"{what} was refused: {status} {text[:500]}")
    return text


def seen_by_rome(cid):
    body = {"contractId": cid, "eventFormat": {"filtersByParty": {ROME: {"cumulative": [{"wildcardFilter": {"value": {"includeCreatedEventBlob": False}}}]}}, "verbose": False}}
    for _ in range(100):
        if post(API["rome"], "/v2/events/events-by-contract-id", body)[0] == 200:
            return cid
        time.sleep(0.2)
    fail("Rome's participant never showed the offer")


def token_rules(node):
    """The token's rules, signed by the admin party that the user's participant hosts."""
    admin = USERS[node][1]
    return created(must(node, {"CreateCommand": {"templateId": f"{TOKENS}:TokenRules", "createArguments": {"admin": admin}}}, [admin], "the token rules"), "Splice.Testing.Tokens.TestTokenV1:TokenRules")


def make_offer(node, rules):
    """A holding of 1.0 for the user, transferred to Rome: returns the pending offer once Rome's participant shows it."""
    user, admin = USERS[node]
    holding = created(must(node, {"CreateCommand": {"templateId": f"{TOKENS}:Token", "createArguments": {"holding": {
        "owner": user, "instrumentId": {"admin": admin, "id": "VET"}, "amount": "1.0", "lock": None, "meta": {"values": {}}}}}}, [user, admin], "a holding"), "Splice.Testing.Tokens.TestTokenV1:Token")
    now = datetime.now(timezone.utc)
    transfer = {"sender": user, "receiver": ROME, "amount": "1.0", "instrumentId": {"admin": admin, "id": "VET"}, "requestedAt": (now - timedelta(minutes=1)).isoformat(),
                "executeBefore": (now + timedelta(hours=1)).isoformat(), "inputHoldingCids": [holding], "meta": {"values": {}}}
    text = must(node, {"ExerciseCommand": {"templateId": FACTORY, "contractId": rules, "choice": "TransferFactory_Transfer",
                                           "choiceArgument": {"expectedAdmin": admin, "transfer": transfer, "extraArgs": NO_EXTRA}}}, [user, admin], "the transfer")
    return seen_by_rome(created(text, "Splice.Testing.Tokens.TestTokenV1:TokenTransferOffer"))


def accept_in_one(node, intake, offer):
    return submit("rome", {"ExerciseCommand": {"templateId": f"{PROBE}:Intake", "contractId": intake, "choice": "Accept",
                                               "choiceArgument": {"instruction": offer, "extraArgs": NO_EXTRA, "user": USERS[node][0]}}}, [ROME])


intake = created(must("rome", {"CreateCommand": {"templateId": f"{PROBE}:Intake", "createArguments": {"rome": ROME}}}, [ROME], "the intake"), "Vetting:Intake")
rules = {node: token_rules(node) for node in ("lacking", "vetted")}

# 1. Control: the user's participant has vetted the probe package, so the accept and the record commit as one transaction.
status, text = accept_in_one("vetted", intake, make_offer("vetted", rules["vetted"]))
if status != 200:
    fail(f"the one-transaction accept failed although the user's participant has the probe package: {status} {text[:500]}")
print("ok: the one-transaction accept commits where the user's participant has vetted the package")

# 2. Two transactions: the token's accept alone (no package of Rome's in it), then the record alone. Works whatever the answer.
offer = make_offer("lacking", rules["lacking"])
must("rome", {"ExerciseCommand": {"templateId": INSTRUCTION, "contractId": offer, "choice": "TransferInstruction_Accept", "choiceArgument": {"extraArgs": NO_EXTRA}}}, [ROME], "the accept alone")
must("rome", {"ExerciseCommand": {"templateId": f"{PROBE}:Intake", "contractId": intake, "choice": "Record", "choiceArgument": {"user": USERS["lacking"][0]}}}, [ROME], "the record alone")
print("ok: the two-transaction form commits where the user's participant lacks the probe package")

# 3. The question: one transaction, the user's participant lacks the probe package. Canton checks vetting per view, so it commits: the one-transaction
# intake does not need the user's participant to have vetted Rome's package.
status, text = accept_in_one("lacking", intake, make_offer("lacking", rules["lacking"]))
if status != 200:
    fail(f"one transaction was refused where the user's participant lacks the probe package, so vetting is not checked per view: {status} {text[:500]}")
print("ok: one transaction, user's participant without the probe package: committed")
print("RESULT: package vetting is checked per view: the user participant needs only the packages of its own views")
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    Path(summary).open("a").write("Package vetting per view: **yes**\n")
