// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// 'Ostia Items', a test multi-token. Ids 1 to 5 exist (1 Sword, 2 Shield, 3 Potion, 4 Map, 5 Key); anyone can mint any of them for themselves, singly or in a batch.
contract OstiaItems is ERC1155 {
    string public constant name = "Ostia Items";
    string public constant symbol = "OITEM";
    uint256 public constant MAX_ID = 5;
    uint256 public constant MAX_AMOUNT = 1_000_000;

    constructor() ERC1155("") {}

    function mint(uint256 id, uint256 amount) external {
        require(id >= 1 && id <= MAX_ID && amount <= MAX_AMOUNT, "OstiaItems: bad id or amount");
        _mint(msg.sender, id, amount, "");
    }

    function mintBatch(uint256[] calldata ids, uint256[] calldata amounts) external {
        for (uint256 i = 0; i < ids.length; i++) {
            require(ids[i] >= 1 && ids[i] <= MAX_ID && amounts[i] <= MAX_AMOUNT, "OstiaItems: bad id or amount");
        }
        _mintBatch(msg.sender, ids, amounts, "");
    }
}
