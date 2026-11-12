#!/usr/bin/env python3
"""The helper of tests/standard_contracts.sh: what it needs next to a real reth that network/reth/launch.sh started (the ports are launch.sh's:
RETH_HTTP_PORT, RETH_WS_PORT, RETH_ENGINE_PORT).

  genesis <state> [--foreign <address>]   makes the funding key ($state/funding.key, mode 0600, never printed) and $state/genesis.json: the chain's
                                          genesis (network/genesis.json) plus 10 coin for the funding account, and with --foreign a one-byte
                                          contract at that address. CZE_GENESIS_FILE=$state/genesis.json makes reth start on it.
  mine <state>                            for ever: when reth's pool holds transactions, builds a block of them (testing_buildBlockV1), submits it
                                          (engine_newPayloadV4) and makes it the head (engine_forkchoiceUpdatedV3). No transactions, no block.
  verify <state>                          checks that each standard contract's code at its address has the runtime code hash for this chain, and prints, for each
                                          presigned transaction, what the chain made of it (type, chain id, gas price, gas used, status).
Needs eth-account and websockets (demo/requirements.txt).
"""
import importlib.util, json, os, secrets, sys, time
from pathlib import Path

from eth_account import Account

ROOT = Path(__file__).resolve().parent.parent


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mb = load(ROOT / "prover" / "make-block.py", "make_block")   # rpc_http, rpc_ws and the ports, as the builder's own test uses them
deploy = load(ROOT / "network" / "standard-contracts" / "deploy.py", "standard_contracts_deploy")
HTTP, ENGINE = mb.HTTP, mb.ENGINE


def genesis(state: Path, foreign: str | None) -> None:
    state.mkdir(parents=True, exist_ok=True)
    key_file = state / "funding.key"
    if not key_file.exists():
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    account = Account.from_key("0x" + key_file.read_text().strip())
    chain = json.loads((ROOT / "network" / "genesis.json").read_text())
    chain["alloc"][account.address.lower().removeprefix("0x")] = {"balance": hex(10 * 10**18)}
    if foreign:
        chain["alloc"][foreign.lower().removeprefix("0x")] = {"balance": "0x0", "nonce": "0x1", "code": "0x6000"}
    (state / "genesis.json").write_text(json.dumps(chain, indent=2))
    print(f"funded {account.address}" + (f"; one-byte contract at {foreign}" if foreign else ""))


def mine(state: Path) -> None:
    jwt = bytes.fromhex((state / "reth" / "jwt.hex").read_text().strip())
    while True:
        pending = mb.rpc_ws("txpool_content", [])["pending"]
        txs = sorted(((sender, int(nonce), t["hash"]) for sender, by_nonce in pending.items() for nonce, t in by_nonce.items()))
        if not txs:
            time.sleep(0.3)
            continue
        raws = [mb.rpc_http(HTTP, "eth_getRawTransactionByHash", [h]) for _, _, h in txs]
        parent = mb.rpc_http(HTTP, "eth_getBlockByNumber", ["latest", False])
        attributes = {"timestamp": hex(int(parent["timestamp"], 16) + 1), "prevRandao": mb.ZERO32, "suggestedFeeRecipient": "0x" + "00" * 20,
                      "withdrawals": [], "parentBeaconBlockRoot": mb.ZERO32}
        built = mb.rpc_ws("testing_buildBlockV1", [parent["hash"], attributes, raws, None])
        payload = built["executionPayload"]
        status = mb.rpc_http(ENGINE, "engine_newPayloadV4", [payload, [], mb.ZERO32, built["executionRequests"]], jwt)
        assert status["status"] == "VALID", status
        head = payload["blockHash"]
        fcu = mb.rpc_http(ENGINE, "engine_forkchoiceUpdatedV3", [{"headBlockHash": head, "safeBlockHash": head, "finalizedBlockHash": head}, None], jwt)
        assert fcu["payloadStatus"]["status"] == "VALID", fcu
        print(f"block {int(payload['blockNumber'], 16)}: {len(raws)} transaction(s)", flush=True)


def verify(state: Path) -> None:
    chain_id = int(mb.rpc_http(HTTP, "eth_chainId", []), 16)
    for e in deploy.load_data():
        code = mb.rpc_http(HTTP, "eth_getCode", [e["address"], "latest"])
        have = "0x" + deploy.keccak256(deploy.hexbytes(code)).hex()
        want = deploy.expected_hash(e, chain_id)
        if have != want:
            sys.exit(f"FAIL: {e['name']} at {e['address']} has code hash {have}, expected {want}")
        line = f"ok {e['name']} {e['address']} code hash {have} ({(len(code) - 2) // 2} bytes)"
        if e["how"] == "presigned":
            raw = e["presignedTx"]
            h = "0x" + deploy.keccak256(deploy.hexbytes(raw)).hex()
            tx = mb.rpc_http(HTTP, "eth_getTransactionByHash", [h])
            receipt = mb.rpc_http(HTTP, "eth_getTransactionReceipt", [h])
            line += (f"; presigned tx type {tx['type']}, chainId {tx.get('chainId')}, gasPrice {int(tx['gasPrice'], 16)}, gas limit {int(tx['gas'], 16)}, "
                     f"gas used {int(receipt['gasUsed'], 16)}, status {receipt['status']}")
        print(line)


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "genesis":
        genesis(Path(a[1]), a[3] if len(a) == 4 and a[2] == "--foreign" else None)
    elif len(a) == 2 and a[0] == "mine":
        mine(Path(a[1]))
    elif len(a) == 2 and a[0] == "verify":
        verify(Path(a[1]))
    else:
        sys.exit(__doc__)
