// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// The three kinds of revert data the indexer must keep (design section 4.1): Error(string), Panic(uint256) and a custom error.
/// Used by the real-reth test (server/indexer/real-reth.test.ts): one transaction to each function, in a block, in this order.
contract Reverts {
    error Custom(uint256 code, address who);

    function reason() external pure { revert("not allowed"); }

    function overflow() external pure returns (uint256) {
        uint256 x = type(uint256).max;
        uint256 one = 1;
        unchecked { one = one + 0; }
        return x + one;
    }

    function custom() external view { revert Custom(7, msg.sender); }
}
