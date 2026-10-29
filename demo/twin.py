#!/usr/bin/env python3
"""The Canton twins of ERC-20 tokens, for the demo: the vault that holds the tokens, and the twin's rules and balances. See apps/twin/README.md and gateway/README.md ("The vault").

  twin.py deploy-vault                  U creates a vault on Ostia: the creation code is a short fixed prefix that copies gateway/Vault.bin-runtime into memory and returns it,
                                        followed by those bytes. Waits for the receipt, and stops unless the code at the new address is exactly Vault.bin-runtime. Prints the
                                        address, the block, the gas used and the code hash. It does not register the vault: that is network/external/setup.py --contract-step
  twin.py rules <token>                 the gateway party (the twin's admin) creates the TwinRules of the ERC-20 at <token>, with the name, symbol and decimals that the token gives on Ostia
                                        (finalized block), unless the admin has them already: a second run changes nothing and prints the existing ones. Prints the contract id and the fields
  twin.py disclosed <token> <file>      writes the TwinRules of that token as one disclosed contract, {templateId, contractId, createdEventBlob, synchronizerId}, read as the gateway
                                        party with the created-event blob, to <file> (mode 0644): the file that network/external/setup.py --twin-rules-disclosed reads

All Ostia calls go through demo/evm.py (CZE_RPC_URL, CZE_STATE_DIR and the key U), all Canton ones through demo/canton.py's network, so its settings apply. Every command prints one JSON object; `FAIL: <why>` and exit status 1 when it cannot.
"""
import json, os, sys, time
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
TWIN_RULES = TWIN + "TwinRules"
ADMIN = "gateway"   # the Canton party that is the twin's admin; the operator's user acts for it
COMMAND_ROLES = {"rules": ("operator",), "disclosed": ("operator",)}   # the roles whose tokens a command reads; deploy-vault touches no Canton
SELECTOR_DECIMALS = "313ce567"
READ_AT = "finalized"   # what Canton has committed; a token that is not there yet is not a token to make a twin of


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
    raise SystemExit(__doc__)


if __name__ == "__main__":
    try:
        result = main(sys.argv[1:])
    except canton.Fail as e:
        print(f"FAIL: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))
