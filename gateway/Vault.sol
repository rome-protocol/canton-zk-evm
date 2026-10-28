// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

// The vault holds the ERC-20s that back the Canton twins of those tokens, one for one.
//
// Lock: a holder pays an ERC-20 into the vault through the gateway's `pay`, so the vault needs no code for the way in.
// Release: `release` pays an ERC-20 out of the vault through the gateway's `pay`, so the release is a payment leg that the gateway
// records, like any other. gateway/README.md says what a payment leg asks of Canton.
//
// Anyone may call `release`, but the vault, not the caller, makes the id of the payment: it is the SHA-256 of the text
// `vault-release,<this vault's address, 40 lowercase hex digits>,<ref>`, as `venueTradeId` is the SHA-256 of `venue-trade,<venue>,<label>`.
// Canton matches a payment by its id, token, payee and amount, and does not see who paid, so an id that only the vault can make
// is what lets Canton tell a release from any other payment. The tag `vault-release` is not a party id, a `venue-trade` tag or a
// lock tag, so no caller can make the vault pay an id that a `DvpTerms`, a venue trade or a lock waits for. The vault never pays
// itself, so a release cannot read as a lock. The vault has no owner, no key, no upgrade, no storage and no way to be removed.
// The gateway is the one at GATEWAY_ADDRESS in PINS; gateway/build.sh --check fails if the address below is another.

interface IGateway {
    function pay(bytes32 id, address token, address to, uint256 amount) external;
}

interface IERC20 {
    function approve(address spender, uint256 value) external returns (bool);
}

contract Vault {
    address public constant GATEWAY = 0xa7E0000000000000000000000000000000000000;

    // The gateway's payment leg has the payee but not the payer, so this event says that the vault paid, and for which ref.
    event Released(bytes32 indexed id, address indexed token, address indexed to, uint256 amount, string ref);

    // The id of the payment that `release(ref, ...)` makes: SHA-256 of `vault-release,<this address in lowercase hex>,<ref>`.
    function releaseId(string calldata ref) public view returns (bytes32) {
        bytes memory hexa = "0123456789abcdef";
        bytes memory addr = new bytes(40);
        uint160 a = uint160(address(this));
        for (uint256 i = 40; i > 0; i--) {
            addr[i - 1] = hexa[a & 0xf];
            a >>= 4;
        }
        return sha256(bytes.concat("vault-release,", addr, ",", bytes(ref)));
    }

    // Pays `amount` of `token` to `to` through the gateway, with the id `releaseId(ref)`. The vault lets the gateway take exactly
    // that amount, and the gateway takes it in the same call. A refusal by the gateway (an id that is used, an amount of zero, a
    // transfer that fails) or by the token (more than the vault holds) reverts all of it. `to` is never the vault itself.
    function release(string calldata ref, address token, address to, uint256 amount) external {
        require(to != address(this), "release to the vault");
        bytes32 id = releaseId(ref);
        require(IERC20(token).approve(GATEWAY, amount), "approve failed");
        emit Released(id, token, to, amount, ref);
        IGateway(GATEWAY).pay(id, token, to, amount);
    }
}
