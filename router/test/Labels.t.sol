// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Base} from "./Base.sol";

contract LabelsTest is Base {
    function _vec(string memory field, uint256 i) internal view returns (string memory) {
        return vm.parseJsonString(vm.readFile("test/vectors/r1.json"), string.concat(".labels[", vm.toString(i), "].", field));
    }

    // Fixed vectors: the label text and the deposit id, byte for byte. The ids are what demo/canton.py's deposit_id_of makes.
    function test_vectorsLabelAndId() public view {
        for (uint256 i = 0; i < 4; i++) {
            string memory party = _vec("party", i);
            uint32 net = uint32(vm.parseUint(_vec("net", i)));
            address dest = vm.parseAddress(_vec("dest", i));
            uint256 maxFee = vm.parseUint(_vec("maxFee", i));
            uint64 nonce = uint64(vm.parseUint(_vec("nonce", i)));
            string memory label = router.routeLabel(net, dest, maxFee, nonce);
            assertEq(label, _vec("label", i));
            assertEq(router.depositId(party, label), vm.parseBytes32(_vec("id", i)));
            (bool ok, uint32 n2, address d2, uint256 f2, uint64 q2) = router.parseLabel(label);
            assertTrue(ok);
            assertEq(n2, net);
            assertEq(d2, dest);
            assertEq(f2, maxFee);
            assertEq(q2, nonce);
        }
    }

    function test_designExample() public view {
        assertEq(router.routeLabel(0, 0x5B38Da6a701c568545dCfcB03FcB875f56beddC4, 2000000000, 17), "r1:0:0x5b38da6a701c568545dcfcb03fcb875f56beddc4:2000000000:17");
    }

    function test_decimalsHaveNoLeadingZeros() public view {
        assertEq(router.routeLabel(0, address(1), 0, 0), "r1:0:0x0000000000000000000000000000000000000001:0:0");
        assertEq(router.routeLabel(10, address(1), 100, 1000), "r1:10:0x0000000000000000000000000000000000000001:100:1000");
        assertEq(router.routeLabel(type(uint32).max, address(1), type(uint256).max, type(uint64).max),
            "r1:4294967295:0x0000000000000000000000000000000000000001:115792089237316195423570985008687907853269984665640564039457584007913129639935:18446744073709551615");
    }

    function _bad(string memory label) internal view {
        (bool ok,,,,) = router.parseLabel(label);
        assertFalse(ok, label);
    }

    function test_parseRefusesAnythingNotExact() public view {
        string memory a = "0x5b38da6a701c568545dcfcb03fcb875f56beddc4";
        _bad("");
        _bad("r1:");
        _bad(string.concat("r2:0:", a, ":1:1")); // another form
        _bad(string.concat("R1:0:", a, ":1:1"));
        _bad(string.concat("r1:00:", a, ":1:1")); // a leading zero in each decimal
        _bad(string.concat("r1:0:", a, ":01:1"));
        _bad(string.concat("r1:0:", a, ":1:01"));
        _bad(string.concat("r1:0:", a, ":1")); // a part missing
        _bad(string.concat("r1:0:", a, ":1:1:1")); // a part too many
        _bad(string.concat("r1:0:", a, ":1:1\n")); // a trailing newline
        _bad(string.concat("r1:0:", a, ":1:1 "));
        _bad(string.concat("r1:0:0X5b38da6a701c568545dcfcb03fcb875f56beddc4:1:1"));
        _bad("r1:0:0x5B38DA6A701C568545DCFCB03FCB875F56BEDDC4:1:1"); // capital hex
        _bad("r1:0:0x5b38da6a701c568545dcfcb03fcb875f56beddc:1:1"); // 39 digits
        _bad("r1:0:0x5b38da6a701c568545dcfcb03fcb875f56beddc4a:1:1"); // 41 digits
        _bad("r1:0:0x5b38da6a701c568545dcfcb03fcb875f56beddcg:1:1"); // not hex
        _bad(string.concat("r1:4294967296:", a, ":1:1")); // too big for the type: network, nonce, maxFee
        _bad(string.concat("r1:0:", a, ":1:18446744073709551616"));
        _bad(string.concat("r1:0:", a, ":115792089237316195423570985008687907853269984665640564039457584007913129639936:1"));
        _bad(string.concat("r1:-1:", a, ":1:1"));
        _bad(string.concat("r1::", a, ":1:1")); // an empty part
        _bad(string.concat("r1:0:", a, "::1"));
        _bad(string.concat("r1:0:", a, ":1:"));
    }

    // The storage sits at the ERC-7201 locations, fields in the order the layout check will pin.
    function test_storageLocations() public view {
        bytes32 bookSlot = keccak256(abi.encode(uint256(keccak256("rome.canton.book.v1")) - 1)) & ~bytes32(uint256(0xff));
        bytes32 routerSlot = keccak256(abi.encode(uint256(keccak256("rome.canton.router.v1")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(vm.load(address(book), bytes32(uint256(bookSlot) + 5)), bytes32(uint256(3 days))); // refundWait
        assertEq(vm.load(address(book), bytes32(uint256(bookSlot) + 6)), bytes32(uint256(uint160(feeTo))));
        assertEq(vm.load(address(book), bytes32(uint256(bookSlot) + 7)), bytes32(uint256(uint160(owner))));
        assertEq(vm.load(address(book), bytes32(uint256(bookSlot) + 8)), bytes32(uint256(uint160(refuser)) | (uint256(OSTIA) << 160))); // refuser and localNetwork share a slot
        assertEq(vm.load(ROUTER, routerSlot), bytes32(uint256(uint160(address(book)))));
        assertEq(vm.load(ROUTER, bytes32(uint256(routerSlot) + 1)), bytes32(uint256(uint160(address(gw)))));
        assertEq(vm.load(ROUTER, bytes32(uint256(routerSlot) + 2)), bytes32(uint256(uint160(address(bridge)))));
        assertEq(vm.load(ROUTER, bytes32(uint256(routerSlot) + 3)), router.inboxCodeHash());
    }
}
