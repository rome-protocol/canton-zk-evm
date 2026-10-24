// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

/// The chain's coin, wrapped as an ERC-20 (the same shape as WETH9): `deposit` (or a plain send) gives tokens one for one, `withdraw` gives the coin back.
contract WtROME {
    string public constant name = "Wrapped tROME";
    string public constant symbol = "WtROME";
    uint8 public constant decimals = 18;

    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Deposit(address indexed to, uint256 value);
    event Withdrawal(address indexed from, uint256 value);

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
        emit Transfer(address(0), msg.sender, msg.value);
    }

    function withdraw(uint256 value) external {
        require(balanceOf[msg.sender] >= value, "WtROME: balance too low");
        balanceOf[msg.sender] -= value;
        emit Transfer(msg.sender, address(0), value);
        emit Withdrawal(msg.sender, value);
        (bool ok, ) = msg.sender.call{value: value}("");
        require(ok, "WtROME: send failed");
    }

    function totalSupply() external view returns (uint256) {
        return address(this).balance;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return transferFrom(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) public returns (bool) {
        require(balanceOf[from] >= value, "WtROME: balance too low");
        if (from != msg.sender && allowance[from][msg.sender] != type(uint256).max) {
            require(allowance[from][msg.sender] >= value, "WtROME: allowance too low");
            allowance[from][msg.sender] -= value;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
