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
ALLOCATION_INTERFACE = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation"
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
            print("FIXTURE " + json.dumps({"name": "topology", "party": party, "publicKey": base64.b64encode(raw).decode(), "participant": participant, "protocolVersion": int(os.environ["CANTON_PROTOCOL_VERSION"]),
                                           "multiHash": topology["multiHash"], "topologyTransactions": topology["topologyTransactions"]}, sort_keys=True), flush=True)
            status, made = service("/accounts/v1/allocate", {"blob": topology["blob"], "signature": key.sign(topology["multiHash"])})
            self.assertEqual((status, made), (200, {"party": party, "created": True}), made)
            self.assertEqual(service("/accounts/v1/topology", {"publicKey": public})[1], {"party": party, "exists": True})   # the same key: the same account
            self.assertEqual(service(f"/accounts/v1/holdings/{party}", key=key), (200, {"party": party, "holdings": []}))
            self.assertEqual(service(f"/accounts/v1/allocations/{party}", key=key), (200, {"party": party, "allocations": []}))
            self.assertEqual(service(f"/accounts/v1/open/{party}", key=key), (200, {"party": party, "depositRequests": [], "redeemRequests": [], "twinAcceptance": None, "withdrawalAcceptance": None}))

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
            # The local network has no Canton Coin: the token registry here is the test token's, behind a stand-in server (fake_registry.py, which wants the bearer token the service
            # holds). It answers as a registry does, with the test token's rules; the page's two calls go through the service, and what comes back is what the commands below use.
            answers = Path(os.environ["REGISTRY_ANSWERS"])
            factory_answer = {"factoryId": disclosed[0]["contractId"], "choiceContext": {"choiceContextData": {"values": {}}, "disclosedContracts": disclosed}}
            accept_answer = {"choiceContextData": {"values": {}}, "disclosedContracts": []}
            (answers / "allocation-factory.json").write_text(json.dumps(factory_answer))
            (answers / "accept.json").write_text(json.dumps(accept_answer))
            transfer_answer = {**factory_answer, "transferKind": "offer"}   # the test token offers a transfer: the receiver accepts it (Canton Coin does so unless the receiver has a preapproval)
            (answers / "transfer-factory.json").write_text(json.dumps(transfer_answer))
            self.assertEqual(service(f"/accounts/v1/registry/{registry}/allocation-factory", {"party": party})[0], 401)   # signed by no one
            self.assertEqual(service(f"/accounts/v1/registry/nobody::1220{'0' * 64}/allocation-factory", {"party": party}, key)[0], 404)   # an admin the service has no registry for
            self.assertEqual(service("/accounts/v1/faucet", {"party": party}, key)[0], 404)   # the faucet is off unless it is set
            offers = {e["contractId"] for e in net.template("users", "registry", demo.TRANSFER_OFFER)}
            transfer = {"sender": u, "receiver": party, "amount": "40.0", "instrumentId": {"admin": registry, "id": demo.INSTRUMENT}, "requestedAt": demo.utc(timedelta(minutes=-1)),
                        "executeBefore": demo.utc(timedelta(hours=1)), "inputHoldingCids": [e["contractId"] for e in net.template("users", "u", demo.TOKEN)], "meta": {"values": {}}}
            net.submit("users", ["u"], {"ExerciseCommand": {"templateId": demo.TRANSFER_FACTORY, "contractId": disclosed[0]["contractId"], "choice": "TransferFactory_Transfer",
                                                           "choiceArgument": {"expectedAdmin": registry, "transfer": transfer, "extraArgs": demo.NO_EXTRA_ARGS}}}, disclosed)
            [offer] = net.wait_for("the offer", lambda: [e["contractId"] for e in net.template("users", "registry", demo.TRANSFER_OFFER) if e["contractId"] not in offers])
            status, context = service(f"/accounts/v1/registry/{registry}/transfer-instruction/{offer}/accept-context", {"party": party, "meta": {}, "excludeDebugFields": True}, key)
            self.assertEqual((status, context), (200, accept_answer))
            _, execute_accept = run({"ExerciseCommand": {"templateId": demo.TRANSFER_INSTRUCTION, "contractId": offer, "choice": "TransferInstruction_Accept",
                                                         "choiceArgument": {"extraArgs": {"context": context["choiceContextData"], "meta": {"values": {}}}}}}, context["disclosedContracts"])
            self.assertEqual(execute_accept()[0], 200)
            [holding] = until("the holding", lambda: service(f"/accounts/v1/holdings/{party}", key=key)[1]["holdings"])
            self.assertEqual((holding["instrumentId"], float(holding["amount"]), holding["locked"]), ({"admin": registry, "id": demo.INSTRUMENT}, 40.0, False))

            # AllocationFactory_Allocate: the account locks 5 for the gateway (the operator executes), with the registry's rules as a disclosed contract.
            requested, label = demo.utc(timedelta(minutes=-1)), "integration"
            spec = {"settlement": {"executor": arguments["operator"], "settlementRef": {"id": label, "cid": None}, "requestedAt": requested, "allocateBefore": demo.utc(timedelta(hours=1)),
                                   "settleBefore": demo.utc(timedelta(hours=2)), "meta": {"values": {}}}, "transferLegId": "leg-" + label,
                    "transferLeg": {"sender": party, "receiver": arguments["gateway"], "amount": "5.0", "instrumentId": {"admin": registry, "id": demo.INSTRUMENT}, "meta": {"values": {}}}}
            arguments_for_factory = {"expectedAdmin": registry, "allocation": spec, "requestedAt": requested, "inputHoldingCids": [holding["contractId"]]}
            status, relayed = service(f"/accounts/v1/registry/{registry}/allocation-factory", {"party": party, "choiceArguments": arguments_for_factory, "excludeDebugFields": True}, key)
            self.assertEqual((status, relayed), (200, factory_answer))
            allocate = {"ExerciseCommand": {"templateId": demo.ALLOCATION_FACTORY, "contractId": relayed["factoryId"], "choice": "AllocationFactory_Allocate", "choiceArgument": {
                **arguments_for_factory, "extraArgs": {"context": relayed["choiceContext"]["choiceContextData"], "meta": {"values": {}}}}}}
            made_allocate, execute_allocate = run(allocate, relayed["choiceContext"]["disclosedContracts"])
            fixture("exercise-allocate", allocate, made_allocate, disclosedContracts=relayed["choiceContext"]["disclosedContracts"])
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

            # What the page reads to resume: the allocation by its contract id, the open requests and the acceptances by theirs.
            opened = until("the open requests", lambda: (lambda o: o if o["depositRequests"] and o["redeemRequests"] and o["twinAcceptance"] and o["withdrawalAcceptance"] else None)(service(f"/accounts/v1/open/{party}", key=key)[1]))
            self.assertEqual(opened["withdrawalAcceptance"]["contractId"], acceptance["contractId"])   # the acceptances, by their contract ids
            self.assertEqual(opened["twinAcceptance"]["arguments"]["party"], party)
            self.assertEqual((opened["depositRequests"][0]["arguments"]["allocation"], opened["redeemRequests"][0]["arguments"]["ref"]), (allocation["contractId"], "redeem-1"))
            # Taking a deposit back is for one that cannot settle: while its allocation's settle-before time is ahead (2 hours), the service refuses to prepare either command, for the real allocation
            # and the real request, and says when it is not for a contract the account does not have. (The settled-and-gone path reads the participant's own events and needs an allocation past its time.)
            withdraw = {"ExerciseCommand": {"templateId": ALLOCATION_INTERFACE, "contractId": allocation["contractId"], "choice": "Allocation_Withdraw",
                                            "choiceArgument": {"extraArgs": {"context": {"values": {}}, "meta": {"values": {}}}}}}
            take_back_request = {"ExerciseCommand": {"templateId": DEPOSIT, "contractId": opened["depositRequests"][0]["contractId"], "choice": "Archive", "choiceArgument": {}}}
            for what, command in (("the allocation", withdraw), ("the deposit request", take_back_request)):
                status, refused = service("/accounts/v1/prepare", {"party": party, "commands": [command]}, key)
                self.assertEqual((status, refused.get("error")), (409, "not_yet"), (what, refused))
            status, _ = service("/accounts/v1/prepare", {"party": party, "commands": [{"ExerciseCommand": {**take_back_request["ExerciseCommand"], "contractId": "00" * 40}}]}, key)
            self.assertEqual(status, 404)
            # A redeem request locks nothing, so its Archive is accepted at any time on the account's own request: prepared, signed and executed through the service, which is what a page's
            # "give this move up" and Activity's "Remove" do. (The service's allow list holds `RedeemRequest#Archive` for it: integration.sh.) Once archived it is not the account's open request any
            # more, so a second prepare, and one for a contract the account does not have, are 404.
            redeem_cid = opened["redeemRequests"][0]["contractId"]
            archive_redeem = {"ExerciseCommand": {"templateId": REDEEM, "contractId": redeem_cid, "choice": "Archive", "choiceArgument": {}}}
            _, execute_redeem_archive = run(archive_redeem)
            self.assertEqual(execute_redeem_archive()[0], 200)
            until("the redeem request to be gone", lambda: not service(f"/accounts/v1/open/{party}", key=key)[1]["redeemRequests"])
            for cid in (redeem_cid, "00" * 40):
                status, _ = service("/accounts/v1/prepare", {"party": party, "commands": [{"ExerciseCommand": {**archive_redeem["ExerciseCommand"], "contractId": cid}}]}, key)
                self.assertEqual(status, 404, cid)
            print("FIXTURE " + json.dumps({"name": "answers", "party": party, "allocations": service(f"/accounts/v1/allocations/{party}", key=key)[1], "open": opened}, sort_keys=True), flush=True)
            self.assertEqual(service("/accounts/v1/holdings/nobody::1220" + "0" * 64)[0], 404)   # a party the service did not make

            # Send on Canton: this account sends 3 of the test token to a second account (a key of its own) through the token standard's TransferFactory_Transfer, with the registry's transfer factory
            # relayed by the service, and the second account accepts the offer. Each account reads the transfer back from `transfers`, and the holdings follow.
            self.assertEqual(service("/accounts/v1/transfers/" + party)[0], 401)   # signed by no one
            self.assertEqual(service(f"/accounts/v1/transfers/{party}", key=key), (200, {"party": party, "transfers": [], "more": False}))
            with tempfile.TemporaryDirectory() as folder2:
                key2 = Key(folder2)
                topology2 = service("/accounts/v1/topology", {"publicKey": base64.b64encode(key2.public).decode()})[1]
                party2 = topology2["party"]
                self.assertEqual(service("/accounts/v1/allocate", {"blob": topology2["blob"], "signature": key2.sign(topology2["multiHash"])})[1], {"party": party2, "created": True})

                def run_as(who, signer, command, disclosed=()):
                    status, made = service("/accounts/v1/prepare", {"party": who, "commands": [command], "disclosedContracts": list(disclosed)}, signer)
                    self.assertEqual(status, 200, made)
                    return made, lambda: service("/accounts/v1/execute", {"preparedTransaction": made["preparedTransaction"], "partySignatures": [{"party": who, "signature": signer.sign(made["preparedTransactionHash"])}]}, signer)

                unlocked = [h for h in service(f"/accounts/v1/holdings/{party}", key=key)[1]["holdings"] if not h["locked"]]
                self.assertTrue(unlocked)
                before = sum(float(h["amount"]) for h in unlocked)
                sent = {"sender": party, "receiver": party2, "amount": "3.0", "instrumentId": {"admin": registry, "id": demo.INSTRUMENT}, "requestedAt": demo.utc(timedelta(minutes=-1)),
                        "executeBefore": demo.utc(timedelta(hours=1)), "inputHoldingCids": [h["contractId"] for h in unlocked], "meta": {"values": {}}}
                transfer_arguments = {"expectedAdmin": registry, "transfer": sent}
                self.assertEqual(service(f"/accounts/v1/registry/{registry}/transfer-factory", {"party": party, "choiceArguments": transfer_arguments})[0], 401)   # signed by no one
                status, factory = service(f"/accounts/v1/registry/{registry}/transfer-factory", {"party": party, "choiceArguments": {**transfer_arguments, "extraArgs": demo.NO_EXTRA_ARGS}, "excludeDebugFields": True}, key)
                self.assertEqual((status, factory), (200, transfer_answer))
                transfer = {"ExerciseCommand": {"templateId": demo.TRANSFER_FACTORY, "contractId": factory["factoryId"], "choice": "TransferFactory_Transfer", "choiceArgument": {
                    **transfer_arguments, "extraArgs": {"context": factory["choiceContext"]["choiceContextData"], "meta": {"values": {}}}}}}
                made_transfer, execute_transfer = run_as(party, key, transfer, factory["choiceContext"]["disclosedContracts"])
                fixture("exercise-transfer", transfer, made_transfer, disclosedContracts=factory["choiceContext"]["disclosedContracts"])
                self.assertEqual(execute_transfer()[0], 200)

                # The receiver sees an offer to it, the sender the same offer as its own.
                [offered] = until("the offer for the receiver", lambda: service(f"/accounts/v1/transfers/{party2}", key=key2)[1]["transfers"])
                self.assertEqual((offered["transfer"]["sender"], offered["transfer"]["receiver"], float(offered["transfer"]["amount"]), offered["transfer"]["instrumentId"]), (party, party2, 3.0, {"admin": registry, "id": demo.INSTRUMENT}))
                [own] = until("the offer for the sender", lambda: service(f"/accounts/v1/transfers/{party}", key=key)[1]["transfers"])
                self.assertEqual(own["contractId"], offered["contractId"])
                self.assertEqual(service(f"/accounts/v1/holdings/{party2}", key=key2), (200, {"party": party2, "holdings": []}))   # nothing arrives before it is accepted

                status, context = service(f"/accounts/v1/registry/{registry}/transfer-instruction/{offered['contractId']}/accept-context", {"party": party2, "meta": {}, "excludeDebugFields": True}, key2)
                self.assertEqual((status, context), (200, accept_answer))
                accept2 = {"ExerciseCommand": {"templateId": demo.TRANSFER_INSTRUCTION, "contractId": offered["contractId"], "choice": "TransferInstruction_Accept",
                                               "choiceArgument": {"extraArgs": {"context": context["choiceContextData"], "meta": {"values": {}}}}}}
                made_accept2, execute_accept2 = run_as(party2, key2, accept2, context["disclosedContracts"])
                print("FIXTURE " + json.dumps({"name": "exercise-accept", "party": party2, "command": accept2, "preparedTransaction": made_accept2["preparedTransaction"], "preparedTransactionHash": made_accept2["preparedTransactionHash"],
                                               "hashingSchemeVersion": made_accept2["hashingSchemeVersion"], "disclosedContracts": context["disclosedContracts"]}, sort_keys=True), flush=True)
                self.assertEqual(execute_accept2()[0], 200)
                [arrived] = until("the holding of the receiver", lambda: [h for h in service(f"/accounts/v1/holdings/{party2}", key=key2)[1]["holdings"] if not h["locked"]])
                self.assertEqual((arrived["instrumentId"], float(arrived["amount"])), ({"admin": registry, "id": demo.INSTRUMENT}, 3.0))
                until("the offer to be gone", lambda: not service(f"/accounts/v1/transfers/{party2}", key=key2)[1]["transfers"] and not service(f"/accounts/v1/transfers/{party}", key=key)[1]["transfers"] or None)
                after = sum(float(h["amount"]) for h in service(f"/accounts/v1/holdings/{party}", key=key)[1]["holdings"] if not h["locked"])
                self.assertEqual(round(before - after, 6), 3.0)


if __name__ == "__main__":
    unittest.main()
