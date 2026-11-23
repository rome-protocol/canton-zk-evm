#!/usr/bin/env python3
"""Memo tools for any token-standard asset on Ostia: an instrument is ADMIN/ID (the admin party and the instrument id). Canton Coin is one instrument; demo/cc.py passes it to these commands.

  asset.py send-memo <instrument> <amount> <0x address> [--label LABEL] [REGISTRY]
                                        U sends <amount> (at most 10 decimals) of the instrument to the gateway's party through the token standard's transfer factory, with the EVM address as
                                        the memo: the standard reason, in the transfer's meta under splice.lfdecentralizedtrust.org/reason. --label adds romeprotocol.com/ostia-label. If the gateway
                                        holds no pre-approval the transfer is pending: it prints the instruction's contract id (and the registry's transferKind, "kind"), and U's balance before and after
  asset.py instructions [<instrument>]  the transfer instructions that have the gateway's party as the receiver (of this instrument, if one is named), read as the gateway: each one's contract id,
                                        sender, amount, instrument, status, meta (as the gateway sees it) and the memo (the reason, or null)
  asset.py take-back <instrument> <instruction> [REGISTRY]
                                        U withdraws its own pending transfer instruction (the registry's choice context for "withdraw"), so that the receiver can no longer accept it. Prints U's balance
  asset.py factory <instrument> [REGISTRY]
                                        the transfer factory that the registry names for the instrument (for `propose.py token --factory`): its contract id and template, and the transferKind

REGISTRY is the instrument's token registry: `--registry ADMIN=URL` (the root of its CIP-0056 off-ledger API; also CZE_TOKEN_REGISTRIES, comma-separated, as the builder takes it) and its bearer token
`--registry-token-file ADMIN=FILE` (a file, mode 0600; also CZE_TOKEN_REGISTRY_TOKEN_FILES). A token with no registry needs none: send-memo and take-back then use the factory of the instrument's
registered GatewayToken and no choice context, and `--disclosed FILE` (a JSON list of disclosed contracts) adds the contracts that the factory needs.
Tokens are read from their files at every call and are never printed. Requests carry the User-Agent "Rome Protocol rome@romeprotocol.com". A registry is a server that this tool does not trust: each
answer is size-capped and checked before it is used. Every command prints one JSON object; `FAIL: <why>` and exit status 1 when it cannot.
"""
import json, os, re, sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import canton, twin

USER_AGENT = "Rome Protocol rome@romeprotocol.com"
REGISTRIES, REGISTRY_TOKEN_FILES = "CZE_TOKEN_REGISTRIES", "CZE_TOKEN_REGISTRY_TOKEN_FILES"
TOKEN_FILE_VARIABLE = "CZE_TOKEN_FILE_"
HOLDING_VIEW = ":Splice.Api.Token.HoldingV1:Holding"
HOLDING_INTERFACE = "#splice-api-token-holding-v1" + HOLDING_VIEW
INSTRUCTION_VIEW = ":Splice.Api.Token.TransferInstructionV1:TransferInstruction"
REASON_KEY = "splice.lfdecentralizedtrust.org/reason"   # the memo that wallets write
LABEL_KEY = "romeprotocol.com/ostia-label"
TEMPLATE_ID = re.compile(r"(?:[0-9a-f]{64}|#[A-Za-z0-9_.-]+):[A-Za-z0-9_.]+:[A-Za-z0-9_]+")
CONTRACT_ID = re.compile(r"00[0-9a-f]{20,200}")
PARTY_ID = re.compile(r"[A-Za-z0-9._-]{1,185}::[0-9a-f]{8,200}")
MAX_DISCLOSED, MAX_CONTEXT_VALUES, MAX_BLOB = 16, 64, 500_000
MAX_INPUTS = 50   # the holdings that a transfer takes as inputs, the largest first
TRANSFER_KINDS = ("self", "direct", "offer")
TRANSFER_PENDING = "TransferInstructionResult_Pending"
COMMAND_ROLES = {"send-memo": ("demo",), "instructions": ("operator",), "take-back": ("demo",), "factory": ()}
NO_CONTEXT = {"values": {}}
ARGS = {"send-memo": (3, 3), "instructions": (0, 1), "take-back": (2, 2), "factory": (1, 1)}   # the fewest and most arguments of each command


class Registry:
    """A token registry (the root of its CIP-0056 off-ledger API) and, if it wants one, its bearer token, read from its file at every call."""
    what = "the registry"

    def __init__(self, url: str, token_file: str = None):
        url = (url or "").rstrip("/")
        if not canton.https_or_on_this_machine(url):
            raise SystemExit(f"the registry must be https (or http on this machine), not {url!r}")
        self.url, self.bearer_file = url, token_file
        if token_file:
            canton.propose.read_token(token_file)   # a missing or unsafe file stops the command before anything is sent

    def call(self, send, url: str, *args) -> dict:
        bearer = canton.propose.read_token(self.bearer_file) if self.bearer_file else None
        try:
            return send(url, *args, {"user-agent": USER_AGENT, **(canton.propose.auth(bearer) if bearer else {})})
        except canton.Fail as e:
            raise canton.Fail(str(e).replace(bearer, "<token>") if bearer else str(e)) from None

    def factory(self, transfer: dict, expected_admin: str) -> dict:
        """The transfer factory for this transfer, as the token standard's registry API gives it, checked (see checked_context)."""
        arguments = {"expectedAdmin": expected_admin, "transfer": transfer, "extraArgs": {"context": NO_CONTEXT, "meta": {"values": {}}}}
        answer = self.call(twin.post_json, self.url + "/registry/transfer-instruction/v1/transfer-factory", {"choiceArguments": arguments, "excludeDebugFields": True})
        factory = answer.get("factoryId")
        if not isinstance(factory, str) or not CONTRACT_ID.fullmatch(factory):
            raise canton.Fail(f"{self.what}'s answer has no factoryId that is a contract id")
        kind = answer.get("transferKind")
        if kind not in TRANSFER_KINDS or (kind == "self") != (transfer["sender"] == transfer["receiver"]):
            raise canton.Fail(f"{self.what}'s transferKind is {str(kind)[:20]!r}, which does not fit a transfer from {transfer['sender'][:20]} to {transfer['receiver'][:20]}")
        data, disclosed = checked_context(answer.get("choiceContext"), self.what)
        named = [d for d in disclosed if d["contractId"] == factory]
        if len(named) != 1:
            raise canton.Fail(f"{self.what} did not disclose the factory it named")
        return {"factory": factory, "kind": kind, "template": named[0]["templateId"], "data": data, "disclosed": disclosed}

    def accept_context(self, instruction: str, choice: str = "accept") -> dict:
        """The choice context for the receiver's TransferInstruction_Accept (or, with choice "withdraw", the sender's TransferInstruction_Withdraw) of this instruction, checked."""
        if not CONTRACT_ID.fullmatch(instruction):
            raise canton.Fail(f"the transfer instruction {instruction[:40]!r} is not a contract id")
        answer = self.call(twin.post_json, f"{self.url}/registry/transfer-instruction/v1/{instruction}/choice-contexts/{choice}", {"meta": {}, "excludeDebugFields": True})
        data, disclosed = checked_context(answer, self.what)
        return {"data": data, "disclosed": disclosed}


def checked_context(context, what: str = "the registry") -> tuple:
    """(choiceContextData, disclosed contracts) of a registry's choice context, from a server that is not trusted. The data is a map of at most 64 values; each disclosed contract
    (at most 16, each once) must have its templateId, contractId, createdEventBlob and synchronizerId, and only those four go on to the ledger."""
    data = context.get("choiceContextData") if isinstance(context, dict) else None
    disclosed = context.get("disclosedContracts") if isinstance(context, dict) else None
    if not isinstance(data, dict) or not isinstance(data.get("values"), dict) or not isinstance(disclosed, list):
        raise canton.Fail(f"{what}'s choice context has no choiceContextData with values and disclosedContracts")
    if len(data["values"]) > MAX_CONTEXT_VALUES or not 0 < len(disclosed) <= MAX_DISCLOSED:
        raise canton.Fail(f"{what}'s choice context has {len(data['values'])} values and {len(disclosed)} disclosed contracts: too many, or none")
    return data, disclosed_contracts(disclosed, what)


def disclosed_contracts(disclosed: list, what: str = "the registry") -> list:
    contracts = []
    for d in disclosed:
        if not isinstance(d, dict) or any(not isinstance(d.get(k), str) or not d[k] or len(d[k]) > MAX_BLOB for k in twin.DISCLOSED_KEYS):
            raise canton.Fail(f"{what} gave a disclosed contract without {', '.join(twin.DISCLOSED_KEYS)}")
        if not TEMPLATE_ID.fullmatch(d["templateId"]) or not CONTRACT_ID.fullmatch(d["contractId"]):
            raise canton.Fail(f"{what} gave a disclosed contract whose templateId or contractId is not one")
        contracts.append({k: d[k] for k in twin.DISCLOSED_KEYS})
    if len({c["contractId"] for c in contracts}) != len(contracts):
        raise canton.Fail(f"{what} disclosed a contract twice")
    return contracts


def parse_instrument(text: str) -> dict:
    admin, _, name = text.partition("/")   # a party id has no "/"
    if not PARTY_ID.fullmatch(admin) or not name:
        raise SystemExit(f"an instrument is ADMIN/ID (the admin party id, a slash, the instrument id), not {text!r}")
    return {"admin": admin, "id": name}


def transfer_of(sender: str, receiver: str, amount: str, instrument: dict, inputs: list) -> dict:
    return {"sender": sender, "receiver": receiver, "amount": amount, "instrumentId": instrument, "requestedAt": canton.utc(timedelta(minutes=-1)),
            "executeBefore": canton.utc(timedelta(hours=1)), "inputHoldingCids": inputs, "meta": {"values": {}}}


def gateway_tokens(net: canton.Network, template: str, instrument: dict) -> list:
    """The GatewayTokens (or proposals) of the operator's view for this instrument."""
    return [e for e in net.template("operator", "operator", canton.CHAIN + template) if e["createArgument"]["instrumentId"] == instrument]


def amount_of(text) -> int:
    """An amount as the ledger writes it, in units of 10^-10 (every token-standard amount has 10 decimals, as the wrapped token): anything else stops the command."""
    if not isinstance(text, str):
        raise canton.Fail(f"the ledger gave the amount {text!r}: not an amount")
    return twin.ledger_units(text)


def holdings(net: canton.Network, node: str, role: str, party: str, instrument: dict) -> list:
    """The holdings of the instrument that `party` owns, as the token standard's Holding views of the active contracts that `party` sees on `node` (read with `role`'s token): a list of
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
            if value.get("owner") == party and value["instrumentId"].get("admin") == instrument["admin"] and value["instrumentId"].get("id") == instrument["id"]:
                found.append((active["createdEvent"]["contractId"], amount_of(value.get("amount")), value.get("lock") is not None))
    return found


def balance_of(held: list) -> dict:
    return {"unlocked": twin.amount_text(sum(a for _, a, locked in held if not locked)), "locked": twin.amount_text(sum(a for _, a, locked in held if locked))}


def u_balance(net: canton.Network, instrument: dict) -> dict:
    party = net.party("u")
    return {"party": party, **balance_of(holdings(net, "users", "demo", party, instrument))}


def transfer_factory(net: canton.Network, registry, instrument: dict, transfer: dict, disclosed: list = None) -> dict:
    """The factory for a transfer, its choice context and disclosed contracts: the registry's answer, or, for a token with no registry, the registered GatewayToken's factory with no context."""
    if registry:
        return registry.factory(transfer, instrument["admin"])
    made = gateway_tokens(net, "GatewayToken", instrument)
    if len(made) != 1:
        raise canton.Fail(f"{instrument['id']} has no registry, and the operator sees {len(made)} GatewayTokens for it: there must be one for its factory")
    return {"factory": made[0]["createArgument"]["factory"], "kind": None, "data": NO_CONTEXT, "disclosed": disclosed_contracts(disclosed or [])}


def send_memo(net: canton.Network, registry, instrument: dict, amount: str, address: str, label: str = None, disclosed: list = None) -> dict:
    """U sends `amount` of the instrument to the gateway's party through the registry's transfer factory, with the EVM address as the memo (transfer.meta). The result is pending when the
    gateway holds no pre-approval: the instruction's contract id is what `instructions` shows and `take-back` withdraws."""
    if not canton.CANTON_AMOUNT.fullmatch(amount) or not twin.ledger_units(amount):
        raise SystemExit(f"the amount must be more than zero, with at most 10 decimals: {amount!r}")
    amount = amount if "." in amount else amount + ".0"
    canton.evm_address(address)   # checks the form; the memo keeps the text as given
    meta = {REASON_KEY: address, **({LABEL_KEY: canton.read_label(label)} if label is not None else {})}
    u, gateway = net.party("u"), net.party("gateway")
    held = sorted((h for h in holdings(net, "users", "demo", u, instrument) if not h[2]), key=lambda h: -h[1])
    if sum(a for _, a, _ in held) < twin.ledger_units(amount):
        raise canton.Fail(f"U holds {twin.amount_text(sum(a for _, a, _ in held))} {instrument['id']}, less than {amount}")
    before = u_balance(net, instrument)
    transfer = {**transfer_of(u, gateway, amount, instrument, [cid for cid, _, _ in held[:MAX_INPUTS]]), "meta": {"values": meta}}   # the fee may come out of more than the amount's own holdings
    asked = transfer_factory(net, registry, instrument, transfer, disclosed)
    command = {"ExerciseCommand": {"templateId": canton.TRANSFER_FACTORY, "contractId": asked["factory"], "choice": "TransferFactory_Transfer",
                                   "choiceArgument": {"expectedAdmin": instrument["admin"], "transfer": transfer, "extraArgs": {"context": asked["data"], "meta": {"values": {}}}}}}
    tx = twin.submit_for_transaction(net, "u", command, asked["disclosed"])
    output = twin.exercise_output(tx, asked["factory"], "TransferFactory_Transfer") or {}
    tag, instruction = output.get("tag"), None
    if tag == TRANSFER_PENDING:
        value = output.get("value")
        instruction = value.get("transferInstructionCid") if isinstance(value, dict) else None
        if not isinstance(instruction, str) or not CONTRACT_ID.fullmatch(instruction):
            raise canton.Fail(f"the transfer in update {tx['updateId']} is pending, and the result names no transfer instruction")
    elif tag != twin.TRANSFER_COMPLETED:
        raise canton.Fail(f"the transfer in update {tx['updateId']} did not complete: its result is {tag or 'not there'}, not {twin.TRANSFER_COMPLETED} or {TRANSFER_PENDING}")
    return {"updateId": tx["updateId"], "from": u, "to": gateway, "amount": amount, "meta": meta, "kind": asked["kind"], "result": tag, "instruction": instruction,
            "balance": {"before": before, "after": u_balance(net, instrument)}}


def instructions(net: canton.Network, instrument: dict = None) -> dict:
    """The gateway's party's active TransferInstruction views (read as the gateway, on the operator's participant) that have it as the receiver, of `instrument` if one is given."""
    gateway = net.party("gateway")
    offset = net.get("operator", "/v2/state/ledger-end", "operator")["offset"]
    view = {"InterfaceFilter": {"value": {"interfaceId": canton.TRANSFER_INSTRUCTION, "includeInterfaceView": True, "includeCreatedEventBlob": False}}}
    body = {"eventFormat": {"filtersByParty": {gateway: {"cumulative": [{"identifierFilter": view}]}}, "verbose": False}, "activeAtOffset": offset}
    found = []
    for entry in net.post("operator", "/v2/state/active-contracts", body, "operator"):
        active = entry["contractEntry"].get("JsActiveContract")
        for v in (active["createdEvent"].get("interfaceViews") or []) if active else []:
            if not str(v.get("interfaceId", "")).endswith(INSTRUCTION_VIEW):
                continue
            value = v.get("viewValue")
            transfer = value.get("transfer") if isinstance(value, dict) else None
            if not isinstance(transfer, dict):
                raise canton.Fail(f"{active['createdEvent'].get('contractId')} has a TransferInstruction view that has no transfer")
            if transfer.get("receiver") != gateway or (instrument and transfer.get("instrumentId") != instrument):
                continue
            meta = (transfer.get("meta") or {}).get("values") or {}
            found.append({"instruction": active["createdEvent"]["contractId"], "sender": transfer.get("sender"), "amount": transfer.get("amount"), "instrumentId": transfer.get("instrumentId"),
                          "executeBefore": transfer.get("executeBefore"), "status": value.get("status"), "meta": meta, "instructionMeta": (value.get("meta") or {}).get("values") or {},
                          "memo": meta.get(REASON_KEY)})
    return {"gateway": gateway, "instructions": found}


def take_back(net: canton.Network, registry, instrument: dict, instruction: str, disclosed: list = None) -> dict:
    """U withdraws its own pending transfer instruction: TransferInstruction_Withdraw with the registry's choice context for "withdraw" (none for a token with no registry)."""
    context = registry.accept_context(instruction, "withdraw") if registry else {"data": NO_CONTEXT, "disclosed": disclosed_contracts(disclosed or [])}
    command = {"ExerciseCommand": {"templateId": canton.TRANSFER_INSTRUCTION, "contractId": instruction, "choice": "TransferInstruction_Withdraw",
                                   "choiceArgument": {"extraArgs": {"context": context["data"], "meta": {"values": {}}}}}}
    tx = twin.submit_for_transaction(net, "u", command, context["disclosed"])
    output = twin.exercise_output(tx, instruction, "TransferInstruction_Withdraw") or {}
    return {"updateId": tx["updateId"], "instruction": instruction, "result": output.get("tag"), "balance": u_balance(net, instrument)}


def factory(net: canton.Network, registry, instrument: dict) -> dict:
    """The factory that the registry names for a transfer of the instrument from U to U (one has no inputs, nothing is sent)."""
    if not registry:
        raise SystemExit(f"factory needs the registry of {instrument['admin']}: --registry ADMIN=URL")
    u = net.party("u")
    asked = registry.factory(transfer_of(u, u, "1.0", instrument, []), instrument["admin"])
    return {"factory": asked["factory"], "template": asked["template"], "kind": asked["kind"]}


def secret_files(extra: set = frozenset()) -> set:
    """The token files that this run may read: the environment's and `extra`."""
    return {v for k, v in os.environ.items() if k.startswith(TOKEN_FILE_VARIABLE)} | set(extra)


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


def pairs(*sources: str) -> dict:
    """{ADMIN: value} of comma-separated `ADMIN=value` items; a later source wins for an admin."""
    found = {}
    for source in sources:
        for item in (source or "").split(","):
            admin, eq, value = item.strip().partition("=")
            if item.strip() and (not eq or not value):
                raise SystemExit(f"a registry setting is ADMIN=VALUE, not {item.strip()[:40]!r}")
            if eq:
                found[admin] = value
    return found


def registry_of(instrument: dict, options: dict):
    """The registry of the instrument's admin (--registry, else CZE_TOKEN_REGISTRIES), with its token file, or None for a token with no registry."""
    urls = pairs(os.environ.get(REGISTRIES), options.get("--registry"))
    files = pairs(os.environ.get(REGISTRY_TOKEN_FILES), options.get("--registry-token-file"))
    return Registry(urls[instrument["admin"]], files.get(instrument["admin"])) if instrument["admin"] in urls else None


def main(argv: list) -> dict:
    options = {}
    try:
        return run(argv, options)
    except canton.Fail as e:
        raise canton.Fail(scrubbed(str(e), secret_files(pairs(os.environ.get(REGISTRY_TOKEN_FILES), options.get("--registry-token-file")).values()))) from None


def run(argv: list, options: dict) -> dict:
    cmd = argv[:1]
    if cmd and cmd[0] in COMMAND_ROLES:
        names = {"send-memo": ("--label",), "instructions": (), "take-back": (), "factory": ()}[cmd[0]]
        args, found = twin.split_options(argv[1:], names + (() if cmd[0] == "instructions" else ("--registry", "--registry-token-file", "--disclosed")), __doc__)
        options.update(found)
        if not ARGS[cmd[0]][0] <= len(args) <= ARGS[cmd[0]][1]:
            raise SystemExit(__doc__)
        instrument = parse_instrument(args[0]) if args else None
        net = canton.Network()
        if net.external:
            net.check_roles(COMMAND_ROLES[cmd[0]])
        if cmd == ["instructions"]:
            return instructions(net, instrument)
        registry = registry_of(instrument, options)
        disclosed = None
        if "--disclosed" in options and not registry:
            try:
                disclosed = json.loads(Path(options["--disclosed"]).read_text())
            except (OSError, ValueError) as e:
                raise canton.Fail(f"cannot read the disclosed contracts {options['--disclosed']}: {e}") from None
            if not isinstance(disclosed, list):
                raise canton.Fail(f"the disclosed contracts {options['--disclosed']} must be a JSON list")
        if cmd == ["send-memo"]:
            return {"instrument": instrument, **send_memo(net, registry, instrument, args[1], args[2], options.get("--label"), disclosed)}
        if cmd == ["take-back"]:
            return {"instrument": instrument, **take_back(net, registry, instrument, args[1], disclosed)}
        return {"instrument": instrument, **factory(net, registry, instrument)}
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except canton.Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
