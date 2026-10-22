// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// The token traffic of the W1 block (design section 9), as costly as the gas cap allows: a contract can emit a Transfer log for about 2k gas, so one
/// block holds thousands of them. `Flood` sends ERC-20 transfers, each to a holder no block has seen, and spawns new tokens that each need their metadata
/// read; `Multi` sends ERC-1155 batches of 4,096 ids. The holders are derived from a seed, so every call names new ones.
contract Flood {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function transfers(uint256 n, uint256 seed) external {
        for (uint256 i = 0; i < n; i++) {
            emit Transfer(address(this), address(uint160(uint256(keccak256(abi.encode(seed, i))))), 1);
        }
    }

    function spawn(uint256 n) external {
        for (uint256 i = 0; i < n; i++) new Coin();
    }
}

contract Multi {
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);

    uint256 constant IDS = 4096; // the most ids one TransferBatch can carry that the indexer's decodeTransfers reads (its MAX_BATCH)

    /// `n` TransferBatch logs of 4,096 ids each, every one to a holder no block has seen (derived from `seed`): the costliest ERC-1155 traffic a block holds.
    function batches(uint256 n, uint256 seed) external {
        uint256[] memory ids = new uint256[](IDS);
        uint256[] memory values = new uint256[](IDS);
        for (uint256 k = 0; k < IDS; k++) { ids[k] = k + 1; values[k] = 1; }
        for (uint256 i = 0; i < n; i++) {
            emit TransferBatch(msg.sender, address(this), address(uint160(uint256(keccak256(abi.encode(seed, i))))), ids, values);
        }
    }
}

/// A token made in the block, with the reads a token answers; its first transfer is the mint in its constructor.
contract Coin {
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() { emit Transfer(address(0), msg.sender, 1000); }

    function name() external pure returns (string memory) { return "Flood Coin"; }
    function symbol() external pure returns (string memory) { return "FLD"; }
    function decimals() external pure returns (uint8) { return 6; }
    function totalSupply() external pure returns (uint256) { return 1000; }
}
