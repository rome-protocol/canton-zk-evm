// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

/// @title NoteBoard
/// @notice Demo receiver of AggLayer messages: keeps the latest note from each sender.
contract NoteBoard {
    address public immutable BRIDGE;
    uint256 public count;
    struct Note { bytes text; uint64 at; uint256 number; }
    mapping(uint32 => mapping(address => Note)) internal _notes;

    event NoteReceived(uint32 indexed originNetwork, address indexed originAddress, uint256 indexed number, bytes text);
    error NotBridge();

    constructor(address bridge) { BRIDGE = bridge; }

    /// @dev Only the bridge may call. Any sender may leave a note, so the origin is not checked. Payable so a value message by hand still delivers.
    function onMessageReceived(address originAddress, uint32 originNetwork, bytes calldata data) external payable {
        if (msg.sender != BRIDGE) revert NotBridge();
        uint256 n = ++count;
        _notes[originNetwork][originAddress] = Note(data, uint64(block.timestamp), n);
        emit NoteReceived(originNetwork, originAddress, n, data);
    }

    function noteOf(uint32 originNetwork, address originAddress) external view returns (bytes memory text, uint64 at, uint256 number) {
        Note storage x = _notes[originNetwork][originAddress];
        return (x.text, x.at, x.number);
    }
}
