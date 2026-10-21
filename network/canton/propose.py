#!/usr/bin/env python3
"""Creates the chain on Canton and registers tokens with it. See network/README.md.

  propose.py [chain] --genesis-hash <hex> --genesis-state-root <hex> --program-vk <hex> --root-c <hex> --rules-hash <hex>
             [--gateway-address <hex>]

    The operator and the gateway propose the chain, the confirmer accepts it. The values are plain hex without 0x.
    The chain id, the gas cap and the gateway contract's address come from PINS. Prints one JSON line: the chain's
    head after Accept. Refuses to run if a ZkChain already exists.

  propose.py token --evm-token <address> --instrument-admin <party> --instrument-id <id> --factory <contract id>
             [--reth-url <url>]

    The operator and the gateway propose that the wrapped token at <address> stands for the Canton instrument
    (<party>, <id>), whose registry's transfer factory is <contract id>; the confirmer accepts. Before the proposal it
    asks reth, at the finalized block, whether the gateway contract made that token, and stops if it did not.
    Prints one JSON line: the registered token. Refuses to run if the token is registered or proposed already.

The parties come from $CZE_STATE_DIR/canton/parties.env (written by bootstrap.canton). The operator's Ledger API is
CZE_LEDGER_URL (default http://127.0.0.1:7575), the confirmer's is CZE_CONFIRMER_LEDGER_URL (default
http://127.0.0.1:7576); reth's is --reth-url (default http://127.0.0.1:$RETH_HTTP_PORT, port 8545 unless set). The
local network runs without Ledger API authentication. The operator's Ledger API user acts for the gateway party too.

On an existing participant (network/external/, the Canton Network): CZE_USER_PREFIX is put before the Ledger API user ids
(operator, confirmer), CZE_TOKEN_FILE_<ROLE> (OPERATOR, CONFIRMER, ...) names a file, mode 0600, that holds that user's bearer
token, and both Ledger API URLs are the one participant's. The token is read from the file, sent as a header and never printed.
"""
import argparse, json, os, re, stat, sys, time, urllib.request, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PKG = "#canton-zk-evm:Zk.Chain:"
HEX = re.compile(r"^[0-9a-f]+$")
ADDRESS = re.compile(r"^[0-9a-f]{40}$")
# The first four bytes of the Keccak-256 of "wrapped(address)": the gateway contract's public getter for the tokens it made.
# tests/test_propose.py works the value out again.
WRAPPED_SELECTOR = "c034091d"


def read_env_file(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def read_token(path: str) -> str:
    """A bearer token from a file that only its owner can read. The error says which file and what is wrong, never the token."""
    try:
        mode = os.stat(path).st_mode
        if mode & (stat.S_IRWXG | stat.S_IRWXO):
            raise SystemExit(f"the token file {path} can be read by others: chmod 600 it")
        token = Path(path).read_text().strip()
    except OSError as err:
        raise SystemExit(f"cannot read the token file {path}: {err.strerror}") from None
    if not token or any(c.isspace() for c in token):
        raise SystemExit(f"the token file {path} must hold one token and nothing else")
    return token


def role_token(role: str):
    """The token of a role (operator, confirmer, builder, reader, admin), from the file named by CZE_TOKEN_FILE_<ROLE>; None if none is named
    (a Ledger API without authentication)."""
    path = os.environ.get("CZE_TOKEN_FILE_" + role.upper())
    return read_token(path) if path else None


def user_id(name: str) -> str:
    """The Ledger API user id of a role: CZE_USER_PREFIX, then the role. The prefix is empty on the local network."""
    return os.environ.get("CZE_USER_PREFIX", "") + name


def auth(token) -> dict:
    return {"authorization": "Bearer " + token} if token else {}


def get(url: str, token=None):
    with urllib.request.urlopen(urllib.request.Request(url, headers=auth(token)), timeout=60) as r:
        return json.load(r)


def post(url: str, body: dict, token=None):
    request = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **auth(token)})
    with urllib.request.urlopen(request, timeout=120) as r:
        return json.load(r)


class Ledger:
    def __init__(self, url: str, user: str, party: str, also_acts_as: tuple = (), token=None):
        self.url, self.user, self.party, self.also_acts_as, self.token = url, user, party, list(also_acts_as), token

    def submit(self, command: dict) -> None:
        post(self.url + "/v2/commands/submit-and-wait",
             {"commands": [command], "commandId": str(uuid.uuid4()), "userId": self.user, "actAs": [self.party] + self.also_acts_as}, self.token)

    def wait_for(self, template: str, seconds: int = 60, where=lambda contract: True) -> list:
        """The active contracts of a template that pass `where`, once there is one: another participant's commit reaches this one a moment later."""
        deadline = time.time() + seconds
        while True:
            found = [c for c in self.active(template) if where(c)]
            if found or time.time() > deadline:
                return found
            time.sleep(0.5)

    def active(self, template: str) -> list:
        offset = get(self.url + "/v2/state/ledger-end", self.token)["offset"]
        flt = {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": PKG + template, "includeCreatedEventBlob": False}}}}]}
        body = {"eventFormat": {"filtersByParty": {self.party: flt}, "verbose": False}, "activeAtOffset": offset}
        found = post(self.url + "/v2/state/active-contracts", body, self.token)
        events = [e["contractEntry"]["JsActiveContract"]["createdEvent"] for e in found if "JsActiveContract" in e["contractEntry"]]
        return [{"contractId": e["contractId"], **e["createArgument"]} for e in events]


def operator_ledger(url: str, parties: dict) -> Ledger:
    """The operator's Ledger API user acts for the operator and for the gateway party, which are signatories together."""
    return Ledger(url, user_id("operator"), parties["OPERATOR_PARTY"], (parties["GATEWAY_PARTY"],), role_token("operator"))


def confirmer_ledger(url: str, parties: dict) -> Ledger:
    return Ledger(url, user_id("confirmer"), parties["CONFIRMER_PARTY"], token=role_token("confirmer"))


def proposal_arguments(args, parties: dict) -> dict:
    return {"operator": parties["OPERATOR_PARTY"], "confirmer": parties["CONFIRMER_PARTY"], "gateway": parties["GATEWAY_PARTY"],
            "builder": parties["BUILDER_PARTY"], "reader": parties["READER_PARTY"], "chainId": str(args.chain_id),
            "genesisHash": args.genesis_hash, "genesisStateRoot": args.genesis_state_root,
            "programVK": args.program_vk, "rootC": args.root_c, "rulesHash": args.rules_hash, "gasCap": str(args.gas_cap),
            "gatewayAddress": args.gateway_address}


def propose(args, parties: dict, operator_url: str, confirmer_url: str, resume: bool = False) -> dict:
    """With resume, a proposal that is there but not yet accepted (a run that stopped between the two steps) is accepted, not refused, but only if it
    is this chain's proposal: any field that differs from the arguments stops the run (it would otherwise become the chain)."""
    operator = operator_ledger(operator_url, parties)
    confirmer = confirmer_ledger(confirmer_url, parties)
    if operator.active("ZkChain"):
        raise SystemExit("a chain or a proposal already exists on this network")
    [left, *_] = operator.active("ChainProposal") or [None]
    if left is not None and not resume:
        raise SystemExit("a chain or a proposal already exists on this network")
    want = proposal_arguments(args, parties)
    if left is None:
        operator.submit({"CreateCommand": {"templateId": PKG + "ChainProposal", "createArguments": want}})
    else:
        wrong = sorted(k for k, v in want.items() if left.get(k) != v)
        if wrong:
            raise SystemExit(f"a proposal is on this participant already and differs in {wrong}: it is not this chain's. It cannot be withdrawn from here; "
                             "choose another CZE_PARTY_PREFIX, or ask the participant's operator to archive it")
    [proposal] = confirmer.wait_for("ChainProposal")
    confirmer.submit({"ExerciseCommand": {"templateId": PKG + "ChainProposal", "contractId": proposal["contractId"], "choice": "Accept", "choiceArgument": {}}})
    [chain] = operator.wait_for("ZkChain")
    return {"contractId": chain["contractId"], "chainId": chain["chainId"], "headNumber": chain["headNumber"], "headHash": chain["headHash"]}


def gateway_made(reth_url: str, gateway_address: str, token: str) -> bool:
    """Asks reth, at the finalized block, whether the gateway contract made the token: its `wrapped(token)`. The finalized
    block is the one Canton has committed, so a token made in a block Canton has not accepted does not count."""
    data = "0x" + WRAPPED_SELECTOR + "00" * 12 + token
    answer = post(reth_url, {"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": "0x" + gateway_address, "data": data}, "finalized"]})
    if "error" in answer:
        raise SystemExit(f"reth could not tell whether the gateway made {token}: {answer['error'].get('message')}")
    result = answer.get("result", "")
    if not re.fullmatch(r"0x[0-9a-f]{64}", result):
        raise SystemExit(f"reth gave no word for wrapped({token}) at {gateway_address}: {result!r}")
    return int(result, 16) == 1


def register_token(args, parties: dict, operator_url: str, confirmer_url: str, reth_url: str) -> dict:
    operator = operator_ledger(operator_url, parties)
    confirmer = confirmer_ledger(confirmer_url, parties)
    [chain] = operator.active("ZkChain") or raise_exit("there is no chain on this network: propose it first")
    mine = lambda c: c["evmToken"] == args.evm_token
    if any(mine(c) for c in operator.active("GatewayToken") + operator.active("GatewayTokenProposal")):
        raise SystemExit(f"the token {args.evm_token} is registered or proposed already")
    if not gateway_made(reth_url, chain["gatewayAddress"], args.evm_token):
        raise SystemExit(f"the gateway at {chain['gatewayAddress']} did not make the token {args.evm_token}: it cannot be registered")
    operator.submit({"CreateCommand": {"templateId": PKG + "GatewayTokenProposal", "createArguments": {
        "operator": parties["OPERATOR_PARTY"], "confirmer": parties["CONFIRMER_PARTY"], "gateway": parties["GATEWAY_PARTY"],
        "builder": parties["BUILDER_PARTY"], "chainId": chain["chainId"], "evmToken": args.evm_token,
        "instrumentId": {"admin": args.instrument_admin, "id": args.instrument_id}, "factory": args.factory}}})
    [proposal] = confirmer.wait_for("GatewayTokenProposal", where=mine)
    confirmer.submit({"ExerciseCommand": {"templateId": PKG + "GatewayTokenProposal", "contractId": proposal["contractId"], "choice": "AcceptToken", "choiceArgument": {}}})
    [token] = operator.wait_for("GatewayToken", where=mine)
    return {"contractId": token["contractId"], "evmToken": token["evmToken"], "instrumentId": token["instrumentId"]}


def raise_exit(why: str):
    raise SystemExit(why)


def address(ap: argparse.ArgumentParser, name: str, value: str) -> str:
    """An EVM address as the Daml templates write it: 40 lowercase hex digits, no 0x."""
    value = value.lower().removeprefix("0x")
    if not ADDRESS.match(value):
        ap.error(f"{name} must be an address: 40 hex digits, with or without 0x")
    return value


def parse(argv: list, pins: dict):
    """(mode, arguments): "token" if argv starts with it, else "chain"."""
    mode = "token" if argv[:1] == ["token"] else "chain"
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    if mode == "token":
        for name in ("evm-token", "instrument-admin", "instrument-id", "factory"):
            ap.add_argument("--" + name, required=True)
        ap.add_argument("--reth-url", default=f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', '8545')}")
        args = ap.parse_args(argv[1:])
        args.evm_token = address(ap, "--evm-token", args.evm_token)
        return mode, args
    if argv[:1] == ["chain"]:
        argv = argv[1:]
    for name in ("genesis-hash", "genesis-state-root", "program-vk", "root-c", "rules-hash"):
        ap.add_argument("--" + name, required=True)
    ap.add_argument("--chain-id", type=int, default=int(pins["CHAIN_ID"]))
    ap.add_argument("--gas-cap", type=int, default=int(pins["GAS_CAP"]))
    ap.add_argument("--gateway-address", default=pins["GATEWAY_ADDRESS"])
    args = ap.parse_args(argv)
    for name in ("genesis_hash", "genesis_state_root", "program_vk", "root_c", "rules_hash"):
        if not HEX.match(getattr(args, name)):
            ap.error(f"--{name.replace('_', '-')} must be lowercase hex without 0x")
    args.gateway_address = address(ap, "--gateway-address", args.gateway_address)
    return mode, args


def main() -> int:
    mode, args = parse(sys.argv[1:], read_env_file(ROOT / "PINS"))
    parties = read_env_file(Path(os.environ.get("CZE_STATE_DIR", ROOT / "state")) / "canton" / "parties.env")
    operator_url = os.environ.get("CZE_LEDGER_URL", "http://127.0.0.1:7575")
    confirmer_url = os.environ.get("CZE_CONFIRMER_LEDGER_URL", "http://127.0.0.1:7576")
    if mode == "token":
        result = register_token(args, parties, operator_url, confirmer_url, args.reth_url)
    else:
        result = propose(args, parties, operator_url, confirmer_url)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
