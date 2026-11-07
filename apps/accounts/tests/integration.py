"""The accounts service on a real participant (run by integration.sh, which starts Canton, the service and a user with no rights).
An Ed25519 key is made here with openssl, and it is the only thing that signs: an external party is allocated from it, then a WithdrawalAcceptance of the
chain package is created for that party through prepare, a signature and execute; the contract is read back, and the holdings are listed."""
import base64, hashlib, json, os, subprocess, sys, tempfile, time, unittest, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "network" / "canton"))
import propose

SERVICE, LEDGER, USER = os.environ["ACCOUNTS_URL"], os.environ["CZE_LEDGER_URL"], os.environ["ACCOUNTS_USER"]
ACCEPTANCE = "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance"


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
            status, made = service("/accounts/v1/allocate", {"blob": topology["blob"], "signature": key.sign(topology["multiHash"])})
            self.assertEqual((status, made), (200, {"party": party, "created": True}), made)
            self.assertEqual(service("/accounts/v1/topology", {"publicKey": public})[1], {"party": party, "exists": True})   # the same key: the same account

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

            # A DepositRequest names a contract id as its allocation, and a real one (the chain's own, which is longer than 128 characters) passes the service's checks and
            # the participant's prepare. The test stops at prepare: the create does not fetch the allocation, and no allocation of a test holding is made here.
            self.assertGreater(len(chain["contractId"]), 128)
            label = "integration"
            deposit = {k: arguments[k] for k in ("chainId", "operator", "confirmer", "gateway", "builder")}
            deposit.update(depositor=party, depositId=hashlib.sha256(f"deposit,{party},{label}".encode()).hexdigest(), recipient="ab" * 20, allocation=chain["contractId"], label=label)
            status, prepared_deposit = service("/accounts/v1/prepare", {"party": party, "commands": [{"CreateCommand": {"templateId": "#canton-zk-evm:Zk.Chain:DepositRequest", "createArguments": deposit}}]}, key)
            self.assertEqual(status, 200, prepared_deposit)

            # An account-scoped call without the account's signature is refused.
            status, refused = service(f"/accounts/v1/holdings/{party}")
            self.assertEqual(status, 401, refused)

            status, holdings = service(f"/accounts/v1/holdings/{party}", key=key)
            self.assertEqual((status, holdings), (200, {"party": party, "holdings": []}))
            self.assertEqual(service("/accounts/v1/holdings/nobody::1220" + "0" * 64)[0], 404)   # a party the service did not make


if __name__ == "__main__":
    unittest.main()
