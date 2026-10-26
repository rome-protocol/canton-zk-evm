#!/usr/bin/env python3
"""Part of tests/demo_package_upgrade.sh, on the local Canton network (no login).
Usage: demo_package_probe.py <state dir> ZkChain|BlockRecord|DepositRequest|GasCapProposal|ProgramProposal
       Prints one JSON line: "contracts" maps the ledger id of each active contract of that template (the operator's view) to the package id
       it was made under, which is the part before the first ':' of its template id; "numbers" lists the block numbers of BlockRecords and "records" maps
       each block number to the package id its BlockRecord was made under, "gasCaps" lists the gas cap of each contract that has one (a ZkChain), and "programs" lists
       programVK/rootC/rulesHash of each contract that has them (a ZkChain)."""
import json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "network" / "canton"))
import propose

state, template = Path(sys.argv[1]), sys.argv[2]
parties = propose.read_env_file(state / "canton" / "parties.env")
url = "http://127.0.0.1:7575"
offset = propose.get(url + "/v2/state/ledger-end")["offset"]
flt = {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": propose.PKG + template, "includeCreatedEventBlob": False}}}}]}
body = {"eventFormat": {"filtersByParty": {parties["OPERATOR_PARTY"]: flt}, "verbose": False}, "activeAtOffset": offset}
events = [e["contractEntry"]["JsActiveContract"]["createdEvent"] for e in propose.post(url + "/v2/state/active-contracts", body)
          if "JsActiveContract" in e["contractEntry"]]
print(json.dumps({"contracts": {e["contractId"]: e["templateId"].split(":")[0] for e in events},
                  "numbers": sorted(e["createArgument"].get("number", "") for e in events),
                  "gasCaps": [e["createArgument"]["gasCap"] for e in events if "gasCap" in e["createArgument"]],
                  "programs": ["/".join(e["createArgument"][k] for k in ("programVK", "rootC", "rulesHash")) for e in events if "programVK" in e["createArgument"]],
                  "records": {e["createArgument"]["number"]: e["templateId"].split(":")[0] for e in events if "number" in e["createArgument"]}}))
