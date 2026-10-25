#!/usr/bin/env python3
"""Part of tests/demo_package_upgrade.sh, on the local Canton network (no login).
Usage: package_probe.py <state dir> <ZkChain|BlockRecord|DepositRequest> [<DepositRequest field>=<value> | <BlockRecord number>]
       prints, as JSON, the package id of the template of each active contract of that template (the operator's view), keyed by the
       contract's ledger id: {"<contractId>": "<package id>", ...}. The package id is what the ledger says the contract was created under:
       the part before the first ':' of its template id, which is the version of the package that made it."""
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
                  "numbers": sorted(e["createArgument"].get("number", "") for e in events)}))
