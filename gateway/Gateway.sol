// SPDX-License-Identifier: LicenseRef-Rome-Protocol
// The licence is the LICENSE file at the root of this repository.
pragma solidity 0.8.28;

// The gateway records, for every block, the Canton legs that the block's transactions need. A leg is one of
// three things: a deposit (a Canton token is locked and its wrapped form is minted here), a withdrawal (the wrapped
// form is burnt and the Canton token is released), or a payment (an ERC-20 payment made against a payment on Canton).
//
// For each block the gateway keeps one running hash of its legs, in `legs[block.number]`. The block's proof fixes the
// state, so it fixes that hash, and the Canton side can settle exactly those legs and no others.
// gateway/README.md says how the hash is made and what each field means.
//
// The code is put into every run's genesis at a fixed address. It has no owner, no key, no upgrade and no pause.

interface IERC20 {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract Gateway {
    // The storage below is read by position, so the order is part of the contract: keep it as it is.
    mapping(uint256 => bytes32) public legs; // slot 0: keep it first
    mapping(bytes32 => bool) public used; // slot 1
    mapping(address => bool) public wrapped; // slot 2
    uint256 public withdrawals; // slot 3

    uint8 internal constant DEPOSIT = 1;
    uint8 internal constant WITHDRAWAL = 2;
    uint8 internal constant PAYMENT = 3;

    event Leg(uint8 kind, bytes32 id, address token, address account, uint256 amount, string party);

    // Anyone may make a wrapped token. It can only be minted for a deposit that Canton settles in the same block.
    function register(string calldata name, string calldata symbol) external returns (address token) {
        token = address(new Wrapped(name, symbol));
        wrapped[token] = true;
    }

    // The recipient claims a deposit: the wrapped token is minted to the caller. The leg is recorded after the mint.
    function claim(bytes32 id, address token, uint256 amount) external {
        require(wrapped[token], "not wrapped");
        require(amount > 0, "zero amount");
        require(!used[id], "id used");
        used[id] = true;
        Wrapped(token).mint(msg.sender, amount);
        _record(DEPOSIT, id, token, msg.sender, amount, "");
    }

    // The holder withdraws to a Canton party: the caller's wrapped tokens are burnt. The id is made here, new every time.
    function withdraw(address token, uint256 amount, string calldata party) external {
        require(wrapped[token], "not wrapped");
        require(amount > 0, "zero amount");
        Wrapped(token).burn(msg.sender, amount);
        bytes32 id = keccak256(abi.encode(block.chainid, address(this), ++withdrawals));
        _record(WITHDRAWAL, id, token, msg.sender, amount, party);
    }

    // The payer pays `to` in an ERC-20. The token is not ours, so the id is used up and the leg is recorded before it is called.
    // A token that calls back in finds the id used and the leg written. The call must return true.
    function pay(bytes32 id, address token, address to, uint256 amount) external {
        require(amount > 0, "zero amount");
        require(!used[id], "id used");
        used[id] = true;
        _record(PAYMENT, id, token, to, amount, "");
        require(IERC20(token).transferFrom(msg.sender, to, amount), "transfer failed");
    }

    // The hash and the event are written together, so a block's events, in log order, are its legs in the hash's order.
    function _record(uint8 kind, bytes32 id, address token, address account, uint256 amount, string memory party) internal {
        legs[block.number] = keccak256(abi.encode(legs[block.number], kind, id, token, account, amount, keccak256(bytes(party))));
        emit Leg(kind, id, token, account, amount, party);
    }
}

// The wrapped form of a Canton token: a plain ERC-20 with 10 decimals, the same as a Canton amount, so the two convert exactly.
// Only the gateway that made it can mint and burn.
contract Wrapped {
    string public name;
    string public symbol;
    uint8 public constant decimals = 10;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public immutable gateway;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name = name_;
        symbol = symbol_;
        gateway = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == gateway, "only the gateway");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(msg.sender == gateway, "only the gateway");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
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
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
