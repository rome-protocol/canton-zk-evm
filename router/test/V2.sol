// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {CantonBook} from "../src/CantonBook.sol";
import {CantonRouter} from "../src/CantonRouter.sol";

// Test versions 2 for the upgrade test. Each appends a field in a namespace of its own and changes other logic.
contract CantonRouterV2 is CantonRouter {
    /// @custom:storage-location erc7201:rome.canton.router.v2
    struct V2 { uint256 reserve; }

    bytes32 internal constant SLOT2 = keccak256(abi.encode(uint256(keccak256("rome.canton.router.v2")) - 1)) & ~bytes32(uint256(0xff));

    function initializeV2(uint256 reserve_) external reinitializer(2) {
        _v2().reserve = reserve_;
    }

    function version() external pure returns (uint256) { return 2; }

    function reserve() external view returns (uint256) { return _v2().reserve; }

    // A new rule: part of the room under the cap is kept back.
    function lockRoom(address token) public view override returns (uint256) {
        uint256 room = super.lockRoom(token);
        uint256 r = _v2().reserve;
        return room > r ? room - r : 0;
    }

    function _v2() internal pure returns (V2 storage s) {
        bytes32 slot = SLOT2;
        assembly { s.slot := slot }
    }
}

contract CantonBookV2 is CantonBook {
    function version() external pure returns (uint256) { return 2; }
}
