// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// A plain test token with a chosen number of decimals. The deployer mints; nobody else can.
contract TestToken is ERC20 {
    address public immutable owner;
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        owner = msg.sender;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == owner, "TestToken: only the deployer mints");
        _mint(to, amount);
    }
}
