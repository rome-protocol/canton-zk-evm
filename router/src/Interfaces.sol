// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

enum RouteState { None, Open, Stopped }

struct Asset {
    RouteState state;
    bytes32 instrument;
    uint256 feeOut;
    uint256 feeIn;
    uint256 feeRefund;
    uint256 minAmount;
    uint256 lockCap;
}

// unit > 0 means the network is known. It is set once and never cleared or changed.
struct Destination {
    bool open;
    uint256 unit;
}

// The arguments of the bridge's claimAsset, in its order.
struct ClaimArgs {
    bytes32[32] smtProofLocalExitRoot;
    bytes32[32] smtProofRollupExitRoot;
    uint256 globalIndex;
    bytes32 mainnetExitRoot;
    bytes32 rollupExitRoot;
    uint32 originNetwork;
    address originTokenAddress;
    uint32 destinationNetwork;
    address destinationAddress;
    uint256 amount;
    bytes metadata;
}

interface IBook {
    function assets(address token) external view returns (Asset memory);
    function claimFee(address token, uint32 network) external view returns (uint256);
    function refundWait() external view returns (uint256);
    function feeRecipient() external view returns (address);
    function outOpen() external view returns (bool);
    function inOpen() external view returns (bool);
    function checkOut(address token, uint32 network) external view returns (Asset memory, uint256 unit, uint256 claimPart);
    function checkIn(address token) external view returns (Asset memory);
    function unitOf(uint32 network) external view returns (uint256);
}

interface IGateway {
    function claim(bytes32 id, address token, uint256 amount) external;
    function withdraw(address token, uint256 amount, string calldata party) external;
}

// The narrow part of Ostia's AggLayer bridge that the router calls: no manager functions.
interface IOstiaBridge {
    function networkID() external view returns (uint32);
    function depositCount() external view returns (uint256);
    function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes calldata permitData) external payable;
    function claimAsset(
        bytes32[32] calldata smtProofLocalExitRoot,
        bytes32[32] calldata smtProofRollupExitRoot,
        uint256 globalIndex,
        bytes32 mainnetExitRoot,
        bytes32 rollupExitRoot,
        uint32 originNetwork,
        address originTokenAddress,
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        bytes calldata metadata
    ) external;
}

interface IToken {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
}
