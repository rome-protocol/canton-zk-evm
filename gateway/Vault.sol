// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

// The vault holds the ERC-20s that back the Canton twins of those tokens, one for one.
//
// Lock: a holder pays an ERC-20 into the vault through the gateway's `pay`, so the vault needs no code for the way in.
// Release: `release` pays an ERC-20 out of the vault through the gateway's `pay`, so the release is a payment leg that the gateway
// records, like any other. gateway/README.md says what a payment leg asks of Canton.
//
// Anyone may call `release`, because a payment commits only in a block whose Canton side (the burn of the twin) settles.
// The vault has no owner, no key, no upgrade, no storage and no way to be removed. The gateway is the one at GATEWAY_ADDRESS
// in PINS; gateway/build.sh --check fails if the address below is another.

interface IGateway {
    function pay(bytes32 id, address token, address to, uint256 amount) external;
}

interface IERC20 {
    function approve(address spender, uint256 value) external returns (bool);
}

contract Vault {
    address public constant GATEWAY = 0xa7E0000000000000000000000000000000000000;

    // The gateway's payment leg has the payee but not the payer, so this event says that the vault paid.
    event Released(bytes32 indexed id, address indexed token, address indexed to, uint256 amount);

    // Pays `amount` of `token` to `to` through the gateway. The vault lets the gateway take exactly that amount, and the gateway
    // takes it in the same call. A refusal by the gateway (an id that is used, an amount of zero, a transfer that fails) or by the
    // token (more than the vault holds) reverts all of it.
    function release(bytes32 id, address token, address to, uint256 amount) external {
        require(IERC20(token).approve(GATEWAY, amount), "approve failed");
        emit Released(id, token, to, amount);
        IGateway(GATEWAY).pay(id, token, to, amount);
    }
}
