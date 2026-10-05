// SPDX-License-Identifier: LicenseRef-Rome-Protocol
// The licence is the LICENSE file at the root of this repository.
pragma solidity 0.8.28;

// TKA, the test token of the demo: a plain ERC-20 whose whole supply goes to one holder when it is deployed.
// `balanceOf` is the first state variable, so it sits at storage slot 0, and a holder's balance is at
// keccak256(abi.encode(holder, 0)). The demo's DvP terms name exactly that slot.
contract TKA {
    mapping(address => uint256) public balanceOf; // slot 0: keep it first
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    string public constant name = "Test token A";
    string public constant symbol = "TKA";
    uint8 public constant decimals = 18;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address holder, uint256 supply) {
        balanceOf[holder] = supply;
        totalSupply = supply;
        emit Transfer(address(0), holder, supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
