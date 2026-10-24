// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

import {PrimaryProdDataServiceConsumerBase} from "@redstone-finance/evm-connector/contracts/data-services/PrimaryProdDataServiceConsumerBase.sol";

/// A small consumer of RedStone's pull model. Nobody pushes prices to this contract: the caller appends the signed prices to the call data,
/// and the contract checks the signatures against RedStone's primary data service (`redstone-primary-prod`, 3 of its 5 public signers) and the
/// timestamp against the block. It keeps the latest ETH/USD and BTC/USD it has seen and tells how much a number of tETH is worth.
/// The base contract comes from the RedStone package at the version in package.json; it is installed at run time, never copied here.
contract PriceVault is PrimaryProdDataServiceConsumerBase {
    bytes32 public constant ETH = bytes32("ETH");
    bytes32 public constant BTC = bytes32("BTC");

    struct Quote {
        uint256 price; // USD with 8 decimals, as RedStone delivers it
        uint256 timestampMs; // when the data packages were signed
        address by; // who recorded it
    }

    mapping(bytes32 => Quote) public latest;
    uint256 public recordings;

    event PriceRecorded(bytes32 indexed feed, uint256 price, uint256 timestampMs, address indexed by);

    /// Reads ETH/USD and BTC/USD from the signed prices appended to this call and stores them.
    function record() external {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = ETH;
        ids[1] = BTC;
        uint256[] memory prices = getOracleNumericValuesFromTxMsg(ids);
        uint256 ts = extractTimestampsAndAssertAllAreEqual();
        for (uint256 i = 0; i < 2; i++) {
            latest[ids[i]] = Quote(prices[i], ts, msg.sender);
            emit PriceRecorded(ids[i], prices[i], ts, msg.sender);
        }
        recordings++;
    }

    /// Reads one feed, any symbol RedStone's primary service delivers, without storing it. A view: call it with the payload appended.
    function peek(bytes32 feed) external view returns (uint256) {
        return getOracleNumericValueFromTxMsg(feed);
    }

    /// What `amount` tETH (18 decimals) are worth in USD (8 decimals) at the prices appended to this call.
    function usdValueOfEth(uint256 amount) external view returns (uint256) {
        return amount * getOracleNumericValueFromTxMsg(ETH) / 1e18;
    }

    /// The BTC price in ETH, 18 decimals, from the prices appended to this call.
    function btcInEth() external view returns (uint256) {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = BTC;
        ids[1] = ETH;
        uint256[] memory p = getOracleNumericValuesFromTxMsg(ids);
        return p[0] * 1e18 / p[1];
    }
}
