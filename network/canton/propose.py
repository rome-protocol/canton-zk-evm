#!/usr/bin/env python3
"""Creates the chain on Canton: the operator proposes it, the confirmer accepts it. See network/README.md.

  propose.py --genesis-hash <hex> --genesis-state-root <hex> --program-vk <hex> --root-c <hex> --rules-hash <hex>

The values are plain hex without 0x. The chain id and the gas cap come from PINS. The parties come from
$CZE_STATE_DIR/canton/parties.env (written by bootstrap.canton). The operator's Ledger API is CZE_LEDGER_URL
(default http://127.0.0.1:7575), the confirmer's is CZE_CONFIRMER_LEDGER_URL (default http://127.0.0.1:7576); the
network runs without Ledger API authentication. Prints one JSON line: the chain's head after Accept.
Refuses to run if a ZkChain already exists.
"""
import argparse, json, os, re, sys, time, urllib.request, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
PKG = "#canton-zk-evm:Zk.Chain:"
HEX = re.compile(r"^[0-9a-f]+$")


def read_env_file(path: Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        if line.strip() and not line.startswith("#"):
            k, _, v = line.partition("=")
            out[k.strip()] = v.strip()
    return out


def post(url: str, body: dict):
    request = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as r:
        return json.load(r)


class Ledger:
    def __init__(self, url: str, user: str, party: str):
        self.url, self.user, self.party = url, user, party

    def submit(self, command: dict) -> None:
        post(self.url + "/v2/commands/submit-and-wait",
             {"commands": [command], "commandId": str(uuid.uuid4()), "userId": self.user, "actAs": [self.party]})

    def wait_for(self, template: str, seconds: int = 60) -> list:
        """The active contracts of a template, once there is one: another participant's commit reaches this one a moment later."""
        deadline = time.time() + seconds
        while True:
            found = self.active(template)
            if found or time.time() > deadline:
                return found
            time.sleep(0.5)

    def active(self, template: str) -> list:
        with urllib.request.urlopen(self.url + "/v2/state/ledger-end", timeout=60) as r:
            offset = json.load(r)["offset"]
        flt = {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": PKG + template, "includeCreatedEventBlob": False}}}}]}
        body = {"eventFormat": {"filtersByParty": {self.party: flt}, "verbose": False}, "activeAtOffset": offset}
        found = post(self.url + "/v2/state/active-contracts", body)
        events = [e["contractEntry"]["JsActiveContract"]["createdEvent"] for e in found if "JsActiveContract" in e["contractEntry"]]
        return [{"contractId": e["contractId"], **e["createArgument"]} for e in events]


def propose(args, parties: dict, operator_url: str, confirmer_url: str) -> dict:
    operator = Ledger(operator_url, "operator", parties["OPERATOR_PARTY"])
    confirmer = Ledger(confirmer_url, "confirmer", parties["CONFIRMER_PARTY"])
    if operator.active("ZkChain") or operator.active("ChainProposal"):
        raise SystemExit("a chain or a proposal already exists on this network")
    operator.submit({"CreateCommand": {"templateId": PKG + "ChainProposal", "createArguments": {
        "operator": parties["OPERATOR_PARTY"], "confirmer": parties["CONFIRMER_PARTY"], "builder": parties["BUILDER_PARTY"],
        "reader": parties["READER_PARTY"], "chainId": str(args.chain_id), "genesisHash": args.genesis_hash,
        "genesisStateRoot": args.genesis_state_root,
        "programVK": args.program_vk, "rootC": args.root_c, "rulesHash": args.rules_hash, "gasCap": str(args.gas_cap)}}})
    [proposal] = confirmer.wait_for("ChainProposal")
    confirmer.submit({"ExerciseCommand": {"templateId": PKG + "ChainProposal", "contractId": proposal["contractId"], "choice": "Accept", "choiceArgument": {}}})
    [chain] = operator.wait_for("ZkChain")
    return {"contractId": chain["contractId"], "chainId": chain["chainId"], "headNumber": chain["headNumber"], "headHash": chain["headHash"]}


def main() -> int:
    pins = read_env_file(ROOT / "PINS")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for name in ("genesis-hash", "genesis-state-root", "program-vk", "root-c", "rules-hash"):
        ap.add_argument("--" + name, required=True)
    ap.add_argument("--chain-id", type=int, default=int(pins["CHAIN_ID"]))
    ap.add_argument("--gas-cap", type=int, default=int(pins["GAS_CAP"]))
    args = ap.parse_args()
    for name in ("genesis_hash", "genesis_state_root", "program_vk", "root_c", "rules_hash"):
        if not HEX.match(getattr(args, name)):
            ap.error(f"--{name.replace('_', '-')} must be lowercase hex without 0x")
    parties = read_env_file(Path(os.environ.get("CZE_STATE_DIR", ROOT / "state")) / "canton" / "parties.env")
    result = propose(args, parties, os.environ.get("CZE_LEDGER_URL", "http://127.0.0.1:7575"),
                     os.environ.get("CZE_CONFIRMER_LEDGER_URL", "http://127.0.0.1:7576"))
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
