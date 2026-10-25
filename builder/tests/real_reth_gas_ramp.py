#!/usr/bin/env python3
"""The block gas limit ramp on a real reth. Run by builder/tests/real_reth_gas_ramp.sh, which starts reth only through network/reth/launch.sh
(peer discovery off).

It builds blocks by hand the way the builder does (testing_buildBlockV1, engine_newPayloadV4, engine_forkchoiceUpdatedV3), with the
targetGasLimit the builder's own target_for() works out, and reads every block's gas limit back from reth:

  1. A target of twice the genesis gas limit, held under a cap of the same size, for 20 blocks: each block's limit is above its parent's and
     moves by less than 1/1024 of it, and none is above the target.
  2. A target of twice the genesis gas limit under a cap only a little above where the limit now is (the builder sends the lower of the two):
     the limit climbs to the cap, stops at it exactly, and stays there, and no block is above the cap.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE.parent))
import builder as b  # noqa: E402
import importlib.util  # noqa: E402

_spec = importlib.util.spec_from_file_location("make_block", ROOT / "prover" / "make-block.py")
mb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mb)  # rpc_http, rpc_ws and the ports, as prover/make-block.py has them

ZERO32 = "0x" + "00" * 32
HTTP = mb.HTTP


def config(target: int) -> "b.Config":
    blank = {f: "" for f in ("ws_url", "engine_url", "jwt_secret", "ledger_url", "ledger_user", "ledger_token", "party", "fee_recipient", "genesis",
                             "work_dir", "make_input_cmd", "prove_cmd")}
    cfg = b.Config(**blank)
    cfg.target_gas_limit = target
    return cfg


class Chain:
    def __init__(self, jwt: bytes):
        self.jwt = jwt

    def head(self) -> dict:
        return mb.rpc_http(HTTP, "eth_getBlockByNumber", ["latest", False])

    def block(self, target: "int | None") -> int:
        """Builds an empty block on reth's head, asking for `target` if there is one; makes it the head and returns its gas limit."""
        parent = self.head()
        attributes = {"timestamp": hex(int(parent["timestamp"], 16) + 12), "prevRandao": ZERO32,
                      "suggestedFeeRecipient": "0x" + "00" * 20, "withdrawals": [], "parentBeaconBlockRoot": ZERO32}
        if target is not None:
            attributes["targetGasLimit"] = hex(target)
        built = mb.rpc_ws("testing_buildBlockV1", [parent["hash"], attributes, [], None])
        payload = built["executionPayload"]
        status = mb.rpc_http(mb.ENGINE, "engine_newPayloadV4", [payload, [], ZERO32, built["executionRequests"]], self.jwt)
        assert status["status"] == "VALID", status
        head = payload["blockHash"]
        fcu = mb.rpc_http(mb.ENGINE, "engine_forkchoiceUpdatedV3",
                          [{"headBlockHash": head, "safeBlockHash": head, "finalizedBlockHash": head}, None], self.jwt)
        assert fcu["payloadStatus"]["status"] == "VALID", fcu
        return int(self.head()["gasLimit"], 16)


def main(state: Path) -> None:
    chain = Chain(bytes.fromhex((state / "reth" / "jwt.hex").read_text().strip()))
    genesis = int(chain.head()["gasLimit"], 16)
    target = 2 * genesis
    cfg = config(target)

    # 1. The ramp: 20 blocks toward twice the genesis limit.
    asked = b.target_for(cfg, target)   # the cap is the target here, so nothing is held down
    assert asked == target, asked
    limits = [genesis]
    for _ in range(20):
        limits.append(chain.block(asked))
    for prev, cur in zip(limits, limits[1:]):
        assert cur > prev, f"the limit did not rise: {prev} -> {cur}"
        assert (cur - prev) * 1024 < prev, f"the limit moved by 1/1024 of its parent or more: {prev} -> {cur}"
        assert cur <= target, f"the limit passed the target: {cur} > {target}"
    print(f"ramp: {limits[0]} -> {limits[-1]} in 20 blocks (target {target}); about {round(0.6931 * 1024)} blocks to double")

    # 2. The cap: the builder sends the lower of its target and the chain's gasCap, so the limit stops at the cap.
    cap = limits[-1] + 200_000
    held = b.target_for(cfg, cap)
    assert held == cap, (held, cap)
    after = [limits[-1]]
    for _ in range(15):
        after.append(chain.block(held))
    for prev, cur in zip(after, after[1:]):
        assert prev <= cur <= cap and (cur - prev) * 1024 < prev, f"{prev} -> {cur} under the cap {cap}"
    assert after[-1] == cap, f"the limit did not stop at the cap: {after[-1]} != {cap}"
    first = after.index(cap)
    assert len(after) - first >= 3, "the limit did not stay at the cap for 3 blocks"
    print(f"cap: {after[0]} -> {cap} in {first} blocks, then held for {len(after) - first - 1} more")
    print("PASS")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
