// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// The costly block of W1 (docs/METRICS.md, "The indexer on a real chain (W1)"): a call chain that goes `depth` calls deep, with `logs` logs and `creates` contract
/// creations at every level. The rehearsal (tests/demo_rehearsal.sh) sends enough of these to fill a block under the gas cap.
contract Stress {
    event Ping(uint256 indexed level, uint256 indexed index, bytes data);

    function run(uint256 depth, uint256 logs, uint256 creates) external {
        for (uint256 i = 0; i < logs; i++) emit Ping(depth, i, "a log with some data in it, as a busy contract writes");
        for (uint256 i = 0; i < creates; i++) new Leaf();
        if (depth > 0) Stress(address(this)).run(depth - 1, logs, creates);
    }
}

contract Leaf {
    uint256 public x = 1;
}
