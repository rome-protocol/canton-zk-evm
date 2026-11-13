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

  propose.py anchor --head-number <n> --head-hash <hex> --program-vk <hex> --root-c <hex> --rules-hash <hex>
             --gas-cap <n> [--chain-id <id>] [--gateway-address <hex>] [--head-state-root <hex>] [--reth-url <url>] [--grant] [--dry-run]

    Creates the chain on a Canton network at an existing EVM head, the one reth has finalized, instead of at block 0: for a new
    network that takes over a chain that runs (a move from one Canton network to another, or the same chain after a network reset). The
    chain id, the program key, the ZisK root, the rules hash, the gas cap and the gateway contract's address are the old chain's, so give
    them as the old chain had them. --gas-cap is required, with no default: the old chain's cap may have been raised above PINS's (DevNet's was),
    and a lower cap on the new network could be raised again only by a proposal. The block number and hash are the ones the old chain's
    last committed block had; the state root is read from reth. Daml has no proposal that starts above block 0, so this is one submission that
    creates the chain contract, signed by the operator, the confirmer and the gateway together: it needs a participant that hosts all three, as the
    Canton Network's validator participants do here, and the operator's Ledger API user must hold the confirmer's right to act as well. --grant
    gives it that right for the one submission (it needs the ADMIN token) and takes it away again afterwards.
    It stops, before it submits anything, if reth's finalized block is not the block given (number and hash; it says whether the given block
    is above, below or off reth's finalized chain), if reth is another chain, if the gateway contract's code at that block is not the reviewed
    build, if the gas cap is under the head block's gas limit, or if a chain or a chain proposal is on this network already. With --dry-run it
    makes every check and submits nothing. Prints one JSON line (the chain's contract id and head, reth's latest block, and "next", the list of what
    to register again, and "actingRightsRevoked", false if the granted right could not be taken away again); the same list goes to stderr. Run it with the
    builder stopped, and before it starts: if reth's latest block is above its finalized one, sync_reth.py (which restart.sh runs) moves reth back to
    the chain's head first, and the list says so. The old network's builder must stay stopped for good: one ledger per chain. The exit status is not 0 if the
    right could not be taken away again (the chain is created; take the right away by hand).

The parties come from $CZE_STATE_DIR/canton/parties.env (written by bootstrap.canton). The operator's Ledger API is
CZE_LEDGER_URL (default http://127.0.0.1:7575), the confirmer's is CZE_CONFIRMER_LEDGER_URL (default
http://127.0.0.1:7576); reth's is --reth-url (default http://127.0.0.1:$RETH_HTTP_PORT, port 8545 unless set). The
local network runs without Ledger API authentication. The operator's Ledger API user acts for the gateway party too.

On an existing participant (network/external/, the Canton Network): CZE_USER_PREFIX is put before the Ledger API user ids
(operator, confirmer), CZE_TOKEN_FILE_<ROLE> (OPERATOR, CONFIRMER, ...) names a file, mode 0600, that holds that user's bearer
token, and both Ledger API URLs are the one participant's. The token is read from the file, sent as a header and never printed.
"""
import argparse, json, os, re, stat, sys, time, urllib.error, urllib.request, uuid
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


def call(method: str, url: str, body: dict, token=None):
    request = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json", **auth(token)}, method=method)
    with urllib.request.urlopen(request, timeout=120) as r:
        return json.load(r)


def right(kind: str, party: str) -> dict:
    return {"kind": {kind: {"value": {"party": party}}}}


def user_acts_as(url: str, user: str, token=None) -> set:
    """The parties the Ledger API user may act as."""
    found = get(f"{url}/v2/users/{user}/rights", token)
    return {(r["kind"]["CanActAs"].get("value") or {}).get("party") for r in found.get("rights", []) if "CanActAs" in r["kind"]}


def change_acts_as(method: str, url: str, user: str, parties: set, token=None) -> None:
    """method POST grants the right to act as each of the parties to the user, PATCH takes it away."""
    call(method, f"{url}/v2/users/{user}/rights", {"userId": user, "identityProviderId": "", "rights": [right("CanActAs", p) for p in sorted(parties)]}, token)


class Ledger:
    def __init__(self, url: str, user: str, party: str, also_acts_as: tuple = (), token=None):
        self.url, self.user, self.party, self.also_acts_as, self.token = url, user, party, list(also_acts_as), token

    def submit(self, command: dict, disclosed: list = ()) -> None:
        """Submits one command as the user; `disclosed` are contracts the acting parties cannot see, passed as disclosed contracts."""
        post(self.url + "/v2/commands/submit-and-wait",
             {"commands": [command], "commandId": str(uuid.uuid4()), "userId": self.user, "actAs": [self.party] + self.also_acts_as,
              **({"disclosedContracts": list(disclosed)} if disclosed else {})}, self.token)

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


ZK_CHAIN_OPTIONAL = ("changeDelay", "pauseMax", "pausedUntil", "pauseCooldownUntil", "pauseStartedAt", "withdrawalQuota", "quotaWindow", "withdrawn", "contracts", "twins")


def rpc(reth_url: str, method: str, params: list):
    answer = post(reth_url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    if "error" in answer:
        raise SystemExit(f"reth refused {method}: {answer['error'].get('message')}")
    return answer.get("result")


def anchor_head(args, reth_url: str) -> dict:
    """reth's finalized block, after the checks that it is the head that was named: the chain id, the number and hash, the state root if one was given, the gateway
    contract's code and the gas cap. Returns the head (number, hash, state root without 0x) and reth's latest block number."""
    if rpc(reth_url, "eth_chainId", []) != hex(args.chain_id):
        raise SystemExit(f"reth is not chain {args.chain_id} (it says {rpc(reth_url, 'eth_chainId', [])})")
    final = rpc(reth_url, "eth_getBlockByNumber", ["finalized", False])
    if not final:
        raise SystemExit("reth has no finalized block: the head to anchor at is reth's finalized block, and there is none")
    number, block_hash = int(final["number"], 16), final["hash"].removeprefix("0x")
    if (number, block_hash) != (args.head_number, args.head_hash):
        given = rpc(reth_url, "eth_getBlockByHash", ["0x" + args.head_hash, False])
        if given is None:
            where = "reth does not have a block with that hash"
        elif int(given["number"], 16) != args.head_number:
            where = f"reth has that hash as block {int(given['number'], 16)}, not {args.head_number}"
        elif args.head_number > number:
            where = "that block is above reth's finalized block: it is not final"
        else:
            where = "that block is below reth's finalized block: it is not the head"
        raise SystemExit(f"the head to anchor at is block {args.head_number} ({args.head_hash}) and reth's finalized block is {number} ({block_hash}): {where}. "
                         "Anchor at reth's finalized block, which must be the last block the old chain committed")
    state_root = final["stateRoot"].removeprefix("0x")
    if args.head_state_root is not None and args.head_state_root != state_root:
        raise SystemExit(f"the state root given ({args.head_state_root}) is not the one reth has for block {number} ({state_root})")
    wanted_code = "0x" + (ROOT / "gateway" / "Gateway.bin-runtime").read_text().strip()
    code = rpc(reth_url, "eth_getCode", ["0x" + args.gateway_address, final["number"]])
    if code != wanted_code:
        raise SystemExit(f"reth's block {number} does not hold the reviewed gateway code at {args.gateway_address}")
    if int(final["gasLimit"], 16) > args.gas_cap:
        raise SystemExit(f"the head block's gas limit ({int(final['gasLimit'], 16)}) is over the gas cap {args.gas_cap}: give the cap the old chain had (--gas-cap)")
    latest = int(rpc(reth_url, "eth_getBlockByNumber", ["latest", False])["number"], 16)
    return {"number": number, "hash": block_hash, "stateRoot": state_root, "rethLatest": latest}


def anchor_next(chain_id: int, gateway_address: str, head_number: int = 0, reth_latest: int = 0) -> list:
    """What to do on the new network after the chain is anchored: the old network's records are not there, reth may be ahead of the head, and the old builder stays off."""
    return [
        "Canton-backed tokens (Canton Coin, test tokens): the old wrapped tokens stood for the old network's custody and must never be registered here. Holders withdraw "
        "them to the old network before the move; register a new wrapped token for each instrument the new network has: Gateway.register on the EVM side, then "
        "propose.py token --evm-token <address> --instrument-admin <party> --instrument-id <id> --factory <contract id>",
        "the vault and any other registered contract: setup.py --contract-step add --contract-address <address> --contract-kind vault (or gateway); the code is copied with the EVM data",
        "the twins: new TwinRules on this network (demo/twin.py rules <token>), then setup.py --twin-step add --twin-token <address> --twin-decimals <n> --twin-rules <contract id> --twin-rules-disclosed <file>",
        *([f"reth's latest block ({reth_latest}) is above the head ({head_number}): run network/sync_reth.py (restart.sh runs it) before the builder, to move reth back to the head"]
          if reth_latest > head_number else []),
        "the old network's builder must stay stopped: one ledger per chain, and a second builder for this chain would fork it",
        f"then start the builder: the first block is the head's number plus one (the chain's gateway contract is {gateway_address}, chain id {chain_id})",
    ]


def anchor_chain(args, parties: dict, url: str, reth_url: str, dry_run: bool = False, grant: bool = False) -> dict:
    head = anchor_head(args, reth_url)
    user = user_id("operator")
    acts = (parties["GATEWAY_PARTY"], parties["CONFIRMER_PARTY"])
    operator = Ledger(url, user, parties["OPERATOR_PARTY"], acts, role_token("operator"))
    if operator.active("ZkChain") or operator.active("ChainProposal"):
        raise SystemExit("a chain or a proposal already exists on this network: the chain is anchored on a network that has none")
    missing = {parties["OPERATOR_PARTY"], *acts} - user_acts_as(url, user, role_token("operator"))
    if missing and not (grant or dry_run):
        raise SystemExit(f"the Ledger API user {user} cannot act for {sorted(missing)}: all three parties sign the chain. Give it the right, or run this with --grant (ADMIN token)")
    result = {"chainId": str(args.chain_id), "headNumber": str(head["number"]), "headHash": head["hash"], "headStateRoot": head["stateRoot"],
              "rethLatest": head["rethLatest"],
              "next": anchor_next(args.chain_id, args.gateway_address, head["number"], head["rethLatest"])}
    if dry_run:
        return {**result, "submitted": False, "actingRightsMissing": sorted(missing), "actingRightsRevoked": True}
    create = {"CreateCommand": {"templateId": PKG + "ZkChain", "createArguments": {
        "operator": parties["OPERATOR_PARTY"], "confirmer": parties["CONFIRMER_PARTY"], "gateway": parties["GATEWAY_PARTY"],
        "builder": parties["BUILDER_PARTY"], "reader": parties["READER_PARTY"], "chainId": str(args.chain_id), "programVK": args.program_vk,
        "rootC": args.root_c, "rulesHash": args.rules_hash, "gasCap": str(args.gas_cap), "gatewayAddress": args.gateway_address,
        "headNumber": str(head["number"]), "headHash": head["hash"], "headStateRoot": head["stateRoot"], **{k: None for k in ZK_CHAIN_OPTIONAL}}}}
    admin = role_token("admin")
    revoked = True   # nothing granted, nothing to take away
    if missing:
        change_acts_as("POST", url, user, missing, admin)
    try:
        operator.submit(create)
    except urllib.error.HTTPError as err:
        reason = err.read().decode(errors="replace")[:1500]
        err.close()
        raise SystemExit(f"the participant refused the chain: HTTP {err.code} {reason}") from None
    finally:
        if missing:
            try:
                change_acts_as("PATCH", url, user, missing, admin)
            except (OSError, urllib.error.URLError) as err:
                revoked = False
                print(f"WARNING: the right of {user} to act for {sorted(missing)} could not be taken away again ({err}): take it away by hand", file=sys.stderr)
    [chain] = operator.wait_for("ZkChain")
    return {**result, "contractId": chain["contractId"], "submitted": True, "actingRightsGranted": sorted(missing),
            "actingRightsRevoked": revoked}


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
    """(mode, arguments): "token" or "anchor" if argv starts with it, else "chain"."""
    mode = argv[0] if argv[:1] in (["token"], ["anchor"]) else "chain"
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    if mode == "anchor":
        ap.add_argument("--head-number", type=int, required=True)
        for name in ("head-hash", "program-vk", "root-c", "rules-hash"):
            ap.add_argument("--" + name, required=True)
        ap.add_argument("--head-state-root")
        ap.add_argument("--chain-id", type=int, default=int(pins["CHAIN_ID"]))
        ap.add_argument("--gas-cap", type=int, required=True, help="the old chain's gas cap (no default: it may have been raised above PINS's)")
        ap.add_argument("--gateway-address", default=pins["GATEWAY_ADDRESS"])
        ap.add_argument("--reth-url", default=f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', '8545')}")
        ap.add_argument("--grant", action="store_true", help="give the operator's user the confirmer's right to act for this one submission (the ADMIN token)")
        ap.add_argument("--dry-run", action="store_true", help="make every check, submit nothing")
        args = ap.parse_args(argv[1:])
        if args.head_number < 0:
            ap.error("--head-number must be a block number")
        for name in ("head_hash", "head_state_root", "program_vk", "root_c", "rules_hash"):
            value = getattr(args, name)
            if value is not None:
                value = value.lower().removeprefix("0x")
                setattr(args, name, value)
                if not HEX.match(value) or len(value) != 64:
                    ap.error(f"--{name.replace('_', '-')} must be 64 hex digits, with or without 0x")
        args.gateway_address = address(ap, "--gateway-address", args.gateway_address)
        return mode, args
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
    elif mode == "anchor":
        result = anchor_chain(args, parties, operator_url, args.reth_url, args.dry_run, args.grant)
        print("\n".join(["Register on this network next:"] + ["  - " + line for line in result["next"]]), file=sys.stderr)
    else:
        result = propose(args, parties, operator_url, confirmer_url)
    print(json.dumps(result))
    if result.get("actingRightsRevoked") is False:
        print("ERROR: the chain is created, but the right that was granted could not be taken away again: take it away by hand", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
