"""The accounts service on a real participant (run by integration.sh, which starts Canton, the service and a user with no rights).
An Ed25519 key is made here with openssl, and it is the only thing that signs: an external party is allocated from it, then a WithdrawalAcceptance of the
chain package is created for that party through prepare, a signature and execute; the contract is read back, and the holdings are listed."""
import base64, hashlib, json, os, struct, subprocess, sys, tempfile, time, unittest, urllib.error, urllib.parse, urllib.request
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "network" / "canton"))
sys.path.insert(0, str(ROOT / "demo"))
import propose
import canton as demo   # the demo's helpers (CZE_CANTON=external): the test token's rules and a holding of U's, read with the demo user's token

SERVICE, LEDGER, USER = os.environ["ACCOUNTS_URL"], os.environ["CZE_LEDGER_URL"], os.environ["ACCOUNTS_USER"]
ACCEPTANCE = "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"
DEPOSIT, REDEEM, TWIN_ACCEPTANCE = "#canton-zk-evm:Zk.Chain:DepositRequest", "#canton-zk-evm:Zk.Chain:RedeemRequest", "#ostia-twin:Twin.Twin:TwinAcceptance"


def call(method, url, body=None, bearer=None, key=None):
    data = None if body is None else json.dumps(body).encode()
    headers = {"X-Account-Signature": key.account_signature(method, urllib.parse.urlsplit(url).path, data or b"")} if key else {}
    request = urllib.request.Request(url, data, {"content-type": "application/json", **propose.auth(bearer), **headers}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=120) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        with e:
            return e.code, json.loads(e.read() or b"{}")


def service(path, body=None, key=None):
    """A call to the service; with a key, it carries the account's signature of the request (X-Account-Signature)."""
    return call("GET" if body is None else "POST", SERVICE + path, body, key=key)


class Key:
    """An Ed25519 key pair in a temporary directory, made and used with the openssl program."""
    def __init__(self, folder):
        self.pem = os.path.join(folder, "key.pem")
        subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", self.pem], check=True, capture_output=True)
        # the 44 bytes of the DER form (the X.509 SubjectPublicKeyInfo) of the public key
        self.public = subprocess.run(["openssl", "pkey", "-in", self.pem, "-pubout", "-outform", "DER"], check=True, capture_output=True).stdout
        self.folder, self.used = folder, set()

    def sign_bytes(self, data: bytes) -> bytes:
        message, out = os.path.join(self.folder, "message"), os.path.join(self.folder, "signature")
        Path(message).write_bytes(data)
        subprocess.run(["openssl", "pkeyutl", "-sign", "-inkey", self.pem, "-rawin", "-in", message, "-out", out], check=True, capture_output=True)
        return Path(out).read_bytes()

    def sign(self, message_b64: str) -> str:
        """The signature of the bytes that a base64 hash stands for: 64 bytes, in base64."""
        return base64.b64encode(self.sign_bytes(base64.b64decode(message_b64))).decode()

    def account_signature(self, method: str, path: str, body: bytes) -> str:
        """The X-Account-Signature value: `<unix seconds>.<base64 signature>` over accounts-v1, method, path, the body's sha256 and the seconds, each on a line.
        A request that is the same as an earlier one takes an earlier second, as the service accepts each signature once."""
        now = int(time.time())
        seconds = next(t for t in range(now, now - 50, -1) if (method, path, body, t) not in self.used)
        self.used.add((method, path, body, seconds))
        message = f"accounts-v1\n{method}\n{path}\n{hashlib.sha256(body).hexdigest()}\n{seconds}"
        return f"{seconds}.{base64.b64encode(self.sign_bytes(message.encode())).decode()}"


class AccountsOnCanton(unittest.TestCase):
    def test_an_account_from_its_own_key_creates_a_withdrawal_acceptance(self):
        self.assertEqual(service("/healthz")[1]["ok"], True)
        with tempfile.TemporaryDirectory() as folder:
            key = Key(folder)
            public = base64.b64encode(key.public).decode()
            # The account: the page's key signs the topology's hash.
            status, topology = service("/accounts/v1/topology", {"publicKey": public})
            self.assertEqual(status, 200, topology)
            party = topology["party"]
            self.assertTrue(party.startswith("bridge::1220"), party)
            # Canton's fingerprint of the key: the hash (purpose 12, hash prefix 1220) of the key's 32 raw bytes; the party is the hint and the fingerprint.
            raw = key.public[-32:]
            self.assertEqual(party, "bridge::1220" + hashlib.sha256(struct.pack(">i", 12) + raw).hexdigest())
            self.assertTrue(topology["topologyTransactions"] and topology["multiHash"])
            participant = call("GET", f"{LEDGER}/v2/parties/participant-id", bearer=propose.role_token("admin"))[1]["participantId"]
            print("FIXTURE " + json.dumps({"name": "topology", "party": party, "publicKey": base64.b64encode(raw).decode(), "participant": participant,
                                           "multiHash": topology["multiHash"], "topologyTransactions": topology["topologyTransactions"]}, sort_keys=True), flush=True)
            status, made = service("/accounts/v1/allocate", {"blob": topology["blob"], "signature": key.sign(topology["multiHash"])})
            self.assertEqual((status, made), (200, {"party": party, "created": True}), made)
            self.assertEqual(service("/accounts/v1/topology", {"publicKey": public})[1], {"party": party, "exists": True})   # the same key: the same account
            self.assertEqual(service(f"/accounts/v1/holdings/{party}", key=key), (200, {"party": party, "holdings": []}))
            self.assertEqual(service(f"/accounts/v1/allocations/{party}", key=key), (200, {"party": party, "allocations": []}))
            self.assertEqual(service(f"/accounts/v1/open/{party}", key=key), (200, {"party": party, "depositRequests": [], "redeemRequests": []}))

            # The service's user has the right to act as this party, and no more than that: no admin right.
            _, rights = call("GET", f"{LEDGER}/v2/users/{USER}/rights", bearer=propose.role_token("admin"))
            held = {(k, (b.get("value") or {}).get("party")) for r in rights["rights"] for k, b in r["kind"].items()}
            self.assertIn(("CanActAs", party), held)
            self.assertEqual({p for _, p in held}, {party}, held)   # no right on any other party, and no admin right (an admin right has no party)

            # A command off the list is refused before the participant sees it.
            status, refused = service("/accounts/v1/prepare", {"party": party, "commands": [{"CreateCommand": {"templateId": "#canton-zk-evm:Zk.Chain:ZkChain", "createArguments": {}}}]}, key)
            self.assertEqual(status, 403, refused)

            # The acceptance: prepare, sign the hash, execute. Its fields are the chain's.
            parties = propose.read_env_file(Path(os.environ["CZE_STATE_DIR"]) / "canton" / "parties.env")
            builder = propose.Ledger(LEDGER, propose.user_id("builder"), parties["BUILDER_PARTY"], token=propose.role_token("builder"))
            [chain] = builder.active("ZkChain")
            arguments = {"party": party, "chainId": chain["chainId"], "operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"]}
            status, prepared = service("/accounts/v1/prepare", {"party": party, "commands": [{"CreateCommand": {"templateId": ACCEPTANCE, "createArguments": arguments}}]}, key)
            self.assertEqual(status, 200, prepared)
            body = {"preparedTransaction": prepared["preparedTransaction"], "partySignatures": [{"party": party, "signature": key.sign(prepared["preparedTransactionHash"])}]}

            # A signature of another key is refused by the service itself (401, where the participant's refusal would be 422), and nothing reaches the participant:
            # the account has no acceptance, and the same prepared transaction is still there for the right key.
            with tempfile.TemporaryDirectory() as other:
                wrong = {**body, "partySignatures": [{"party": party, "signature": Key(other).sign(prepared["preparedTransactionHash"])}]}
            status, refused = service("/accounts/v1/execute", wrong, key)
            self.assertEqual(status, 401, refused)
            self.assertEqual([c for c in builder.active("WithdrawalAcceptance") if c["party"] == party], [])

            status, done = service("/accounts/v1/execute", body, key)
            self.assertEqual(status, 200, done)
            self.assertTrue(done["updateId"])

            # The builder, an observer, sees the contract the account's key made.
            deadline = time.time() + 60
            while time.time() < deadline and not [c for c in builder.active("WithdrawalAcceptance") if c["party"] == party]:
                time.sleep(1)
            self.assertEqual(len([c for c in builder.active("WithdrawalAcceptance") if c["party"] == party]), 1)

            # One acceptance per account: the service finds the first in the account's own contracts and refuses a second.
            status, again = service("/accounts/v1/prepare", {"party": party, "commands": [{"CreateCommand": {"templateId": ACCEPTANCE, "createArguments": arguments}}]}, key)
            self.assertEqual(status, 409, again)

            # An account-scoped call without the account's signature is refused.
            for what in ("holdings", "allocations", "open"):
                self.assertEqual(service(f"/accounts/v1/{what}/{party}")[0], 401, what)

            def run(command, disclosed=()):
                """Prepares the command; gives the prepared transaction and a function that signs it and executes it."""
                status, made = service("/accounts/v1/prepare", {"party": party, "commands": [command], "disclosedContracts": list(disclosed)}, key)
                self.assertEqual(status, 200, made)
                return made, lambda: service("/accounts/v1/execute", {"preparedTransaction": made["preparedTransaction"], "partySignatures": [{"party": party, "signature": key.sign(made["preparedTransactionHash"])}]}, key)

            def fixture(name, command, made, **more):
                print("FIXTURE " + json.dumps({"name": name, "party": party, "command": command, "preparedTransaction": made["preparedTransaction"], "preparedTransactionHash": made["preparedTransactionHash"],
                                               "hashingSchemeVersion": made["hashingSchemeVersion"], **more}, sort_keys=True), flush=True)

            def until(what, find):
                deadline = time.time() + 90
                while time.time() < deadline:
                    found = find()
                    if found:
                        return found
                    time.sleep(4)
                self.fail(f"timed out waiting for {what}")

            # An exercise on the account's own contract: the Archive of its acceptance, prepared and not executed.
            [acceptance] = [c for c in builder.active("WithdrawalAcceptance") if c["party"] == party]
            archive = {"ExerciseCommand": {"templateId": ACCEPTANCE, "contractId": acceptance["contractId"], "choice": "Archive", "choiceArgument": {}}}
            made_archive, _ = run(archive)
            fixture("exercise-archive", archive, made_archive)
            fixture("create-acceptance", {"CreateCommand": {"templateId": ACCEPTANCE, "createArguments": arguments}}, prepared)

            # A holding of the account's own: U (a party on this participant, with 100 of the test token) sends 40 through the token standard, and the account accepts the offer.
            net = demo.Network()
            registry, u, disclosed = net.party("registry"), net.party("u"), demo.read_disclosed(net)
            offers = {e["contractId"] for e in net.template("users", "registry", demo.TRANSFER_OFFER)}
            transfer = {"sender": u, "receiver": party, "amount": "40.0", "instrumentId": {"admin": registry, "id": demo.INSTRUMENT}, "requestedAt": demo.utc(timedelta(minutes=-1)),
                        "executeBefore": demo.utc(timedelta(hours=1)), "inputHoldingCids": [e["contractId"] for e in net.template("users", "u", demo.TOKEN)], "meta": {"values": {}}}
            net.submit("users", ["u"], {"ExerciseCommand": {"templateId": demo.TRANSFER_FACTORY, "contractId": disclosed[0]["contractId"], "choice": "TransferFactory_Transfer",
                                                           "choiceArgument": {"expectedAdmin": registry, "transfer": transfer, "extraArgs": demo.NO_EXTRA_ARGS}}}, disclosed)
            [offer] = net.wait_for("the offer", lambda: [e["contractId"] for e in net.template("users", "registry", demo.TRANSFER_OFFER) if e["contractId"] not in offers])
            _, execute_accept = run({"ExerciseCommand": {"templateId": demo.TRANSFER_INSTRUCTION, "contractId": offer, "choice": "TransferInstruction_Accept", "choiceArgument": {"extraArgs": demo.NO_EXTRA_ARGS}}})
            self.assertEqual(execute_accept()[0], 200)
            [holding] = until("the holding", lambda: service(f"/accounts/v1/holdings/{party}", key=key)[1]["holdings"])
            self.assertEqual((holding["instrumentId"], float(holding["amount"]), holding["locked"]), ({"admin": registry, "id": demo.INSTRUMENT}, 40.0, False))

            # AllocationFactory_Allocate: the account locks 5 for the gateway (the operator executes), with the registry's rules as a disclosed contract.
            requested, label = demo.utc(timedelta(minutes=-1)), "integration"
            spec = {"settlement": {"executor": arguments["operator"], "settlementRef": {"id": label, "cid": None}, "requestedAt": requested, "allocateBefore": demo.utc(timedelta(hours=1)),
                                   "settleBefore": demo.utc(timedelta(hours=2)), "meta": {"values": {}}}, "transferLegId": "leg-" + label,
                    "transferLeg": {"sender": party, "receiver": arguments["gateway"], "amount": "5.0", "instrumentId": {"admin": registry, "id": demo.INSTRUMENT}, "meta": {"values": {}}}}
            allocate = {"ExerciseCommand": {"templateId": demo.ALLOCATION_FACTORY, "contractId": disclosed[0]["contractId"], "choice": "AllocationFactory_Allocate", "choiceArgument": {
                "expectedAdmin": registry, "allocation": spec, "requestedAt": requested, "inputHoldingCids": [holding["contractId"]], "extraArgs": demo.NO_EXTRA_ARGS}}}
            made_allocate, execute_allocate = run(allocate, disclosed)
            fixture("exercise-allocate", allocate, made_allocate, disclosedContracts=disclosed)
            self.assertEqual(execute_allocate()[0], 200)
            [allocation] = until("the allocation", lambda: service(f"/accounts/v1/allocations/{party}", key=key)[1]["allocations"])
            self.assertEqual((allocation["allocation"]["settlement"]["settlementRef"]["id"], allocation["allocation"]["transferLeg"]["sender"]), (label, party))

            # A DepositRequest names the allocation's committed contract id (a contract id is longer than 128 characters, and the service's checks and the participant's pass it).
            self.assertGreater(len(allocation["contractId"]), 128)
            deposit = {k: arguments[k] for k in ("chainId", "operator", "confirmer", "gateway", "builder")}
            deposit.update(depositor=party, depositId=hashlib.sha256(f"deposit,{party},{label}".encode()).hexdigest(), recipient="ab" * 20, allocation=allocation["contractId"], label=label)
            create_deposit = {"CreateCommand": {"templateId": DEPOSIT, "createArguments": deposit}}
            made_deposit, execute_deposit = run(create_deposit)
            fixture("create-deposit-request", create_deposit, made_deposit)
            self.assertEqual(execute_deposit()[0], 200)

            # A RedeemRequest and a TwinAcceptance, each made by the account's key and executed.
            redeem = {"holder": party, "operator": arguments["operator"], "confirmer": arguments["confirmer"], "gateway": arguments["gateway"], "builder": arguments["builder"], "chainId": arguments["chainId"],
                      "token": "ab" * 20, "holdings": [holding["contractId"]], "amount": "1.5", "recipient": "cd" * 20, "ref": "redeem-1"}
            create_redeem = {"CreateCommand": {"templateId": REDEEM, "createArguments": redeem}}
            made_redeem, execute_redeem = run(create_redeem)
            fixture("create-redeem-request", create_redeem, made_redeem)
            self.assertEqual(execute_redeem()[0], 200)
            twin = {"CreateCommand": {"templateId": TWIN_ACCEPTANCE, "createArguments": {"party": party, "admin": arguments["gateway"]}}}
            made_twin, execute_twin = run(twin)
            fixture("create-twin-acceptance", twin, made_twin)
            self.assertEqual(execute_twin()[0], 200)

            # What the page reads to resume: the allocation by its contract id, the open requests by theirs.
            opened = until("the open requests", lambda: (lambda o: o if o["depositRequests"] and o["redeemRequests"] else None)(service(f"/accounts/v1/open/{party}", key=key)[1]))
            self.assertEqual((opened["depositRequests"][0]["arguments"]["allocation"], opened["redeemRequests"][0]["arguments"]["ref"]), (allocation["contractId"], "redeem-1"))
            print("FIXTURE " + json.dumps({"name": "answers", "party": party, "allocations": service(f"/accounts/v1/allocations/{party}", key=key)[1], "open": opened}, sort_keys=True), flush=True)
            self.assertEqual(service("/accounts/v1/holdings/nobody::1220" + "0" * 64)[0], 404)   # a party the service did not make


if __name__ == "__main__":
    unittest.main()
