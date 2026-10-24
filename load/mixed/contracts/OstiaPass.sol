// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// 'Ostia Pass', a test NFT. Anyone can mint one for themselves, up to the cap.
contract OstiaPass is ERC721 {
    uint256 public immutable cap;
    uint256 public totalSupply;

    constructor(uint256 cap_) ERC721("Ostia Pass", "OPASS") {
        cap = cap_;
    }

    function mint() external returns (uint256 id) {
        require(totalSupply < cap, "OstiaPass: sold out");
        id = ++totalSupply;
        _mint(msg.sender, id);
    }
}
