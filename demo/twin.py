#!/usr/bin/env python3
"""The Canton twins of ERC-20 tokens, for the demo: the vault that holds the tokens, and the twin's rules and balances. See apps/twin/README.md and gateway/README.md ("The vault").

  twin.py deploy-vault                  U creates a vault on Ostia: the creation code is a short fixed prefix that copies gateway/Vault.bin-runtime into memory and returns it,
                                        followed by those bytes. Waits for the receipt, and stops unless the code at the new address is exactly Vault.bin-runtime. Prints the
                                        address, the block, the gas used and the code hash. It does not register the vault: that is network/external/setup.py --contract-step
  twin.py rules <token>                 the gateway party (the twin's admin) creates the TwinRules of the ERC-20 at <token>, with the name, symbol and decimals that the token gives on Ostia
                                        (finalized block), unless the admin has them already: a second run changes nothing and prints the existing ones. Prints the contract id and the fields
  twin.py disclosed <token> <file>      writes the TwinRules of that token as one disclosed contract, {templateId, contractId, createdEventBlob, synchronizerId}, read as the gateway
                                        party with the created-event blob, to <file> (mode 0644): the file that network/external/setup.py --twin-rules-disclosed reads
  twin.py balances <token> [u|v|<party id> ...]
                                        each party's TwinHolding total of the instrument erc20:<token> of the gateway party (U and V if none is named); the twin's supply (every
                                        holding of the instrument that the admin sees: the holdings and the amounts locked in allocations); balanceOf(vault) at the finalized block
                                        on Ostia for each Vault of the chain's registry (the active ZkChain's `contracts`, read from the ledger), as a twin amount; and
                                        supplyMatches, whether the supply is the sum of the vaults' balances. An amount that a twin cannot hold exactly (finer than 10 decimals,
                                        or above 10^17 whole units) stops the command: nothing is rounded
  twin.py lock <u|v> <token> <amount> <receiver: u, v or a party id> <ref> --registry-url URL [--vault ADDRESS]
                                        an EVM holder locks <amount> of the ERC-20 in a vault, for a Canton receiver, and the twin is minted to the receiver. The amount is a decimal
                                        string, exact in the token's base units and a twin amount. It asks the twin registry service (apps/twin/registry) for the parts of the lock,
                                        then does the payer's own checks and sends nothing if one fails: the lock id must be sha256("lock,<receiver>,<ref>") worked out here, and the
                                        vault must be a Vault of the active ZkChain's registry on the ledger (the first one, or --vault, which must be registered); the registry's list
                                        of vaults is a hint and is not read. Then it approves the gateway and calls pay(lockId, token, vault, amount) with that key, waits for the
                                        receipt, and waits (up to 10 minutes) until the receiver holds the TwinHolding that the lock's leg minted. Prints the pay transaction, its
                                        block, the lock id, the vault and the holding's contract id
  twin.py send <from: u|v> <to: u, v or a party id> <token> <amount> --registry-url URL
                                        sends twin through the token standard: the registry service's transfer factory for the transfer (expectedAdmin is the gateway party, the sender's own
                                        TwinHolding cids that cover the amount, empty meta), checked to be a TwinRules of the gateway party on the ledger with its disclosure, then
                                        TransferFactory_Transfer as the sender with the answer's choice context and disclosed contracts. Stops unless the result is
                                        TransferInstructionResult_Completed. Prints the update id
  twin.py redeem <u|v> <token> <amount> <evm address> <ref> [--vault ADDRESS]
                                        the holder signs a RedeemRequest (the chain id, the ERC-20, the holder's TwinHolding cids that cover the amount, the amount, the recipient, the ref
                                        and the chain's parties), then key U calls release(ref, token, recipient, amount in base units) on the vault (the first registered one, or --vault,
                                        which must be registered). Before the request it stops if the release id is used already, or the vault holds less than the amount. Waits for the
                                        receipt and (up to 10 minutes) until the RedeemRequest is archived, which is the release leg burning the twin. Prints the release transaction,
                                        its block, the release id and the request's contract id. The ref must be unique: make it from a fresh random value

All Ostia calls go through demo/evm.py (CZE_RPC_URL, CZE_STATE_DIR and the key U), all Canton ones through demo/canton.py's network, so its settings apply. Every command prints one JSON object; `FAIL: <why>` and exit status 1 when it cannot.
"""
import hashlib, json, os, re, sys, time, urllib.error, urllib.request, uuid
from datetime import timedelta
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import canton, evm

ROOT = canton.ROOT
VAULT_CODE = ROOT / "gateway" / "Vault.bin-runtime"
# The creation code: PUSH2 <length>, DUP1, PUSH1 <offset>, PUSH1 0, CODECOPY, PUSH1 0, RETURN, then the runtime code. CODECOPY(0, offset, length)
# copies it to memory, RETURN(0, length) hands it to the chain. The prefix is 12 bytes, so the runtime code starts at offset 12.
PREFIX_BYTES = 12
MAX_CODE_BYTES = 0xFFFF   # what PUSH2 can say; a contract is never larger than 24,576
VAULT_GAS = 800_000       # 53,000 + 200 per byte of code is about 360,000 for the vault, and the transaction's own data on top
RECEIPT_SECONDS = 600
TWIN = "#ostia-twin:Twin.Twin:"
TWIN_RULES, TWIN_HOLDING, TWIN_ALLOCATION = TWIN + "TwinRules", TWIN + "TwinHolding", TWIN + "TwinAllocation"
TWIN_DECIMALS = 10   # every twin has 10 decimals, like a Daml Decimal (apps/twin/README.md, "Amounts")
TWIN_LIMIT = 10**27  # in units of 10^-10: 10^17 whole units, the most a Decimal of the twin holds
ADMIN = "gateway"   # the Canton party that is the twin's admin; the operator's user acts for it
COMMAND_ROLES = {"rules": ("operator",), "disclosed": ("operator",), "balances": ("operator",), "lock": ("operator",), "send": ("demo", "operator"), "redeem": ("demo", "operator")}   # the roles whose tokens a command reads; deploy-vault touches no Canton
SELECTOR_DECIMALS = "313ce567"
READ_AT = "finalized"   # what Canton has committed; a token that is not there yet is not a token to make a twin of
WAIT_SECONDS = 600   # the longest that a command waits for Canton to follow Ostia (a lock's mint, a release's burn)
MINT_REFERENCE = "romeprotocol.com/mint-reference"   # the key under which a minted TwinHolding keeps the reference that Mint was given (apps/twin Twin.daml, metaKey)
REGISTRY_URL = re.compile(r"https?://[^/\s?#]+(/[^\s?#]*)?")
MAX_ANSWER = 1_000_000   # the most that a registry's answer may be: it is read from a server that this command does not trust
AMOUNT = re.compile(r"[0-9]+(?:\.[0-9]+)?")
MAX_AMOUNT_TEXT = 80
TRANSFER_COMPLETED = "TransferInstructionResult_Completed"
REDEEM_REQUEST = canton.CHAIN + "RedeemRequest"
RELEASE_GAS = 600_000   # the vault's release: an approval and the gateway's pay, a token's transferFrom in it
DISCLOSED_KEYS = ("templateId", "contractId", "createdEventBlob", "synchronizerId")


def runtime_code(path: Path = None) -> bytes:
    """The vault's runtime code, from gateway/Vault.bin-runtime (hex without 0x)."""
    path = path or VAULT_CODE
    try:
        code = bytes.fromhex(path.read_text().strip())
    except (OSError, ValueError) as e:
        raise canton.Fail(f"cannot read the vault's runtime code {path}: {e}") from None
    if not code or len(code) > MAX_CODE_BYTES:
        raise canton.Fail(f"{path} holds {len(code)} bytes: not a runtime code of 1 to {MAX_CODE_BYTES} bytes")
    return code


def creation_code(code: bytes) -> str:
    """The creation code (hex, no 0x) of a contract with this runtime code and no constructor: the 12-byte prefix, then the code."""
    prefix = bytes([0x61]) + len(code).to_bytes(2, "big") + bytes([0x80, 0x60, PREFIX_BYTES, 0x60, 0x00, 0x39, 0x60, 0x00, 0xF3])
    assert len(prefix) == PREFIX_BYTES
    return (prefix + code).hex()


def wait_receipt(tx: str, seconds: int = RECEIPT_SECONDS) -> dict:
    """The receipt of the transaction once it is in a block (latest, not finalized: the code check that follows reads the latest block too)."""
    deadline = time.time() + seconds
    while evm.rpc("eth_getTransactionReceipt", [tx]) is None:
        if time.time() > deadline:
            raise canton.Fail(f"{tx} is in no block after {seconds} seconds")
        time.sleep(float(os.environ.get("CZE_POLL_SECONDS", "1")))
    return evm.receipt_of(tx)


def deploy_vault() -> dict:
    code = runtime_code()
    tx = evm.send(evm.state_dir(), "u", None, creation_code(code), VAULT_GAS)
    receipt = wait_receipt(tx)
    if receipt["status"] != 1 or not receipt["contract"]:
        raise canton.Fail(f"the vault's creation {tx} in block {receipt['block']} did not make a contract (status {receipt['status']})")
    address = receipt["contract"].lower()
    there = bytes.fromhex(evm.rpc("eth_getCode", [address, "latest"]).removeprefix("0x"))
    if there != code:
        raise canton.Fail(f"the code at {address} is not gateway/Vault.bin-runtime ({len(there)} bytes there, {len(code)} expected)")
    return {"address": address, "tx": tx, "block": receipt["block"], "gasUsed": receipt["gasUsed"], "codeHash": "0x" + evm.keccak(there).hex()}


def erc20_decimals(token: str) -> int:
    """The token's decimals() on Ostia, 0 to 36 (the range TwinRules takes)."""
    answer = evm.rpc("eth_call", [{"to": token, "data": "0x" + SELECTOR_DECIMALS}, READ_AT])
    if answer == "0x":
        raise canton.Fail(f"no decimals() at {token} on the {READ_AT} block: is there a token there?")
    decimals = int(answer, 16)
    if decimals > 36:
        raise canton.Fail(f"{token} says it has {decimals} decimals: a twin takes 0 to 36")
    return decimals


def erc20_text(token: str, signature: str) -> str:
    text = evm.read_text(token, signature, READ_AT)
    if not text:
        raise canton.Fail(f"no {signature} at {token} on the {READ_AT} block" if text is None else f"{signature} at {token} is empty: a twin needs a name and a symbol")
    return text


def rules_of(net: canton.Network, token: str, blob: bool = False) -> list:
    """The TwinRules of this admin for the token (40 lowercase hex digits), as the admin sees them."""
    admin = net.party(ADMIN)
    return [e for e in net.template("operator", ADMIN, TWIN_RULES, blob=blob) if e["createArgument"]["admin"] == admin and e["createArgument"]["token"] == token]


def rules(net: canton.Network, address: str) -> dict:
    token = canton.evm_address(address)
    found = rules_of(net, token)
    created = not found
    if created:
        fields = {"admin": net.party(ADMIN), "token": token, "name": erc20_text("0x" + token, "name()"), "symbol": erc20_text("0x" + token, "symbol()"),
                  "decimals": str(erc20_decimals("0x" + token))}   # an Int goes as text in the JSON Ledger API
        net.submit("operator", [ADMIN], {"CreateCommand": {"templateId": TWIN_RULES, "createArguments": fields}}, user="operator")
        found = net.wait_for("the twin's rules", lambda: rules_of(net, token))
    if len(found) != 1:
        raise canton.Fail(f"the admin has {len(found)} TwinRules for {token}: there must be one")
    fields = found[0]["createArgument"]
    return {"created": created, "contractId": found[0]["contractId"], "admin": fields["admin"], "token": fields["token"], "name": fields["name"],
            "symbol": fields["symbol"], "decimals": int(fields["decimals"]), "instrument": "erc20:" + fields["token"]}


def disclosed(net: canton.Network, address: str, out: str) -> dict:
    """The token's TwinRules as a disclosed contract, in the file shape of setup.py's read_rules_disclosed (one object)."""
    token = canton.evm_address(address)
    found = rules_of(net, token, blob=True)
    if len(found) != 1:
        raise canton.Fail(f"expected one TwinRules of the admin for {token}, found {len(found)}" + (" (twin.py rules makes it)" if not found else ""))
    event = found[0]
    contract = {"templateId": event["templateId"], "contractId": event["contractId"], "createdEventBlob": event.get("createdEventBlob"), "synchronizerId": event.get("synchronizerId")}
    missing = [k for k, v in contract.items() if not isinstance(v, str) or not v]
    if missing:
        raise canton.Fail(f"the ledger gave the rules without {', '.join(missing)}")
    path = Path(out)
    path.write_text(json.dumps(contract))
    path.chmod(0o644)
    return {"file": str(path), "contractId": contract["contractId"], "templateId": contract["templateId"], "synchronizerId": contract["synchronizerId"]}


def twin_units(base_units: int, decimals: int, what: str) -> int:
    """An ERC-20 amount as a twin amount, in units of 10^-10: Twin.Amount.fromBaseUnits. Exact: a token of more than 10 decimals converts only when the amount is a whole
    number of twin units, and an amount above 10^17 whole units does not fit. Anything else stops the command."""
    if decimals <= TWIN_DECIMALS:
        units = base_units * 10 ** (TWIN_DECIMALS - decimals)
    else:
        units, rest = divmod(base_units, 10 ** (decimals - TWIN_DECIMALS))
        if rest:
            raise canton.Fail(f"{what}: {base_units} base units of a {decimals}-decimal token are finer than a twin amount (10 decimals)")
    if units >= TWIN_LIMIT:
        raise canton.Fail(f"{what}: {base_units} base units are above 10^17 whole units, more than a twin amount holds")
    return units


def ledger_units(text: str) -> int:
    """A Daml Decimal as the ledger writes it ("10.0000000000"), in units of 10^-10. The ledger never gives a finer one."""
    units = Decimal(text).scaleb(TWIN_DECIMALS)
    if units != units.to_integral_value() or units < 0:
        raise canton.Fail(f"the ledger gave the amount {text!r}: not a twin amount")
    return int(units)


def amount_text(units: int) -> str:
    return evm.wrapped_text(units)   # as Canton writes an amount: "10.0", "0.0000000001"


def party_of(net: canton.Network, who: str) -> str:
    if who in ("u", "v"):
        return net.party(who)
    if "::" not in who:
        raise SystemExit(f"a party is u, v or a party id (name::fingerprint), not {who!r}")
    return who


def balances(net: canton.Network, address: str, who: list) -> dict:
    token = canton.evm_address(address)
    admin, instrument = net.party(ADMIN), "erc20:" + token
    decimals = erc20_decimals("0x" + token)
    mine = lambda e: e["createArgument"]["admin"] == admin and e["createArgument"]["token"] == token
    held = [e["createArgument"] for e in net.template("operator", ADMIN, TWIN_HOLDING) if mine(e)]
    locked = [e["createArgument"]["allocation"]["transferLeg"] for e in net.template("operator", ADMIN, TWIN_ALLOCATION) if mine(e)]
    parties = {name: party_of(net, name) for name in who or ["u", "v"]}
    holders = {name: {"party": party, "amount": amount_text(sum(ledger_units(h["amount"]) for h in held if h["owner"] == party))} for name, party in parties.items()}
    in_allocations = sum(ledger_units(leg["amount"]) for leg in locked)
    supply = sum(ledger_units(h["amount"]) for h in held) + in_allocations
    vaults, total = [], 0
    for entry in canton.chain_record(net).get("contracts") or []:
        if entry["contractKind"] != "Vault":
            continue
        vault = entry["contractAddress"]
        base = evm.read_word("0x" + token, evm.SELECTOR_BALANCE_OF + evm.pad32(vault), READ_AT)
        units = twin_units(base, decimals, f"the vault 0x{vault}")
        vaults.append({"address": "0x" + vault, "baseUnits": str(base), "amount": amount_text(units)})
        total += units
    return {"token": "0x" + token, "instrument": instrument, "admin": admin, "decimals": decimals, "holders": holders, "supply": amount_text(supply),
            "lockedInAllocations": amount_text(in_allocations), "vaults": vaults, "vaultsTotal": amount_text(total), "supplyMatches": supply == total}


def lock_id(receiver: str, ref: str) -> str:
    """The id of the EVM payment that locks an ERC-20 for `receiver` under `ref`: the SHA-256, in lowercase hex, of "lock,<receiver party id>,<ref>" (Chain.daml's lockId)."""
    return hashlib.sha256(f"lock,{receiver},{ref}".encode()).hexdigest()


def release_id(vault: str, ref: str) -> str:
    """The id of the EVM payment that the vault's release(ref, ...) makes: the SHA-256, in lowercase hex, of "vault-release,<vault, 40 lowercase hex digits>,<ref>"
    (Chain.daml's releaseId, Vault.releaseId)."""
    return hashlib.sha256(f"vault-release,{vault},{ref}".encode()).hexdigest()


def base_units(text: str, decimals: int) -> int:
    """An amount as a decimal string ("12.5") in the token's base units, exactly: it stops on an amount that is not a whole number of base units, is zero, or that a twin
    cannot hold (finer than 10 decimals, above 10^17 whole units). Integer arithmetic only: no rounding anywhere."""
    if len(text) > MAX_AMOUNT_TEXT or not AMOUNT.fullmatch(text):
        raise SystemExit(f"the amount must be a decimal number such as 12 or 12.5, not {text[:MAX_AMOUNT_TEXT]!r}")
    whole, _, fraction = text.partition(".")
    fraction = fraction.rstrip("0")
    if len(fraction) > decimals:
        raise canton.Fail(f"the amount {text} is not a whole number of base units of a {decimals}-decimal token")
    units = int(whole) * 10**decimals + int(fraction.ljust(decimals, "0") or "0")
    if units == 0:
        raise canton.Fail("the amount must be more than zero")
    twin_units(units, decimals, f"the amount {text}")
    return units


def registered_vaults(net: canton.Network) -> list:
    """The Vault entries of the active ZkChain's registry, as 40 lowercase hex digits, in the order they were registered: the vaults that Daml trusts."""
    return [e["contractAddress"].lower().removeprefix("0x") for e in canton.chain_record(net).get("contracts") or [] if e["contractKind"] == "Vault"]


def choose_vault(vaults: list, wanted: str = None) -> str:
    """The vault to pay into or to release from: the one asked for, which must be registered, or the first registered one."""
    if not vaults:
        raise canton.Fail("the chain's registry has no Vault: nothing to lock into or release from (network/external/setup.py --contract-step registers one)")
    if wanted is None:
        return vaults[0]
    vault = canton.evm_address(wanted)
    if vault not in vaults:
        raise canton.Fail(f"0x{vault} is not a Vault of the chain's registry ({', '.join('0x' + v for v in vaults)})")
    return vault


def registry_url_of(text: str) -> str:
    if not text or not REGISTRY_URL.fullmatch(text):
        raise SystemExit(f"--registry-url must be an http or https URL, not {text!r}")
    return text.rstrip("/")


def post_json(url: str, body: dict) -> dict:
    """What a registry service answers to a JSON POST, for a server that is not trusted: bounded in size, and an object or nothing."""
    request = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as r:
            data = r.read(MAX_ANSWER + 1)
    except urllib.error.HTTPError as e:
        with e:
            raise canton.Fail(f"{url}: {e.code} {e.read(500).decode(errors='replace')}") from None
    except (urllib.error.URLError, OSError) as e:
        raise canton.Fail(f"{url}: {e}") from None
    if len(data) > MAX_ANSWER:
        raise canton.Fail(f"{url} answered with more than {MAX_ANSWER} bytes")
    try:
        answer = json.loads(data)
    except ValueError:
        raise canton.Fail(f"{url} did not answer with JSON") from None
    if not isinstance(answer, dict):
        raise canton.Fail(f"{url} did not answer with a JSON object")
    return answer


def send_checked(who: str, to: str, signature: str, values: list, gas: int, what: str) -> dict:
    """A transaction of U's or V's key, waited for in a block: the receipt, with the transaction's hash, and a stop if it did not succeed."""
    tx = evm.send(evm.state_dir(), who, to, evm.call_data(signature, values), gas)
    receipt = wait_receipt(tx)
    if receipt["status"] != 1:
        raise canton.Fail(f"{what} {tx} reverted in block {receipt['block']}")
    return {"tx": tx, **receipt}


def lock(net: canton.Network, who: str, address: str, amount: str, receiver: str, ref: str, registry_url: str, vault: str = None) -> dict:
    """An EVM holder locks `amount` of an ERC-20 in a registered vault for a Canton receiver: the payer's own checks (apps/twin/registry/README.md, "What a payer
    checks") come first and nothing is sent unless they pass; then approve and pay(lockId, token, vault, amount) through the gateway; then wait for the mint."""
    who, token = evm.who_sends(who), canton.evm_address(address)
    if not ref:
        raise SystemExit("the ref must not be empty")
    base = base_units(amount, erc20_decimals("0x" + token))
    party = party_of(net, receiver)
    expected = lock_id(party, ref)
    paid = choose_vault(registered_vaults(net), vault)   # from the ledger: the registry's list is a hint only
    answer = post_json(registry_url_of(registry_url) + "/twin/v1/lock-parts", {"receiver": party, "ref": ref, "token": token})
    if answer.get("lockId") != expected:
        raise canton.Fail(f"the registry gave the lock id {answer.get('lockId')!r}, not the {expected} that lock,{party},{ref} makes: nothing was sent")
    gateway, erc20 = evm.gateway_address(), evm.address_of("0x" + token, "the token")
    approved = send_checked(who, erc20, "approve(address,uint256)", [gateway, base], evm.APPROVE_GAS, "the approval")
    paid_tx = send_checked(who, gateway, "pay(bytes32,address,address,uint256)", [evm.id_of(expected), erc20, evm.address_of("0x" + paid, "the vault"), base], evm.PAY_GAS, "the lock payment")
    admin = net.party(ADMIN)

    def minted():
        for e in net.template("operator", ADMIN, TWIN_HOLDING):
            a = e["createArgument"]
            if a["admin"] == admin and a["token"] == token and a["owner"] == party and (a.get("meta") or {}).get("values", {}).get(MINT_REFERENCE) == expected:
                return e
    holding = net.wait_for("the twin to be minted", minted, WAIT_SECONDS)
    return {"tx": paid_tx["tx"], "block": paid_tx["block"], "approveTx": approved["tx"], "lockId": expected, "vault": "0x" + paid, "receiver": party,
            "holding": holding["contractId"], "amount": holding["createArgument"]["amount"]}


def holdings_of(net: canton.Network, who: str, token: str) -> list:
    """The TwinHoldings of the twin (the gateway party's, of this token) that u or v owns, as (contract id, units of 10^-10), as the owner's participant shows them."""
    admin, owner = net.party(ADMIN), net.party(who)
    return [(e["contractId"], ledger_units(e["createArgument"]["amount"])) for e in net.template("users", who, TWIN_HOLDING)
            if e["createArgument"]["admin"] == admin and e["createArgument"]["token"] == token and e["createArgument"]["owner"] == owner]


def pick_holdings(held: list, units: int, who: str) -> list:
    """The contract ids of the fewest holdings (the largest first) that add up to at least `units`; a stop if all of them together are less."""
    chosen, total = [], 0
    for cid, amount in sorted(held, key=lambda h: -h[1]):
        if total >= units:
            break
        chosen.append(cid)
        total += amount
    if total < units:
        raise canton.Fail(f"{who} holds {amount_text(sum(a for _, a in held))} of the twin, less than {amount_text(units)}")
    return chosen


def factory_answer(answer: dict, rules: list) -> tuple:
    """The factory, the choice context and the disclosed contracts of a registry's answer to a transfer factory request, from a server that is not trusted: the factory
    must be a TwinRules of the gateway party that the ledger shows and must come with its disclosure, so a registry cannot point the sender at another contract."""
    factory, context = answer.get("factoryId"), answer.get("choiceContext")
    data, disclosed = (context.get("choiceContextData"), context.get("disclosedContracts")) if isinstance(context, dict) else (None, None)
    if not isinstance(factory, str) or not isinstance(data, dict) or not isinstance(disclosed, list):
        raise canton.Fail("the registry's answer has no factoryId and choiceContext with choiceContextData and disclosedContracts")
    if factory not in rules:
        raise canton.Fail(f"the registry named the factory {factory[:16]}, which is not a TwinRules of the gateway party for this token on the ledger")
    contracts = []
    for d in disclosed:
        if not isinstance(d, dict) or any(not isinstance(d.get(k), str) or not d[k] for k in DISCLOSED_KEYS):
            raise canton.Fail(f"the registry gave a disclosed contract without {', '.join(DISCLOSED_KEYS)}")
        contracts.append({k: d[k] for k in DISCLOSED_KEYS})
    if factory not in [d["contractId"] for d in contracts]:
        raise canton.Fail("the registry did not disclose the factory it named")
    return factory, data, contracts


def submit_for_transaction(net: canton.Network, acting: str, command: dict, disclosed: list) -> dict:
    """The command of u or v, submitted and waited for, with the transaction's effects (submit-and-wait only gives the update id, and the result of a choice is in the exercised event)."""
    party = net.party(acting)
    everything = {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}
    body = {"commands": {"commands": [command], "commandId": str(uuid.uuid4()), "userId": net.user(canton.USER), "actAs": [party], "disclosedContracts": disclosed},
            "transactionFormat": {"eventFormat": {"filtersByParty": {party: everything}, "verbose": False}, "transactionShape": "TRANSACTION_SHAPE_LEDGER_EFFECTS"}}
    tx = net.post("users", "/v2/commands/submit-and-wait-for-transaction", body, canton.USER).get("transaction")
    if not isinstance(tx, dict) or not tx.get("updateId"):
        raise canton.Fail("the ledger gave no transaction for the command")
    return tx


def send(net: canton.Network, sender: str, receiver: str, address: str, amount: str, registry_url: str) -> dict:
    """u or v sends twin to a party through the token standard: the transfer factory of the registry service, then TransferFactory_Transfer as the sender with the factory's context and
    disclosed contracts. The twin completes a transfer at once, so the result must be TransferInstructionResult_Completed."""
    if sender not in ("u", "v"):
        raise SystemExit(f"the sender must be u or v, not {sender!r}")
    token = canton.evm_address(address)
    decimals = erc20_decimals("0x" + token)
    units = twin_units(base_units(amount, decimals), decimals, f"the amount {amount}")
    to, admin = party_of(net, receiver), net.party(ADMIN)
    inputs = pick_holdings(holdings_of(net, sender, token), units, sender)
    transfer = {"sender": net.party(sender), "receiver": to, "amount": amount_text(units), "instrumentId": {"admin": admin, "id": "erc20:" + token},
                "requestedAt": canton.utc(timedelta(minutes=-1)), "executeBefore": canton.utc(timedelta(hours=1)), "inputHoldingCids": inputs, "meta": {"values": {}}}
    arguments = {"expectedAdmin": admin, "transfer": transfer, "extraArgs": {"context": {"values": {}}, "meta": {"values": {}}}}
    answer = post_json(registry_url_of(registry_url) + "/registry/transfer-instruction/v1/transfer-factory", {"choiceArguments": arguments})
    factory, data, disclosed = factory_answer(answer, [e["contractId"] for e in rules_of(net, token)])
    command = {"ExerciseCommand": {"templateId": canton.TRANSFER_FACTORY, "contractId": factory, "choice": "TransferFactory_Transfer",
                                   "choiceArgument": {**arguments, "extraArgs": {"context": data, "meta": {"values": {}}}}}}
    tx = submit_for_transaction(net, sender, command, disclosed)
    exercised = [e["ExercisedEvent"] for e in tx.get("events", []) if "ExercisedEvent" in e and e["ExercisedEvent"].get("choice") == "TransferFactory_Transfer"
                 and e["ExercisedEvent"].get("contractId") == factory]
    result = exercised[0].get("exerciseResult") if len(exercised) == 1 else None
    tag = ((result or {}).get("output") or {}).get("tag") if isinstance(result, dict) else None
    if tag != TRANSFER_COMPLETED:
        raise canton.Fail(f"the transfer in update {tx['updateId']} did not complete: its result is {tag or 'not there'}, not {TRANSFER_COMPLETED}")
    return {"updateId": tx["updateId"], "from": sender, "to": to, "amount": transfer["amount"], "instrument": "erc20:" + token, "factory": factory,
            "inputs": inputs, "result": tag}


def redeem(net: canton.Network, holder: str, address: str, amount: str, recipient: str, ref: str, vault: str = None) -> dict:
    """u or v redeems twin for the ERC-20: the holder signs a RedeemRequest (the holdings that cover the amount, the amount, the EVM recipient and the ref), then key U calls the vault's
    release(ref, token, recipient, amount), which the chain's release leg matches to the request by the release id and burns the twin against. What can be seen to fail
    afterwards (the id used already, the vault short of the token) is looked at first, so no request is made that the vault cannot pay."""
    if holder not in ("u", "v"):
        raise SystemExit(f"the holder must be u or v, not {holder!r}")
    token, to = canton.evm_address(address), canton.evm_address(recipient)
    if not ref:
        raise SystemExit("the ref must not be empty")
    decimals = erc20_decimals("0x" + token)
    base = base_units(amount, decimals)
    units = twin_units(base, decimals, f"the amount {amount}")
    paying = choose_vault(registered_vaults(net), vault)
    chain, admin = canton.chain_record(net), net.party(ADMIN)
    if chain["gateway"] != admin:
        raise canton.Fail(f"the chain's gateway party is {chain['gateway']}, not the twin's admin {admin}")
    inputs = pick_holdings(holdings_of(net, holder, token), units, holder)
    rid, gateway = release_id(paying, ref), evm.gateway_address()
    if evm.read_word(gateway, evm.call_data("used(bytes32)", [bytes.fromhex(rid)]), "latest"):
        raise canton.Fail(f"the release id {rid} of this ref in vault 0x{paying} is used already: use another ref")
    held = evm.read_word("0x" + token, evm.SELECTOR_BALANCE_OF + evm.pad32(paying), "latest")
    if held < base:
        raise canton.Fail(f"the vault 0x{paying} holds {held} base units of 0x{token}, less than the {base} to release")
    owner = net.party(holder)
    request = {"holder": owner, "operator": chain["operator"], "confirmer": chain["confirmer"], "gateway": chain["gateway"], "builder": chain["builder"], "chainId": str(chain["chainId"]),
               "token": token, "holdings": inputs, "amount": amount_text(units), "recipient": to, "ref": ref}   # an Int goes as text in the JSON Ledger API
    open_requests = lambda: [e for e in net.template("users", holder, REDEEM_REQUEST) if e["createArgument"]["holder"] == owner and e["createArgument"]["ref"] == ref]
    net.submit("users", [holder], {"CreateCommand": {"templateId": REDEEM_REQUEST, "createArguments": request}})
    cid = net.wait_for("the redeem request", open_requests)[0]["contractId"]
    try:
        released = send_checked("u", evm.address_of("0x" + paying, "the vault"), "release(string,address,address,uint256)",
                                [ref, evm.address_of("0x" + token, "the token"), evm.address_of("0x" + to, "the recipient"), base], RELEASE_GAS, "the release")
    except canton.Fail as e:
        raise canton.Fail(f"{e}; the redeem request {cid} is still open") from None
    net.wait_for("the release to burn the twin", lambda: cid not in [e["contractId"] for e in open_requests()] or None, WAIT_SECONDS)
    return {"tx": released["tx"], "block": released["block"], "releaseId": rid, "vault": "0x" + paying, "recipient": "0x" + to, "amount": request["amount"], "baseUnits": str(base),
            "request": cid, "requestArchived": True}


def split_options(argv: list, names: tuple) -> tuple:
    """The arguments without the options `--name value` of `names`, and the options' values. An option twice, with no value, or one that is not named stops the command."""
    rest, found, i = [], {}, 0
    while i < len(argv):
        if argv[i].startswith("--"):
            if argv[i] not in names or argv[i] in found or i + 1 >= len(argv):
                raise SystemExit(__doc__)
            found[argv[i]] = argv[i + 1]
            i += 2
        else:
            rest.append(argv[i])
            i += 1
    return rest, found


def main(argv: list) -> dict:
    n, cmd = len(argv), argv[:1]
    if argv == ["deploy-vault"]:
        return deploy_vault()
    if cmd and cmd[0] in COMMAND_ROLES:
        net = canton.Network()
        if net.external:
            net.check_roles(COMMAND_ROLES[cmd[0]])
        if cmd == ["rules"] and n == 2:
            return rules(net, argv[1])
        if cmd == ["disclosed"] and n == 3:
            return disclosed(net, argv[1], argv[2])
        if cmd == ["balances"] and n >= 2:
            return balances(net, argv[1], argv[2:])
        if cmd == ["lock"]:
            args, options = split_options(argv[1:], ("--registry-url", "--vault"))
            if len(args) == 5 and "--registry-url" in options:
                return lock(net, args[0], args[1], args[2], args[3], args[4], options["--registry-url"], options.get("--vault"))
        if cmd == ["send"]:
            args, options = split_options(argv[1:], ("--registry-url",))
            if len(args) == 4 and "--registry-url" in options:
                return send(net, args[0], args[1], args[2], args[3], options["--registry-url"])
        if cmd == ["redeem"]:
            args, options = split_options(argv[1:], ("--vault",))
            if len(args) == 5:
                return redeem(net, args[0], args[1], args[2], args[3], args[4], options.get("--vault"))
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except canton.Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
