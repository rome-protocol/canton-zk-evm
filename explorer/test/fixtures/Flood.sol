// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// The token traffic of the W1 block (design section 9), as costly as the gas cap allows: a contract can emit a Transfer log for about 2k gas, so one
/// block holds thousands of them. `Flood` sends ERC-20 transfers, each to a holder no block has seen, and spawns new tokens that each need their metadata
/// read; `Multi` sends ERC-1155 batches of 4,096 ids, in logs that share one array for ids and values, from a holder that holds the ids, `Burner` is a token whose reads spend all their gas, and `FatReturn` one whose reads answer 680 KB. The holders are derived from a seed, so every call names new ones.
contract Flood {
    event Transfer(address indexed from, address indexed to, uint256 value);

    function transfers(uint256 n, uint256 seed) external {
        for (uint256 i = 0; i < n; i++) {
            emit Transfer(address(this), address(uint160(uint256(keccak256(abi.encode(seed, i))))), 1);
        }
    }

    function spawn(uint256 n) external {
        // Every third token is a Burner, which spends all the gas a read gives it, and every tenth (the ninth of ten) is a FatReturn, whose reads answer 680 KB.
        for (uint256 i = 0; i < n; i++) {
            if (i % 3 == 2) new Burner();
            else if (i % 10 == 9) new FatReturn();
            else new Coin();
        }
    }
}

contract Multi {
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);

    uint256 constant IDS = 4096; // the most ids one TransferBatch can carry that the indexer's decodeTransfers reads (its MAX_BATCH)

    /// One TransferBatch of 4,096 ids from the zero address to this contract, in a block of its own before W1's: the holder the W1 block's logs send from, so each
    /// id's leg out of it is an update of a row that exists, and each leg into a new holder is an insert.
    function mint() external {
        uint256[] memory ids = new uint256[](IDS);
        uint256[] memory values = new uint256[](IDS);
        for (uint256 k = 0; k < IDS; k++) { ids[k] = k + 1; values[k] = 1e9; }
        emit TransferBatch(msg.sender, address(0), address(this), ids, values);
    }

    /// `n` TransferBatch logs from this contract, which holds the ids (`mint`), each to a holder no block has seen (derived from `seed`): two legs per id. The costliest
    /// ERC-1155 log the indexer decodes is the one whose `ids` and `values` offsets both point at one array (0x40 and 0x40): a log of 4,096 ids is 131,168 bytes, half
    /// of a two-array log, so a block holds twice as many of them under the cap (about 1.05 Mgas each). Solidity cannot emit that shape, so the log is written by hand;
    /// each id also moves a value of its own number.
    function batches(uint256 n, uint256 seed) external {
        bytes32 topic = keccak256("TransferBatch(address,address,address,uint256[],uint256[])");
        uint256 size = 0x60 + IDS * 0x20;
        assembly ("memory-safe") {
            let p := mload(0x40)
            mstore(p, 0x40)
            mstore(add(p, 0x20), 0x40)
            mstore(add(p, 0x40), IDS)
            for { let k := 0 } lt(k, IDS) { k := add(k, 1) } { mstore(add(add(p, 0x60), mul(k, 0x20)), add(k, 1)) }
            for { let i := 0 } lt(i, n) { i := add(i, 1) } {
                mstore(0x00, seed)
                mstore(0x20, i)
                log4(p, size, topic, caller(), address(), and(keccak256(0x00, 0x40), 0xffffffffffffffffffffffffffffffffffffffff))
            }
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

/// A token whose every read (name, symbol, decimals, totalSupply, balanceOf) works the BLAKE2F precompile until little gas is left and then spends the rest, so it
/// takes all the gas it is given: the indexer's read of it must be bounded by the gas limit it sets (READ_CALL_GAS), and a read that runs out counts as no answer.
contract Burner {
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() { emit Transfer(address(0), msg.sender, 1000); }

    fallback() external {
        assembly {
            let p := mload(0x40)
            mstore(p, shl(224, 65536)) // 65,536 rounds; the rest of the input (and its final flag, 0) is zero
            for { } gt(gas(), 100000) { } { pop(staticcall(100000, 0x09, p, 213, p, 64)) }
            invalid()
        }
    }
}

/// A token whose every read answers 680 KB (its runtime code is PUSH3 <size> PUSH1 0 RETURN, which returns that many bytes of zeroed memory): the indexer's read of it
/// must treat an answer longer than 4 KB as no answer, without decoding it, so its metadata is `failed`. The constructor makes one Transfer, then installs that runtime code.
contract FatReturn {
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() {
        emit Transfer(address(0), msg.sender, 1000);
        assembly {
            // 0x62 PUSH3, 0x0aae60 (700,000 bytes), 0x60 0x00 PUSH1 0, 0xf3 RETURN: seven bytes, left-aligned in a word.
            mstore(0, shl(200, 0x620aae606000f3))
            return(0, 7)
        }
    }
}
