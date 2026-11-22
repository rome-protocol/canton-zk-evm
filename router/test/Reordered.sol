// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Initializable} from "../src/vendor/Initializable.sol";
import {IBook, IGateway, IOstiaBridge, Asset, Destination} from "../src/Interfaces.sol";

// Versions that break the storage rule, for the upgrade-safety check (upgrade-check.sh): each swaps two fields of its version 1 struct,
// and nothing else. The check must refuse both. They are never deployed.

contract CantonRouterReordered is Initializable {
    /// @custom:storage-location erc7201:rome.canton.router.v1
    struct Layout {
        IGateway gateway; // swapped with the book
        IBook book;
        IOstiaBridge bridge;
        bytes32 inboxCodeHash;
        mapping(address inbox => mapping(address token => uint256)) refundAt;
    }

    function _s() internal pure returns (Layout storage s) {
        bytes32 slot = 0xdb606f7749e64ed4d4b6a293d752c25e07a0655476e1e7853f3a60d213c4fa00;
        assembly { s.slot := slot }
    }

    function book() external view returns (address) { return address(_s().book); }
}

contract CantonBookReordered is Initializable {
    /// @custom:storage-location erc7201:rome.canton.book.v1
    struct Layout {
        mapping(bytes32 instrument => address token) canonical; // swapped with the assets
        mapping(address token => Asset) assets;
        mapping(uint32 network => Destination) destinations;
        mapping(address token => mapping(uint32 network => uint256)) claimFee;
        bool outOpen;
        bool inOpen;
        uint256 refundWait;
        address feeRecipient;
        address owner;
        address refuser;
        uint32 localNetwork;
    }

    function _s() internal pure returns (Layout storage s) {
        bytes32 slot = 0xe8b3961496db754c2eed7688e419263cf71ff6a6dc01f9a076481a34f5b16300;
        assembly { s.slot := slot }
    }

    function owner() external view returns (address) { return _s().owner; }
}
