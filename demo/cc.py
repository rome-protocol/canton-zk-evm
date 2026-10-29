#!/usr/bin/env python3
"""Canton Coin on Ostia, for the demo: the real Canton asset (the instrument {admin: the DSO party, id: "Amulet"}) whose registry is the validator's scan proxy. See demo/README.md.

  cc.py register                        the gateway's wrapped ERC-20 for Canton Coin on Ostia (as evm.py register makes the one of TKB) and its GatewayToken on Canton (as canton.py
                                        register-token does, through network/canton/propose.py token), for the instrument {the DSO party, which the scan proxy names, "Amulet"} and with the
                                        transfer factory that the scan proxy names. A second run changes nothing and prints what exists (and whether the factory is still the scan proxy's).
                                        Prints the EVM address and the GatewayToken's contract id
  cc.py balances [u|v|<party id> ...] [--token-file FILE]
                                        each party's Canton Coin (U and V if none is named): the token standard's Holding views of the instrument Amulet of the DSO, unlocked and locked;
                                        the gateway's Canton Coin custody; and the wrapped token's total supply on Ostia (finalized block). A party that is not u or v is read with the token in
                                        FILE (default: the file of CZE_TOKEN_FILE_ADMIN, the participant admin's)
  cc.py fund <u|v|<party id>> <amount> --sender-token-file FILE
                                        the validator's party sends <amount> Canton Coin (at most 10 decimals) to the party through the token standard's transfer factory (the scan proxy's),
                                        submitted with the token in FILE: a Ledger API user that may act as the validator's party (on DevNet the participant admin's). If the result is pending
                                        (an offer, not a completed transfer) the receiver, u or v, accepts it with the scan proxy's choice context for "accept", as the demo user. Prints the
                                        update ids and the receiver's new balance

Every scan proxy call takes --scan-proxy URL (the validator's <validator>/api/validator/v0/scan-proxy; also CZE_SCAN_PROXY_URL) and --scan-token-file FILE (a file, mode 0600, with the bearer token
that the validator API wants; also CZE_SCAN_TOKEN_FILE). Tokens are read from their files at every call and are never printed. Requests carry the User-Agent "Rome Protocol rome@romeprotocol.com".
The scan proxy is a server that this tool does not trust: each answer is size-capped and checked before it is used. All Ostia calls go through demo/evm.py (CZE_RPC_URL, CZE_STATE_DIR and the
key U), all Canton ones through demo/canton.py's network (CZE_CANTON=external and the rest of its settings). Every command prints one JSON object; `FAIL: <why>` and exit status 1 when it cannot.
"""
import json, os, re, sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import canton, evm, twin

AMULET = "Amulet"
WRAPPED_NAME, WRAPPED_SYMBOL = "Canton Coin", "CC"
USER_AGENT = "Rome Protocol rome@romeprotocol.com"
SCAN_PROXY_URL = "CZE_SCAN_PROXY_URL"
SCAN_TOKEN_FILE = "CZE_SCAN_TOKEN_FILE"
HOLDING_VIEW = ":Splice.Api.Token.HoldingV1:Holding"
HOLDING_INTERFACE = "#splice-api-token-holding-v1" + HOLDING_VIEW
FACTORY_TEMPLATE = re.compile(r"(?:[0-9a-f]{64}|#[A-Za-z0-9_.-]+):Splice\.ExternalPartyAmuletRules:ExternalPartyAmuletRules")
TEMPLATE_ID = re.compile(r"(?:[0-9a-f]{64}|#[A-Za-z0-9_.-]+):[A-Za-z0-9_.]+:[A-Za-z0-9_]+")
CONTRACT_ID = re.compile(r"00[0-9a-f]{20,200}")
PARTY_ID = re.compile(r"[A-Za-z0-9._-]{1,185}::[0-9a-f]{8,200}")
MAX_DISCLOSED, MAX_CONTEXT_VALUES, MAX_BLOB = 16, 64, 500_000
MAX_INPUTS = 50   # the holdings that a transfer takes as inputs, the largest first (Canton Coin allows 100)
TRANSFER_KINDS = ("self", "direct", "offer")
TRANSFER_PENDING = "TransferInstructionResult_Pending"
COMMAND_ROLES = {"register": ("operator", "confirmer"), "balances": ("demo", "operator"), "fund": ("demo", "sender")}
SENDER_ROLE = "sender"   # the role whose token file is --sender-token-file
OTHER_ROLE = "admin"     # the role that reads the holdings of a party that is not u or v
TOKEN_FILE_VARIABLE = "CZE_TOKEN_FILE_"


class Scan:
    """The validator's scan proxy and validator API, with the bearer token that the validator API wants, read from its file at every call."""
    def __init__(self, url: str, token_file: str):
        url = (url or "").rstrip("/")
        if not canton.LOOPBACK_OR_HTTPS.match(url) or not url.endswith("/scan-proxy"):
            raise SystemExit(f"--scan-proxy must be the validator's scan proxy, https (or http on this machine) and ending in /scan-proxy, not {url!r}")
        if not token_file:
            raise SystemExit(f"a scan token file is needed: --scan-token-file or {SCAN_TOKEN_FILE}")
        self.url, self.root, self.token_file = url, url[:-len("/scan-proxy")], token_file
        canton.propose.read_token(token_file)   # a missing or unsafe file stops the command before anything is sent

    def call(self, send, url: str, *args) -> dict:
        token = canton.propose.read_token(self.token_file)
        try:
            return send(url, *args, {"user-agent": USER_AGENT, **canton.propose.auth(token)})
        except canton.Fail as e:
            raise canton.Fail(str(e).replace(token, "<token>")) from None

    def dso_party(self) -> str:
        return self.party(self.call(twin.get_json, self.url + "/dso-party-id"), "dso_party_id", "the DSO party")

    def validator_party(self) -> str:
        return self.party(self.call(twin.get_json, self.root + "/validator-user"), "party_id", "the validator's party")

    @staticmethod
    def party(answer: dict, key: str, what: str) -> str:
        party = answer.get(key)
        if not isinstance(party, str) or not PARTY_ID.fullmatch(party):
            raise canton.Fail(f"the scan proxy's answer for {what} has no {key} that is a party id")
        return party

    def factory(self, transfer: dict, expected_admin: str) -> dict:
        """The transfer factory for this transfer, as the token standard's registry API gives it, checked (see checked_context)."""
        arguments = {"expectedAdmin": expected_admin, "transfer": transfer, "extraArgs": {"context": {"values": {}}, "meta": {"values": {}}}}
        answer = self.call(twin.post_json, self.url + "/registry/transfer-instruction/v1/transfer-factory", {"choiceArguments": arguments, "excludeDebugFields": True})
        factory = answer.get("factoryId")
        if not isinstance(factory, str) or not CONTRACT_ID.fullmatch(factory):
            raise canton.Fail("the scan proxy's answer has no factoryId that is a contract id")
        kind = answer.get("transferKind")
        if kind not in TRANSFER_KINDS or (kind == "self") != (transfer["sender"] == transfer["receiver"]):
            raise canton.Fail(f"the scan proxy's transferKind is {str(kind)[:20]!r}, which does not fit a transfer from {transfer['sender'][:20]} to {transfer['receiver'][:20]}")
        data, disclosed = checked_context(answer.get("choiceContext"))
        named = [d for d in disclosed if d["contractId"] == factory]
        if len(named) != 1:
            raise canton.Fail("the scan proxy did not disclose the factory it named")
        if not FACTORY_TEMPLATE.fullmatch(named[0]["templateId"]):
            raise canton.Fail(f"the scan proxy's factory is a {named[0]['templateId'][:120]}, not an ExternalPartyAmuletRules")
        return {"factory": factory, "kind": kind, "data": data, "disclosed": disclosed}

    def accept_context(self, instruction: str) -> dict:
        """The choice context for the receiver's TransferInstruction_Accept of this instruction, checked."""
        if not CONTRACT_ID.fullmatch(instruction):
            raise canton.Fail(f"the transfer instruction {instruction[:40]!r} is not a contract id")
        answer = self.call(twin.post_json, f"{self.url}/registry/transfer-instruction/v1/{instruction}/choice-contexts/accept", {"meta": {}, "excludeDebugFields": True})
        data, disclosed = checked_context(answer)
        return {"data": data, "disclosed": disclosed}


def checked_context(context) -> tuple:
    """(choiceContextData, disclosed contracts) of a registry's choice context, from a server that is not trusted. The data is a map of at most 64 values; each disclosed contract
    (at most 16, each once) must have its templateId, contractId, createdEventBlob and synchronizerId, and only those four go on to the ledger."""
    data = context.get("choiceContextData") if isinstance(context, dict) else None
    disclosed = context.get("disclosedContracts") if isinstance(context, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("values"), dict) or not isinstance(disclosed, list):
        raise canton.Fail("the scan proxy's choice context has no choiceContextData with values and disclosedContracts")
    if len(data["values"]) > MAX_CONTEXT_VALUES or not 0 < len(disclosed) <= MAX_DISCLOSED:
        raise canton.Fail(f"the scan proxy's choice context has {len(data['values'])} values and {len(disclosed)} disclosed contracts: too many, or none")
    contracts = []
    for d in disclosed:
        if not isinstance(d, dict) or any(not isinstance(d.get(k), str) or not d[k] or len(d[k]) > MAX_BLOB for k in twin.DISCLOSED_KEYS):
            raise canton.Fail(f"the scan proxy gave a disclosed contract without {', '.join(twin.DISCLOSED_KEYS)}")
        if not TEMPLATE_ID.fullmatch(d["templateId"]) or not CONTRACT_ID.fullmatch(d["contractId"]):
            raise canton.Fail("the scan proxy gave a disclosed contract whose templateId or contractId is not one")
        contracts.append({k: d[k] for k in twin.DISCLOSED_KEYS})
    if len({c["contractId"] for c in contracts}) != len(contracts):
        raise canton.Fail("the scan proxy disclosed a contract twice")
    return data, contracts


def transfer_of(sender: str, receiver: str, amount: str, dso: str, inputs: list) -> dict:
    return {"sender": sender, "receiver": receiver, "amount": amount, "instrumentId": {"admin": dso, "id": AMULET}, "requestedAt": canton.utc(timedelta(minutes=-1)),
            "executeBefore": canton.utc(timedelta(hours=1)), "inputHoldingCids": inputs, "meta": {"values": {}}}


def gateway_tokens(net: canton.Network, template: str, instrument: dict) -> list:
    """The GatewayTokens (or proposals) of the operator's view for this instrument."""
    return [e for e in net.template("operator", "operator", canton.CHAIN + template) if e["createArgument"]["instrumentId"] == instrument]


def wrapped_at(gateway: str, token: str) -> bool:
    """Whether the gateway made this token, at the finalized block (the block that Canton has committed): wrapped(address)."""
    return bool(evm.read_word(gateway, evm.call_data("wrapped(address)", ["0x" + token]), "finalized"))


def state_file(net: canton.Network) -> Path:
    return net.state / "cc.json"


def wrapped_token(net: canton.Network) -> tuple:
    """(the wrapped ERC-20 of Canton Coin, 40 hex digits; the transaction that made it, or None). A token that an earlier run made and recorded in the state directory, and that the
    gateway still shows as its own, is used again: a run that stopped between Ostia and Canton does not make a second one."""
    gateway = evm.gateway_address()
    try:
        saved = json.loads(state_file(net).read_text())
    except (OSError, ValueError):
        saved = None
    if isinstance(saved, dict) and saved.get("gateway") == gateway and isinstance(saved.get("evmToken"), str) and re.fullmatch(r"[0-9a-f]{40}", saved["evmToken"]) \
            and wrapped_at(gateway, saved["evmToken"]):
        return saved["evmToken"], None
    made = evm.main(["register", "u", WRAPPED_NAME, WRAPPED_SYMBOL])
    receipt = evm.wait_finalized(made["tx"], evm.WAIT_SECONDS)   # the gateway's token is registered with Canton at the finalized block
    token = canton.evm_address(made["token"])
    if receipt["status"] != 1 or not wrapped_at(gateway, token):
        raise canton.Fail(f"the gateway did not make the token {made['token']} in {made['tx']} (status {receipt['status']}, block {receipt['block']})")
    state_file(net).write_text(json.dumps({"gateway": gateway, "evmToken": token, "tx": made["tx"]}))
    return token, made["tx"]


def register(net: canton.Network, scan: Scan) -> dict:
    dso, validator = scan.dso_party(), scan.validator_party()
    instrument = {"admin": dso, "id": AMULET}
    asked = scan.factory(transfer_of(validator, validator, "1.0", dso, []), dso)   # the factory of a transfer of the validator's party to itself
    made = gateway_tokens(net, "GatewayToken", instrument)
    if len(made) > 1:
        raise canton.Fail(f"the operator sees {len(made)} GatewayTokens for Canton Coin: there must be one")
    if made:
        fields = made[0]["createArgument"]
        return {"created": False, "evmToken": "0x" + fields["evmToken"], "gatewayToken": made[0]["contractId"], "instrumentId": fields["instrumentId"], "factory": fields["factory"],
                "factoryIsScanProxys": fields["factory"] == asked["factory"], "registerTx": None}
    left = gateway_tokens(net, "GatewayTokenProposal", instrument)
    if len(left) > 1:
        raise canton.Fail(f"the operator sees {len(left)} proposals for Canton Coin: there must be one")
    token, tx = (left[0]["createArgument"]["evmToken"], None) if left else wrapped_token(net)
    done = canton.register_token(net, token, instrument, asked["factory"])
    return {"created": True, "evmToken": "0x" + done["evmToken"], "gatewayToken": done["contractId"], "instrumentId": done["instrumentId"], "factory": asked["factory"],
            "factoryIsScanProxys": True, "registerTx": tx}


def scan_of(options: dict) -> Scan:
    return Scan(options["--scan-proxy"] if "--scan-proxy" in options else os.environ.get(SCAN_PROXY_URL),
                options["--scan-token-file"] if "--scan-token-file" in options else os.environ.get(SCAN_TOKEN_FILE))


def main(argv: list) -> dict:
    n, cmd = len(argv), argv[:1]
    if cmd and cmd[0] in COMMAND_ROLES:
        names = ("--scan-proxy", "--scan-token-file") + {"balances": ("--token-file",), "fund": ("--sender-token-file",)}.get(cmd[0], ())
        args, options = twin.split_options(argv[1:], names, __doc__)
        net = canton.Network()
        if cmd == ["register"] and not args:
            if net.external:
                net.check_roles(COMMAND_ROLES["register"])
            return register(net, scan_of(options))
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except canton.Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
