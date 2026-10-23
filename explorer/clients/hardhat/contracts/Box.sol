// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract Box {
    uint256 public value;

    constructor(uint256 v) {
        value = v;
    }

    function set(uint256 v) external {
        value = v;
    }
}
