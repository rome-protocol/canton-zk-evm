// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

// The inbox of one (party, refund network, refund address): a fixed address made by the router with CREATE2. It is not a proxy and is
// never upgraded, so every inbox address stays the same. It holds the coin and does what the router tells it, with a plain call and
// no value: the router's rules decide where the coin goes. The router is msg.sender at creation, an immutable in the deployed code.
// Its compiled creation code is checked in (router/artifacts/CantonInbox.creation.hex) and embedded in the router (InboxCode.sol).
contract CantonInbox {
    address public immutable router;

    constructor() {
        router = msg.sender;
    }

    function exec(address target, bytes calldata data) external returns (bytes memory ret) {
        require(msg.sender == router, "router only");
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}
