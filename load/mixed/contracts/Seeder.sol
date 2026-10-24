// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Gives many test wallets their starting balances in one transaction: some of the chain's own coin and an amount of each of two tokens.
/// The caller approves this contract for the tokens first and sends the coin along with the call. It holds nothing between calls.
contract Seeder {
    function seed(address[] calldata to, uint256 coinEach, IERC20 a, uint256 aEach, IERC20 b, uint256 bEach) external payable {
        require(msg.value == coinEach * to.length, "Seeder: send coinEach for every wallet");
        for (uint256 i = 0; i < to.length; i++) {
            if (coinEach > 0) {
                (bool ok, ) = to[i].call{value: coinEach}("");
                require(ok, "Seeder: coin transfer failed");
            }
            if (aEach > 0) require(a.transferFrom(msg.sender, to[i], aEach), "Seeder: first token failed");
            if (bEach > 0) require(b.transferFrom(msg.sender, to[i], bEach), "Seeder: second token failed");
        }
    }
}
