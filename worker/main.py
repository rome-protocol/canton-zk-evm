#!/usr/bin/env python3
"""The Canton router's worker, flow A (worker/README.md).

  main.py out [--once]     the out-relayer: router deposits on Canton, sent on through claimAndBridge. Runs only with OSTIA_RELAY_OUT=1
  main.py claim [--once]   the Sepolia claimer: claims what the router sent. Runs only with OSTIA_CLAIM_SEPOLIA=1

With its switch off a worker reads and sends nothing (it exits at once). --once makes one pass; without it a pass runs every OSTIA_WORKER_INTERVAL_SECONDS. Endpoints and key files are named by
environment variables (README), read here and never printed; a pass that fails is logged by its kind of error and tried again.
"""
import os, re, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chain, claim_sepolia, relay_out
from records import Records, whole_setting

ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")


def need(name: str) -> str:
    if not os.environ.get(name):
        raise SystemExit(f"{name} is not set")
    return os.environ[name]


def address(name: str) -> str:
    value = need(name)
    if not ADDRESS.fullmatch(value):
        raise SystemExit(f"{name} must be an address")
    return value.lower()


def settings(prefix: str) -> dict:
    """The guards and limits of a worker: every one is a setting (README lists them), none a constant of the code."""
    n = lambda name, default: whole_setting(prefix + name, default)
    return {"limits": {"gas": n("MAX_GAS", 3_000_000), "gas_price": n("MAX_GAS_PRICE", 100 * 10**9)}, "caps": {"hour": n("PER_HOUR", 20), "day": n("PER_DAY", 100), "recipient": n("PER_RECIPIENT", 10)},
            "min_balance": n("MIN_BALANCE", 10**16), "wait": n("WAIT_SECONDS", 900)}


def run(argv: list) -> None:
    kind = argv[0] if argv[:1] and argv[0] in ("out", "claim") and set(argv[1:]) <= {"--once"} else None
    if kind is None:
        raise SystemExit(__doc__)
    switch = "OSTIA_RELAY_OUT" if kind == "out" else "OSTIA_CLAIM_SEPOLIA"
    if os.environ.get(switch) != "1":
        print(f"{switch} is not 1: nothing to do")
        return
    ostia, router = chain.Rpc("Ostia", need("OSTIA_RPC_URL")), address("OSTIA_ROUTER")
    state = Path(need("OSTIA_WORKER_STATE_DIR"))
    state.mkdir(parents=True, exist_ok=True)
    interval = whole_setting("OSTIA_WORKER_INTERVAL_SECONDS", 15)
    if kind == "out":
        import canton
        cfg = {**settings("OSTIA_RELAY_"), "margin": whole_setting("OSTIA_RELAY_SETTLE_MARGIN_SECONDS", 600)}
        signer, records = chain.load_signer(need("OSTIA_RELAY_KEY_FILE")), Records(state / "relay-out.json")
        net = canton.Network()
        chain.expect_chain(ostia, int(canton.chain_record(net)["chainId"]))   # the ledger's chain record names the Ostia chain id
        ledger, handle = relay_out.Ledger(net), relay_out.Router(ostia, router)
        step = lambda: relay_out.run_once(ledger, handle, ostia, signer, records, cfg, print)
        errors = (chain.ChainError, canton.Fail, OSError, KeyError, ValueError)
    else:
        cfg = {**settings("OSTIA_CLAIM_"), "floor": whole_setting("OSTIA_CLAIM_FLOOR", 0), "network": whole_setting("OSTIA_CLAIM_NETWORK", 0), "from_block": whole_setting("OSTIA_CLAIM_FROM_BLOCK", 0),
               "chunk": max(1, whole_setting("OSTIA_CLAIM_CHUNK_BLOCKS", 2000))}
        signer, records = chain.load_signer(need("OSTIA_CLAIM_KEY_FILE")), Records(state / "claim-sepolia.json")
        sepolia, bridge = chain.Rpc("Sepolia", need("OSTIA_CLAIM_SEPOLIA_RPC_URL")), address("OSTIA_CLAIM_SEPOLIA_BRIDGE")
        chain.expect_chain(sepolia, whole_setting("OSTIA_CLAIM_SEPOLIA_CHAIN_ID", 11155111))
        aggkit = claim_sepolia.Aggkit(os.environ.get("AGGKIT_BRIDGE_URL", "http://127.0.0.1:5578"))
        ostia_bridge = ostia.view(router, "bridge()", [], [], ["address"])[0]
        network = ostia.view(ostia_bridge, "networkID()", [], [], ["uint32"])[0]
        step = lambda: claim_sepolia.run_once(aggkit, ostia, sepolia, router, bridge, network, signer, records, cfg, print)
        errors = (chain.ChainError, OSError, KeyError, ValueError)
    while True:
        try:
            step()
        except errors as e:
            print(f"{kind}: this pass failed ({type(e).__name__}): {str(e)[:200] if isinstance(e, chain.ChainError) else ''}", flush=True)
        if "--once" in argv:
            return
        time.sleep(interval)


if __name__ == "__main__":
    run(sys.argv[1:])
