// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {NoteBoard} from "../src/NoteBoard.sol";

// The part of an AggLayer bridge that a receiver meets: claimMessage marks the leaf claimed, calls the receiver and reverts the whole claim if the call fails.
contract MockMessageBridge {
    mapping(uint256 => bool) public isClaimed;
    error MessageFailed();

    function claimMessage(bytes32[32] calldata, bytes32[32] calldata, uint256 globalIndex, bytes32, bytes32, uint32 originNetwork, address originAddress,
        uint32, address destinationAddress, uint256 amount, bytes calldata metadata) external {
        require(!isClaimed[globalIndex], "AlreadyClaimed");
        isClaimed[globalIndex] = true;
        (bool ok,) = destinationAddress.call{value: amount}(abi.encodeWithSignature("onMessageReceived(address,uint32,bytes)", originAddress, originNetwork, metadata));
        if (!ok) revert MessageFailed();
    }

    function unsetClaim(uint256 globalIndex) external { isClaimed[globalIndex] = false; }
}

contract NoteBoardTest is Test {
    event NoteReceived(uint32 indexed originNetwork, address indexed originAddress, uint256 indexed number, bytes text);

    MockMessageBridge bridge;
    NoteBoard board;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    bytes32[32] proof;

    function setUp() public {
        bridge = new MockMessageBridge();
        board = new NoteBoard(address(bridge));
    }

    function claim(uint256 index, uint32 network, address from, bytes memory text) internal {
        bridge.claimMessage(proof, proof, index, 0, 0, network, from, 75, address(board), 0, text);
    }

    function test_bridgeIsFixedAtCreation() public view {
        assertEq(board.BRIDGE(), address(bridge));
        assertEq(board.count(), 0);
    }

    function test_claimDeliversTheNoteAndEmitsTheEvent() public {
        vm.expectEmit(true, true, true, true, address(board));
        emit NoteReceived(0, alice, 1, "hello");
        claim(1, 0, alice, "hello");
        (bytes memory text, uint64 at, uint256 number) = board.noteOf(0, alice);
        assertEq(text, "hello");
        assertEq(at, uint64(block.timestamp));
        assertEq(number, 1);
        assertEq(board.count(), 1);
        assertTrue(bridge.isClaimed(1));
    }

    function test_onlyTheBridgeMayDeliver() public {
        vm.expectRevert(NoteBoard.NotBridge.selector);
        board.onMessageReceived(alice, 0, "forged");
        vm.prank(alice);
        vm.expectRevert(NoteBoard.NotBridge.selector);
        board.onMessageReceived(alice, 0, "forged");
        assertEq(board.count(), 0);
    }

    function testFuzz_noOneButTheBridgeMayDeliver(address caller, address origin, uint32 network, bytes calldata text) public {
        vm.assume(caller != address(bridge));
        vm.prank(caller);
        vm.expectRevert(NoteBoard.NotBridge.selector);
        board.onMessageReceived(origin, network, text);
        assertEq(board.count(), 0);
    }

    function test_aRefusedCallDoesNotMarkTheLeafClaimed() public {
        NoteBoard other = new NoteBoard(address(0xDEAD));
        vm.expectRevert(MockMessageBridge.MessageFailed.selector);
        bridge.claimMessage(proof, proof, 7, 0, 0, 0, alice, 75, address(other), 0, "x");
        assertFalse(bridge.isClaimed(7));
    }

    function test_keepsTheLatestNoteOfEachSender() public {
        claim(1, 0, alice, "first");
        claim(2, 0, alice, "second");
        (bytes memory text,, uint256 number) = board.noteOf(0, alice);
        assertEq(text, "second");
        assertEq(number, 2);
        assertEq(board.count(), 2);
    }

    function test_sendersAndNetworksAreKeptApart() public {
        claim(1, 0, alice, "from alice");
        claim(2, 0, bob, "from bob");
        claim(3, 5, alice, "alice on network 5");
        (bytes memory a,,) = board.noteOf(0, alice);
        (bytes memory b,,) = board.noteOf(0, bob);
        (bytes memory c,,) = board.noteOf(5, alice);
        assertEq(a, "from alice");
        assertEq(b, "from bob");
        assertEq(c, "alice on network 5");
    }

    function test_aSenderWithoutANoteReadsEmpty() public view {
        (bytes memory text, uint64 at, uint256 number) = board.noteOf(0, alice);
        assertEq(text.length, 0);
        assertEq(at, 0);
        assertEq(number, 0);
    }

    function test_theSameLeafCannotBeClaimedTwice() public {
        claim(1, 0, alice, "once");
        vm.expectRevert("AlreadyClaimed");
        claim(1, 0, alice, "once");
        assertEq(board.count(), 1);
    }

    function test_aReplayAfterAnUnsetWritesTheSameNoteAgain() public {
        claim(1, 0, alice, "once");
        bridge.unsetClaim(1);
        claim(1, 0, alice, "once");
        (bytes memory text,, uint256 number) = board.noteOf(0, alice);
        assertEq(text, "once");
        assertEq(number, 2);
    }

    function test_aValueMessageStillDeliversAndTheValueStays() public {
        vm.deal(address(bridge), 1 ether);
        bridge.claimMessage(proof, proof, 1, 0, 0, 0, alice, 75, address(board), 0.5 ether, "paid");
        (bytes memory text,,) = board.noteOf(0, alice);
        assertEq(text, "paid");
        assertEq(address(board).balance, 0.5 ether);
    }

    function test_anEmptyNoteIsKept() public {
        claim(1, 0, alice, "full");
        claim(2, 0, alice, "");
        (bytes memory text,, uint256 number) = board.noteOf(0, alice);
        assertEq(text.length, 0);
        assertEq(number, 2);
    }

    function testFuzz_whateverTheBridgeDeliversIsKept(uint32 network, address from, bytes calldata text) public {
        claim(1, network, from, text);
        (bytes memory kept,, uint256 number) = board.noteOf(network, from);
        assertEq(kept, text);
        assertEq(number, 1);
    }
}
