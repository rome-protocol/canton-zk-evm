// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// The chain's coin, wrapped as an ERC-20 on OpenZeppelin's MIT ERC20: `deposit` (or a plain send) mints tokens one for one, `withdraw` burns them and sends the coin back.
contract WtROME is ERC20("Wrapped tROME", "WtROME") {
    event Deposit(address indexed to, uint256 value);
    event Withdrawal(address indexed from, uint256 value);

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 value) external {
        _burn(msg.sender, value);
        (bool ok,) = msg.sender.call{value: value}("");
        require(ok, "WtROME: send failed");
        emit Withdrawal(msg.sender, value);
    }
}
