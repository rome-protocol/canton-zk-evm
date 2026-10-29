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
  cc.py deposit <label> <evm address> <amount>
                                        U deposits <amount> Canton Coin (at most 10 decimals) for the EVM address: it allocates the coin to the gateway through the Amulet allocation factory (the scan
                                        proxy's allocation-factory, with its choice context and disclosed contracts; the settlement and transfer leg as `canton.py deposit` builds them for TKB: the
                                        operator is the executor, the gateway the receiver), then signs the DepositRequest with the label, whose deposit id is the one derived from U and the label.
                                        Prints the deposit id, the allocation and the request's contract id. The claim on Ostia stays `evm.py claim u <deposit id> <evm token> <amount>`; the builder
                                        attaches the deposit leg's choice context when it runs with --registry <DSO party>=<scan proxy>
  cc.py withdraw <amount>               U's EVM address burns <amount> wrapped Canton Coin through the gateway for U (as `evm.py withdraw` does), after checking that U has a WithdrawalAcceptance
                                        (`canton.py accept u` makes one) and the wrapped coin to burn. Then it waits, at most 10 minutes, until U's Canton Coin has grown by <amount> (the builder's
                                        Receive leg) and prints both sides: the burn on Ostia and U's Canton Coin before and after

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
COMMAND_ROLES = {"register": ("operator", "confirmer"), "balances": ("demo", "operator"), "fund": ("demo", "sender"), "deposit": ("demo", "operator"), "withdraw": ("demo", "operator")}
ALLOCATION_COMPLETED = "AllocationInstructionResult_Completed"
WITHDRAW_WAIT_SECONDS = 600   # the longest that withdraw waits for the builder's Receive leg to reach U
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

    def allocation_factory(self, allocation: dict, requested_at: str, inputs: list, expected_admin: str) -> dict:
        """The allocation factory for this allocation, as the token standard's registry API gives it, checked: a contract id that is disclosed, whose template is ExternalPartyAmuletRules, the same contract as the transfer factory."""
        arguments = {"expectedAdmin": expected_admin, "allocation": allocation, "requestedAt": requested_at, "inputHoldingCids": inputs, "extraArgs": {"context": {"values": {}}, "meta": {"values": {}}}}
        answer = self.call(twin.post_json, self.url + "/registry/allocation-instruction/v1/allocation-factory", {"choiceArguments": arguments, "excludeDebugFields": True})
        factory = answer.get("factoryId")
        if not isinstance(factory, str) or not CONTRACT_ID.fullmatch(factory):
            raise canton.Fail("the scan proxy's answer has no factoryId that is a contract id")
        data, disclosed = checked_context(answer.get("choiceContext"))
        named = [d for d in disclosed if d["contractId"] == factory]
        if len(named) != 1:
            raise canton.Fail("the scan proxy did not disclose the factory it named")
        if not FACTORY_TEMPLATE.fullmatch(named[0]["templateId"]):
            raise canton.Fail(f"the scan proxy's allocation factory is a {named[0]['templateId'][:120]}, not an ExternalPartyAmuletRules")
        return {"factory": factory, "data": data, "disclosed": disclosed}

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


def amount_of(text) -> int:
    """A Canton Coin amount as the ledger writes it, in units of 10^-10 (Canton Coin has 10 decimals, as the wrapped token): anything else stops the command."""
    if not isinstance(text, str):
        raise canton.Fail(f"the ledger gave the amount {text!r}: not a Canton Coin amount")
    return twin.ledger_units(text)


def holdings(net: canton.Network, node: str, role: str, party: str, dso: str) -> list:
    """The Canton Coin holdings that `party` owns, as the token standard's Holding views of the active contracts that `party` sees on `node` (read with `role`'s token): a list of
    (contract id, units of 10^-10, locked). Holdings of other instruments, other owners and contracts with no Holding view are not counted."""
    offset = net.get(node, "/v2/state/ledger-end", role)["offset"]
    view = {"InterfaceFilter": {"value": {"interfaceId": HOLDING_INTERFACE, "includeInterfaceView": True, "includeCreatedEventBlob": False}}}
    body = {"eventFormat": {"filtersByParty": {party: {"cumulative": [{"identifierFilter": view}]}}, "verbose": False}, "activeAtOffset": offset}
    found = []
    for entry in net.post(node, "/v2/state/active-contracts", body, role):
        active = entry["contractEntry"].get("JsActiveContract")
        for v in (active["createdEvent"].get("interfaceViews") or []) if active else []:
            if not str(v.get("interfaceId", "")).endswith(HOLDING_VIEW):
                continue
            value = v.get("viewValue")
            if not isinstance(value, dict) or not isinstance(value.get("instrumentId"), dict):
                raise canton.Fail(f"{active['createdEvent'].get('contractId')} has a Holding view that is not a holding")
            if value.get("owner") == party and value["instrumentId"].get("admin") == dso and value["instrumentId"].get("id") == AMULET:
                found.append((active["createdEvent"]["contractId"], amount_of(value.get("amount")), value.get("lock") is not None))
    return found


def balance_of(held: list) -> dict:
    return {"unlocked": twin.amount_text(sum(a for _, a, locked in held if not locked)), "locked": twin.amount_text(sum(a for _, a, locked in held if locked))}


def party_balance(net: canton.Network, name: str, dso: str, other_role: str = OTHER_ROLE) -> dict:
    if name in ("u", "v"):
        party, node, role = net.party(name), "users", "demo"
    elif PARTY_ID.fullmatch(name):
        party, node, role = name, "users", other_role
    else:
        raise SystemExit(f"a party is u, v or a party id (name::fingerprint), not {name!r}")
    return {"party": party, **balance_of(holdings(net, node, role, party, dso))}


def wrapped_supply(net: canton.Network, instrument: dict) -> dict:
    """The wrapped token of Canton Coin (the operator's GatewayToken for the instrument) and its total supply at the finalized block, read by that block's number."""
    made = gateway_tokens(net, "GatewayToken", instrument)
    if len(made) > 1:
        raise canton.Fail(f"the operator sees {len(made)} GatewayTokens for Canton Coin: there must be one")
    if not made:
        return {"registered": False}
    token = made[0]["createArgument"]["evmToken"]
    block = int(evm.rpc("eth_getBlockByNumber", ["finalized", False])["number"], 16)
    supply = evm.read_word("0x" + token, evm.SELECTOR_TOTAL_SUPPLY, hex(block))
    return {"registered": True, "evmToken": "0x" + token, "totalSupply": evm.wrapped_text(supply), "block": block}


def balances(net: canton.Network, scan: Scan, who: list) -> dict:
    dso = scan.dso_party()
    names = who or ["u", "v"]
    for name in names:   # a name that is no party stops the command before anything is read
        if name not in ("u", "v") and not PARTY_ID.fullmatch(name):
            raise SystemExit(f"a party is u, v or a party id (name::fingerprint), not {name!r}")
    gateway = net.party("gateway")
    return {"instrument": {"admin": dso, "id": AMULET}, "parties": {name: party_balance(net, name, dso) for name in names},
            "gatewayCustody": {"party": gateway, **balance_of(holdings(net, "operator", "operator", gateway, dso))}, "wrapped": wrapped_supply(net, {"admin": dso, "id": AMULET})}


def fund(net: canton.Network, scan: Scan, who: str, amount: str) -> dict:
    """The validator's party sends `amount` Canton Coin to u, v or a party: the scan proxy's transfer factory, then TransferFactory_Transfer as the validator's party with the token of
    --sender-token-file (role "sender"), the factory's context and its disclosed contracts. A completed transfer is done; a pending one (an offer) is accepted by u or v, as the demo user,
    with the scan proxy's choice context for "accept"."""
    if not canton.CANTON_AMOUNT.fullmatch(amount) or not twin.ledger_units(amount):
        raise SystemExit(f"the amount must be more than zero, with at most 10 decimals: {amount!r}")
    amount = amount if "." in amount else amount + ".0"
    if who not in ("u", "v") and not PARTY_ID.fullmatch(who):
        raise SystemExit(f"a party is u, v or a party id (name::fingerprint), not {who!r}")
    receiver = net.party(who) if who in ("u", "v") else who
    dso, validator = scan.dso_party(), scan.validator_party()
    if receiver == validator:
        raise SystemExit("the validator's party is the sender: name another party")
    held = sorted((h for h in holdings(net, "users", SENDER_ROLE, validator, dso) if not h[2]), key=lambda h: -h[1])
    if sum(a for _, a, _ in held) < twin.ledger_units(amount):
        raise canton.Fail(f"the validator's party holds {twin.amount_text(sum(a for _, a, _ in held))} Canton Coin, less than {amount}")
    before = party_balance(net, who, dso, SENDER_ROLE)
    # All of the (up to 50) largest unlocked holdings go in: Canton Coin takes its transfer fee from the inputs, so the ones that cover the amount alone may not cover the fee; the change comes back.
    transfer = transfer_of(validator, receiver, amount, dso, [cid for cid, _, _ in held[:MAX_INPUTS]])
    asked = scan.factory(transfer, dso)
    if asked["kind"] == "offer" and who not in ("u", "v"):
        raise canton.Fail(f"the registry makes this transfer an offer, and only u and v accept offers here: {receiver[:30]} has to accept it itself")
    command = {"ExerciseCommand": {"templateId": canton.TRANSFER_FACTORY, "contractId": asked["factory"], "choice": "TransferFactory_Transfer",
                                   "choiceArgument": {"expectedAdmin": dso, "transfer": transfer, "extraArgs": {"context": asked["data"], "meta": {"values": {}}}}}}
    tx = twin.submit_for_transaction(net, None, command, asked["disclosed"], role=SENDER_ROLE, party=validator, user=False)
    output = twin.exercise_output(tx, asked["factory"], "TransferFactory_Transfer") or {}
    tag, accepted, instruction = output.get("tag"), None, None
    if tag == TRANSFER_PENDING:
        value = output.get("value")
        instruction = value.get("transferInstructionCid") if isinstance(value, dict) else None
        if not isinstance(instruction, str) or not CONTRACT_ID.fullmatch(instruction):
            raise canton.Fail(f"the transfer in update {tx['updateId']} is pending, and the result names no transfer instruction")
        if who not in ("u", "v"):
            raise canton.Fail(f"the transfer in update {tx['updateId']} is pending as instruction {instruction}: only u and v accept offers here, {receiver[:30]} has to accept it itself")
        context = scan.accept_context(instruction)
        accept = {"ExerciseCommand": {"templateId": canton.TRANSFER_INSTRUCTION, "contractId": instruction, "choice": "TransferInstruction_Accept",
                                      "choiceArgument": {"extraArgs": {"context": context["data"], "meta": {"values": {}}}}}}
        accepted = twin.submit_for_transaction(net, who, accept, context["disclosed"])
        if (twin.exercise_output(accepted, instruction, "TransferInstruction_Accept") or {}).get("tag") != twin.TRANSFER_COMPLETED:
            raise canton.Fail(f"{who}'s acceptance in update {accepted['updateId']} did not complete the transfer")
    elif tag != twin.TRANSFER_COMPLETED:
        raise canton.Fail(f"the transfer in update {tx['updateId']} did not complete: its result is {tag or 'not there'}, not {twin.TRANSFER_COMPLETED} or {TRANSFER_PENDING}")
    want = twin.ledger_units(before["unlocked"]) + twin.ledger_units(amount)

    def arrived():
        now = party_balance(net, who, dso, SENDER_ROLE)
        return now if twin.ledger_units(now["unlocked"]) >= want else None
    after = net.wait_for("the receiver to hold the Canton Coin", arrived)
    return {"transferUpdateId": tx["updateId"], "acceptUpdateId": accepted["updateId"] if accepted else None, "from": validator, "to": receiver, "amount": amount, "kind": asked["kind"],
            "result": tag, "instruction": instruction, "balance": {"unlocked": after["unlocked"], "locked": after["locked"]}}


def canton_coin_token(net: canton.Network, instrument: dict) -> str:
    """The wrapped token of Canton Coin (40 hex digits): the operator's one GatewayToken for the instrument. Without one, `cc.py register` has not run."""
    made = gateway_tokens(net, "GatewayToken", instrument)
    if len(made) != 1:
        raise canton.Fail(f"the operator sees {len(made)} GatewayTokens for Canton Coin: there must be one (`cc.py register` makes it)")
    return made[0]["createArgument"]["evmToken"]


def deposit(net: canton.Network, scan: Scan, label: str, recipient: str, amount: str) -> dict:
    """U allocates `amount` Canton Coin to the gateway through the scan proxy's allocation factory (the allocation exactly as canton.allocate builds it for TKB: the operator the executor,
    the gateway the receiver) and signs the DepositRequest, whose id is canton.deposit_id_of(U, label). The claim on Ostia is evm.py claim."""
    canton.read_label(label)
    if not canton.CANTON_AMOUNT.fullmatch(amount) or not twin.ledger_units(amount):
        raise SystemExit(f"the amount must be more than zero, with at most 10 decimals: {amount!r}")
    amount = amount if "." in amount else amount + ".0"
    address = canton.evm_address(recipient)
    dso = scan.dso_party()
    instrument = {"admin": dso, "id": AMULET}
    token = canton_coin_token(net, instrument)
    chain, u = canton.chain_record(net), net.party("u")
    deposit_id = canton.deposit_id_of(u, label)
    if any(e["createArgument"]["depositId"] == deposit_id for e in net.template("operator", "operator", canton.DEPOSIT_REQUEST)):
        raise SystemExit(f"U already has an open deposit request with the label {label!r}: each label makes one deposit id, so use a label that has not been used")
    held = sorted((h for h in holdings(net, "users", "demo", u, dso) if not h[2]), key=lambda h: -h[1])
    if sum(a for _, a, _ in held) < twin.ledger_units(amount):
        raise canton.Fail(f"U holds {twin.amount_text(sum(a for _, a, _ in held))} Canton Coin, less than {amount} (`cc.py fund u <amount>` gives it some)")
    requested = canton.utc(timedelta(minutes=-1))
    spec = {"settlement": {"executor": net.party("operator"), "settlementRef": {"id": label, "cid": None}, "requestedAt": requested,
                           "allocateBefore": canton.utc(timedelta(hours=1)), "settleBefore": canton.utc(timedelta(hours=2)), "meta": {"values": {}}},
            "transferLegId": "leg-" + label,
            "transferLeg": {"sender": u, "receiver": chain["gateway"], "amount": amount, "instrumentId": instrument, "meta": {"values": {}}}}
    inputs = [cid for cid, _, _ in held[:MAX_INPUTS]]   # as in fund: the fee may come out of more than the amount's own holdings
    asked = scan.allocation_factory(spec, requested, inputs, dso)
    command = {"ExerciseCommand": {"templateId": canton.ALLOCATION_FACTORY, "contractId": asked["factory"], "choice": "AllocationFactory_Allocate", "choiceArgument": {
        "expectedAdmin": dso, "allocation": spec, "requestedAt": requested, "inputHoldingCids": inputs, "extraArgs": {"context": asked["data"], "meta": {"values": {}}}}}}
    tx = twin.submit_for_transaction(net, "u", command, asked["disclosed"])
    output = twin.exercise_output(tx, asked["factory"], "AllocationFactory_Allocate") or {}
    value = output.get("value")
    allocation = value.get("allocationCid") if isinstance(value, dict) else None
    if output.get("tag") != ALLOCATION_COMPLETED or not isinstance(allocation, str) or not CONTRACT_ID.fullmatch(allocation):
        raise canton.Fail(f"the allocation in update {tx['updateId']} did not complete: its result is {output.get('tag') or 'not there'}, not {ALLOCATION_COMPLETED} with an allocation")
    arguments = {"operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"], "chainId": chain["chainId"],
                 "depositor": u, "depositId": deposit_id, "recipient": address, "allocation": allocation, "label": label}
    net.submit("users", ["u"], {"CreateCommand": {"templateId": canton.DEPOSIT_REQUEST, "createArguments": arguments}})
    [request] = net.wait_for("the deposit request", lambda: [e for e in net.template("operator", "operator", canton.DEPOSIT_REQUEST) if e["createArgument"]["depositId"] == deposit_id])
    return {"label": label, "depositId": deposit_id, "recipient": "0x" + address, "amount": amount, "evmToken": "0x" + token, "allocationUpdateId": tx["updateId"], "allocation": allocation,
            "request": request["contractId"], "claim": f"evm.py claim <u or v> {deposit_id} 0x{token} {amount}"}


def withdraw(net: canton.Network, scan: Scan, amount: str) -> dict:
    """U's EVM address burns `amount` wrapped Canton Coin through the gateway for U's party, which has to have a WithdrawalAcceptance: the builder's Receive leg then sends the coin from the
    gateway's custody to U through the scan proxy's factory. Waits (at most WITHDRAW_WAIT_SECONDS) until U's unlocked Canton Coin has grown by the amount."""
    if not canton.CANTON_AMOUNT.fullmatch(amount):
        raise SystemExit(f"the amount must be more than zero, with at most 10 decimals: {amount!r}")
    units = evm.wrapped_units(amount)   # refuses zero
    dso = scan.dso_party()
    token = canton_coin_token(net, {"admin": dso, "id": AMULET})
    if not canton.acceptances_of(net, "u"):
        raise canton.Fail("U has no WithdrawalAcceptance: `canton.py accept u` makes one, and without it the gateway cannot send Canton Coin to U")
    u = net.party("u")
    address = evm.make_keys(evm.state_dir())["u"]
    wrapped = lambda tag: evm.read_word("0x" + token, evm.SELECTOR_BALANCE_OF + evm.pad32(address), tag)
    held = wrapped("latest")
    if held < units:
        raise canton.Fail(f"U's address {address} holds {evm.wrapped_text(held)} wrapped Canton Coin, less than {evm.wrapped_text(units)} (`evm.py claim` makes it from a deposit)")
    before = party_balance(net, "u", dso)
    sent = evm.main(["withdraw", "u", "0x" + token, amount, u])
    receipt = evm.wait_finalized(sent["tx"], evm.WAIT_SECONDS)
    if receipt["status"] != 1:
        raise canton.Fail(f"the withdrawal {sent['tx']} failed on Ostia (status {receipt['status']}, block {receipt['block']})")
    want = twin.ledger_units(before["unlocked"]) + units

    def arrived():
        now = party_balance(net, "u", dso)
        return now if twin.ledger_units(now["unlocked"]) >= want else None
    after = net.wait_for("U to hold the Canton Coin from the gateway", arrived, WITHDRAW_WAIT_SECONDS)
    return {"amount": evm.wrapped_text(units), "ostia": {"tx": sent["tx"], "block": receipt["block"], "address": address, "wrapped": {"before": evm.wrapped_text(held), "after": evm.wrapped_text(wrapped("finalized"))}}, "canton": {"party": u, "before": {"unlocked": before["unlocked"], "locked": before["locked"]}, "after": {"unlocked": after["unlocked"], "locked": after["locked"]}}}


def secret_files(options: dict) -> set:
    """The token files that this run may read: the environment's and the options'."""
    named = {v for k, v in os.environ.items() if k.startswith(TOKEN_FILE_VARIABLE) or k == SCAN_TOKEN_FILE}
    return named | {v for k, v in options.items() if k.endswith("token-file")}


def scrubbed(message: str, files: set) -> str:
    """The message without any of the tokens in these files: a server's error text may echo a header."""
    for path in files:
        try:
            token = Path(path).read_text().strip()
        except OSError:
            continue
        if len(token) >= 8:
            message = message.replace(token, "<token>")
    return message


def scan_of(options: dict) -> Scan:
    return Scan(options["--scan-proxy"] if "--scan-proxy" in options else os.environ.get(SCAN_PROXY_URL),
                options["--scan-token-file"] if "--scan-token-file" in options else os.environ.get(SCAN_TOKEN_FILE))


def main(argv: list) -> dict:
    options = {}
    try:
        return run(argv, options)
    except canton.Fail as e:
        raise canton.Fail(scrubbed(str(e), secret_files(options))) from None


def run(argv: list, options: dict) -> dict:
    cmd = argv[:1]
    if cmd and cmd[0] in COMMAND_ROLES:
        names = ("--scan-proxy", "--scan-token-file") + {"balances": ("--token-file",), "fund": ("--sender-token-file",)}.get(cmd[0], ())
        args, found = twin.split_options(argv[1:], names, __doc__)
        options.update(found)
        shape = {"register": not args, "balances": True, "fund": len(args) == 2 and "--sender-token-file" in options,
                 "deposit": len(args) == 3, "withdraw": len(args) == 1}[cmd[0]]
        if not shape:
            raise SystemExit(__doc__)
        net = canton.Network()
        if cmd == ["register"]:
            if net.external:
                net.check_roles(COMMAND_ROLES["register"])
            return register(net, scan_of(options))
        if cmd == ["balances"]:
            if "--token-file" in options:
                os.environ[TOKEN_FILE_VARIABLE + OTHER_ROLE.upper()] = options["--token-file"]   # the role that reads a party that is not u or v
            if net.external:
                net.check_roles(COMMAND_ROLES["balances"] + ((OTHER_ROLE,) if any(a not in ("u", "v") for a in args) else ()))
            return balances(net, scan_of(options), args)
        if cmd == ["fund"]:
            os.environ[TOKEN_FILE_VARIABLE + SENDER_ROLE.upper()] = options["--sender-token-file"]   # the role that acts as the validator's party
            if net.external:
                net.check_roles(COMMAND_ROLES["fund"])
            return fund(net, scan_of(options), args[0], args[1])
        if net.external:
            net.check_roles(COMMAND_ROLES[cmd[0]])
        if cmd == ["deposit"]:
            return deposit(net, scan_of(options), *args)
        if cmd == ["withdraw"]:
            return withdraw(net, scan_of(options), args[0])
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except canton.Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
