// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// The contract L5 of the nightly load test deploys on the chain and asks the explorer to verify, with Foundry in both formats and with Hardhat: one constructor
/// argument, a public variable, an event and a function. It is compiled with the settings in foundry.toml and hardhat.config.cjs, which are the same, and with the metadata hash Foundry needs for the flattened format.
contract Counter {
    uint256 public count;

    event Bumped(address indexed by, uint256 count);

    constructor(uint256 start) {
        count = start;
    }

    function bump() external returns (uint256) {
        count += 1;
        emit Bumped(msg.sender, count);
        return count;
    }
}
