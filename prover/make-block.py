#!/usr/bin/env python3
"""Makes one block with one plain transfer on a throwaway copy of the chain, by hand through
reth's testing and Engine APIs, and saves what the prover input needs.

Needs: pip install eth-account==0.13.7 websockets==15.0.1

  make-block.py fund <state-folder>
      Makes a test key (kept in the folder, never printed) and a copy of network/, gateway/ and PINS under
      <state-folder>/run/ whose genesis also gives the key one ether. Start reth from the copy:
        CZE_STATE_DIR=<state-folder>/reth <state-folder>/run/network/reth/launch.sh

  make-block.py build <state-folder> <out-folder>
      Against that reth: builds block 1 holding one transfer from the key (testing_buildBlockV1 with
      that one transaction), submits it (engine_newPayloadV4), makes it the head
      (engine_forkchoiceUpdatedV3), and writes <out-folder>/block.json (eth_getBlockByNumber, full
      transactions) and <out-folder>/witness.json (debug_executionWitness).

The ports are those of launch.sh (RETH_HTTP_PORT, RETH_WS_PORT, RETH_ENGINE_PORT).
"""
import base64, hashlib, hmac, json, os, secrets, shutil, sys, time, urllib.request
from pathlib import Path

from eth_account import Account
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parent.parent
HTTP = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', 8545)}"
WS = f"ws://127.0.0.1:{os.environ.get('RETH_WS_PORT', 8546)}"
ENGINE = f"http://127.0.0.1:{os.environ.get('RETH_ENGINE_PORT', 8551)}"
ZERO32 = "0x" + "00" * 32
RECIPIENT = "0x000000000000000000000000000000000000dEaD"


def fund(state: Path) -> None:
    state.mkdir(parents=True, exist_ok=True)
    key_file = state / "test-key.hex"
    if not key_file.exists():
        fd = os.open(key_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    address = Account.from_key("0x" + key_file.read_text().strip()).address
    run = state / "run"
    shutil.rmtree(run, ignore_errors=True)
    run.mkdir()
    shutil.copytree(ROOT / "network", run / "network")
    shutil.copytree(ROOT / "gateway", run / "gateway", ignore=shutil.ignore_patterns("tests"))  # make-state.sh adds its code to the genesis
    shutil.copy(ROOT / "PINS", run / "PINS")
    genesis_file = run / "network" / "genesis.json"
    genesis = json.loads(genesis_file.read_text())
    genesis["alloc"][address.lower()] = {"balance": hex(10**18)}
    genesis_file.write_text(json.dumps(genesis, indent=2))
    print(f"funded the test key's address {address} in {genesis_file}")


def rpc_http(url: str, method: str, params: list, jwt_secret: bytes = b"") -> object:
    headers = {"content-type": "application/json"}
    if jwt_secret:
        enc = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=")
        signing = enc(b'{"alg":"HS256","typ":"JWT"}') + b"." + enc(json.dumps({"iat": int(time.time())}).encode())
        token = signing + b"." + enc(hmac.new(jwt_secret, signing, hashlib.sha256).digest())
        headers["authorization"] = "Bearer " + token.decode()
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    with urllib.request.urlopen(urllib.request.Request(url, body, headers)) as r:
        reply = json.load(r)
    if "error" in reply:
        sys.exit(f"{method} failed: {reply['error']}")
    return reply["result"]


def rpc_ws(method: str, params: list) -> object:
    with connect(WS, max_size=None) as ws:
        ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
        reply = json.loads(ws.recv())
    if "error" in reply:
        sys.exit(f"{method} failed: {reply['error']}")
    return reply["result"]


def build(state: Path, out: Path) -> None:
    jwt_secret = bytes.fromhex((state / "reth" / "jwt.hex").read_text().strip())
    key = "0x" + (state / "test-key.hex").read_text().strip()
    chain_id = int(rpc_http(HTTP, "eth_chainId", []), 16)

    transfer = Account.sign_transaction(
        {
            "type": 2,
            "chainId": chain_id,
            "nonce": 0,
            "to": RECIPIENT,
            "value": 10**15,
            "gas": 21000,
            "maxFeePerGas": 10 * 10**9,
            "maxPriorityFeePerGas": 10**9,
        },
        key,
    )
    raw = "0x" + transfer.raw_transaction.hex().removeprefix("0x")

    parent = rpc_http(HTTP, "eth_getBlockByNumber", ["0x0", False])
    attributes = {
        "timestamp": hex(int(parent["timestamp"], 16) + 12),
        "prevRandao": ZERO32,
        "suggestedFeeRecipient": "0x0000000000000000000000000000000000000000",
        "withdrawals": [],
        "parentBeaconBlockRoot": ZERO32,
    }
    built = rpc_ws("testing_buildBlockV1", [parent["hash"], attributes, [raw], None])
    payload = built["executionPayload"]

    status = rpc_http(ENGINE, "engine_newPayloadV4", [payload, [], ZERO32, built["executionRequests"]], jwt_secret)
    if status["status"] != "VALID":
        sys.exit(f"engine_newPayloadV4: {status}")
    head = payload["blockHash"]
    fcu = rpc_http(ENGINE, "engine_forkchoiceUpdatedV3",
                   [{"headBlockHash": head, "safeBlockHash": head, "finalizedBlockHash": head}, None], jwt_secret)
    if fcu["payloadStatus"]["status"] != "VALID":
        sys.exit(f"engine_forkchoiceUpdatedV3: {fcu}")

    block = rpc_http(HTTP, "eth_getBlockByNumber", ["0x1", True])
    assert block["hash"] == head and len(block["transactions"]) == 1, "reth's block 1 is not the one built"
    witness = rpc_ws("debug_executionWitness", ["0x1"])
    out.mkdir(parents=True, exist_ok=True)
    (out / "block.json").write_text(json.dumps(block))
    (out / "witness.json").write_text(json.dumps(witness))
    print(f"block 1 {head}: {len(block['transactions'])} transaction, gas used {int(block['gasUsed'], 16)}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "fund":
        fund(Path(args[1]))
    elif len(args) == 3 and args[0] == "build":
        build(Path(args[1]), Path(args[2]))
    else:
        sys.exit(__doc__)
