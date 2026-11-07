#!/usr/bin/env python3
"""The twin registry service's index of acceptances, past one page, on the real network: V signs 201 more TwinAcceptances, and U's own is made again
after them, so that it is on the third page of the service's read (100 a page). The service must refresh its index from all the pages and name U's new
acceptance for a lock of U's. V's 201 are archived at the end. Run it last in tests/demo_twin.sh, which has the service running (it needs the demo's
CZE_STATE_DIR and the service's URL); the whole-list reads of demo/twin.py would refuse 200 or more acceptances.

  demo_paged_twin_acceptances.py <registry url>      prints one line and exits 0, or says what failed
"""
import json, sys, time, urllib.error, urllib.request, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "demo"))
sys.path.insert(0, str(ROOT / "apps" / "twin" / "registry"))
import canton as c  # noqa: E402
import twin as t  # noqa: E402
import registry as R  # noqa: E402

SPAM = 201


def main(registry_url: str) -> str:
    net = c.Network()
    u, v, admin = net.party("u"), net.party("v"), net.party(t.ADMIN)
    ledger = R.Ledger(net.urls["operator"], "local-network-no-auth")   # the local network takes any token
    create = lambda party: {"CreateCommand": {"templateId": t.TWIN_ACCEPTANCE, "createArguments": {"party": party, "admin": admin}}}
    archive = lambda cid: {"ExerciseCommand": {"templateId": t.TWIN_ACCEPTANCE, "contractId": cid, "choice": "Archive", "choiceArgument": {}}}

    def many(party: str, commands: list) -> None:   # one transaction
        body = {"commands": commands, "commandId": str(uuid.uuid4()), "userId": net.user(c.USER), "actAs": [net.party(party)]}
        net.post("users", "/v2/commands/submit-and-wait", body, c.USER)

    def listed(enough) -> list:   # the service's own paged read, until `enough` holds of it
        deadline = time.time() + 120
        while True:
            found = list(ledger.active_pages(R.ACCEPTANCE, admin, 100))
            if enough(found):
                return found
            if time.time() > deadline:
                raise SystemExit(f"timed out: {len(found)} acceptances")
            time.sleep(1)

    old_u, old_v = t.accept(net, "u")["contractId"], t.accept(net, "v")["contractId"]
    net.submit("users", ["u"], archive(old_u))
    many("v", [create(v)] * SPAM)
    net.submit("users", ["u"], create(u))
    found = listed(lambda f: len(f) >= SPAM + 2 and any(e["createArgument"]["party"] == u for e in f))
    mine = [i for i, e in enumerate(found) if e["createArgument"]["party"] == u]
    if len(mine) != 1 or mine[0] < 200:
        raise SystemExit(f"U's acceptance is at {mine} of {len(found)}: it must be one, after two pages of 100")
    new_u = found[mine[0]]["contractId"]

    def lock_parts() -> dict:
        request = urllib.request.Request(registry_url + "/twin/v1/lock-parts", json.dumps({"receiver": u, "ref": "paged-index"}).encode(), {"content-type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            with e:
                return {"status": e.code}

    deadline = time.time() + 90   # the service reads its index every 10 s
    while lock_parts().get("acceptance") != new_u:
        if time.time() > deadline:
            health = urllib.request.urlopen(registry_url + "/healthz", timeout=20).read().decode()
            raise SystemExit(f"the service does not name U's new acceptance {new_u}: {lock_parts()}; healthz {health}")
        time.sleep(2)
    many("v", [archive(e["contractId"]) for e in found if e["createArgument"]["party"] == v and e["contractId"] != old_v])
    listed(lambda f: sum(e["createArgument"]["party"] == v for e in f) == 1)
    return f"the registry service named U's acceptance at {mine[0] + 1} of {len(found)}, read in {-(-len(found) // 100)} pages; V's {SPAM} are archived"


if __name__ == "__main__":
    print(main(sys.argv[1]))
