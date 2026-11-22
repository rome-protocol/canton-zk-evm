// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Base, MockBridge} from "./Base.sol";
import {CantonRouter} from "../src/CantonRouter.sol";
import {CantonBook} from "../src/CantonBook.sol";
import {RouteState} from "../src/Interfaces.sol";

// Flow A: Canton to another chain. The Canton deposit names the router as recipient and carries the route label.
contract RouterOutTest is Base {
    address internal dest = makeAddr("dest");

    function setUp() public override {
        super.setUp();
        _open();
    }

    function _id(uint32 net, address to, uint256 maxFee, uint64 nonce) internal view returns (bytes32) {
        return router.depositId(PARTY, router.routeLabel(net, to, maxFee, nonce));
    }

    function test_sendToSepolia() public {
        bytes32 id = _id(SEPOLIA, dest, 15e7, 17);
        assertFalse(gw.used(id));
        vm.expectEmit(true, true, true, true, ROUTER);
        emit CantonRouter.RoutedOut(id, keccak256(bytes(PARTY)), dest, PARTY, SEPOLIA, address(cc), CC - 15e7, 15e7, 0);
        _out(CC, SEPOLIA, dest, 15e7, 17);
        assertTrue(gw.used(id)); // the gateway claimed the deposit under the id the router worked out
        assertEq(cc.balanceOf(feeTo), 15e7); // feeOut 0.01 CC and Sepolia's claim part 0.005 CC
        assertEq(cc.balanceOf(address(bridge)), CC - 15e7);
        assertEq(cc.balanceOf(ROUTER), 0);
        assertEq(cc.totalSupply(), CC); // minted by the claim, nothing else
        assertEq(cc.allowance(ROUTER, address(bridge)), 0);
        assertEq(bridge.depositCount(), 1);
        MockBridge.Leaf memory l = bridge.leaf(0);
        assertEq(l.destNetwork, SEPOLIA);
        assertEq(l.destAddress, dest);
        assertEq(l.amount, CC - 15e7);
        assertEq(l.token, address(cc));
        assertEq(l.from, ROUTER);
        assertTrue(gw.legs(block.number) != bytes32(0));
    }

    function test_anyoneMayCallAndTheFeeIsTheSame() public {
        vm.prank(user);
        _out(CC, SEPOLIA, dest, 15e7, 1);
        assertEq(cc.balanceOf(feeTo), 15e7);
    }

    function test_feeCanBeBelowMaxFeeAndTheUserPaysTheLower() public {
        vm.prank(owner);
        bookAs.setFees(address(cc), 2e7, 0, 0);
        _out(CC, SEPOLIA, dest, 15e7, 1);
        assertEq(cc.balanceOf(feeTo), 7e7); // 0.002 + 0.005, not the 0.015 of the label
        assertEq(bridge.leaf(0).amount, CC - 7e7);
    }

    function test_feeExactlyAtMaxFeeIsAccepted() public {
        _out(CC, SEPOLIA, dest, 15e7, 1);
        assertEq(bridge.leafCount(), 1);
    }

    function test_labelPartsMakeTheId() public {
        _out(CC, SEPOLIA, dest, 15e7, 1);
        assertTrue(gw.used(_id(SEPOLIA, dest, 15e7, 1)));
        assertFalse(gw.used(_id(SEPOLIA, dest, 15e7, 2))); // another nonce, another id
        assertFalse(gw.used(_id(SEPOLIA, dest, 16e7, 1))); // another fee cap
        assertFalse(gw.used(_id(SEPOLIA, user, 15e7, 1))); // another destination
        assertFalse(gw.used(_id(HADRIAN, dest, 15e7, 1))); // another network
        _out(CC, SEPOLIA, dest, 15e7, 2); // the same move with a fresh nonce
        assertEq(bridge.leafCount(), 2);
    }

    function test_sameLabelTwiceRevertsAtTheGateway() public {
        _out(CC, SEPOLIA, dest, 15e7, 1);
        vm.expectRevert("id used");
        _out(CC, SEPOLIA, dest, 15e7, 1);
    }

    function test_sendToHadrianCutsToWholeSolanaUnits() public {
        // amount 1 CC + 7 base units: the fee is 1e8, the rest 9.9e9 + 7 is cut to 9.9e9, and the 7 go into the fee
        _out(CC + 7, HADRIAN, dest, 1e8, 1);
        assertEq(bridge.leaf(0).destNetwork, HADRIAN);
        assertEq(bridge.leaf(0).amount, 99e8);
        assertEq(cc.balanceOf(feeTo), 1e8 + 7);
        assertEq(cc.balanceOf(ROUTER), 0);
        assertEq(bridge.leaf(0).amount % 10, 0);
    }

    function test_hadrianPaysNoClaimPart() public {
        _out(CC, HADRIAN, dest, 1e8, 1); // maxFee 0.01 is enough: Hadrian's claim part is 0
        assertEq(cc.balanceOf(feeTo), 1e8);
    }

    function test_claimPartIsAddedPerNetwork() public {
        vm.prank(owner);
        bookAs.setClaimFee(address(cc), HADRIAN, 3e7);
        vm.expectRevert(abi.encodeWithSelector(CantonRouter.FeeAboveMax.selector, 13e7, 1e8));
        _out(CC, HADRIAN, dest, 1e8, 1);
        _out(CC, HADRIAN, dest, 13e7, 1);
        assertEq(cc.balanceOf(feeTo), 13e7);
    }

    // Every refusal comes before the claim: the deposit is never claimed, so it lapses on Canton and the depositor keeps the coin.
    function _refused(bytes memory err, uint256 amount, uint32 net, address to, uint256 maxFee, uint64 nonce) internal {
        bytes32 id = _id(net, to, maxFee, nonce);
        vm.expectRevert(err);
        _out(amount, net, to, maxFee, nonce);
        assertFalse(gw.used(id));
        assertEq(cc.totalSupply(), 0);
        assertEq(bridge.leafCount(), 0);
    }

    function test_refusesZeroDestination() public {
        _refused(abi.encodeWithSelector(CantonRouter.BadArgument.selector), CC, SEPOLIA, address(0), 15e7, 1);
    }

    function test_refusesWhenTheDirectionIsClosed() public {
        vm.prank(refuser);
        bookAs.setOut(false);
        _refused(abi.encodeWithSelector(CantonBook.OutClosed.selector), CC, SEPOLIA, dest, 15e7, 1);
    }

    function test_refusesAStoppedRouteOrUnlistedToken() public {
        vm.prank(refuser);
        bookAs.setRoute(address(cc), RouteState.Stopped);
        _refused(abi.encodeWithSelector(CantonBook.RouteNotOpen.selector, address(cc)), CC, SEPOLIA, dest, 15e7, 1);
        vm.expectRevert(abi.encodeWithSelector(CantonBook.RouteNotOpen.selector, address(1)));
        router.claimAndBridge(PARTY, address(1), CC, SEPOLIA, dest, 15e7, 1);
    }

    function test_refusesAStoppedOrUnknownDestination() public {
        vm.prank(refuser);
        bookAs.stopDestination(SEPOLIA);
        _refused(abi.encodeWithSelector(CantonBook.DestinationNotOpen.selector, SEPOLIA), CC, SEPOLIA, dest, 15e7, 1);
        _refused(abi.encodeWithSelector(CantonBook.DestinationNotOpen.selector, uint32(99)), CC, 99, dest, 15e7, 1);
        _refused(abi.encodeWithSelector(CantonBook.DestinationNotOpen.selector, OSTIA), CC, OSTIA, dest, 15e7, 1); // Ostia itself is never a destination
    }

    function test_refusesWhenTheFeeIsAboveMaxFee() public {
        _refused(abi.encodeWithSelector(CantonRouter.FeeAboveMax.selector, 15e7, 15e7 - 1), CC, SEPOLIA, dest, 15e7 - 1, 1);
    }

    function test_refusesWhenTheFeeWasRaisedAfterTheDeposit() public {
        bytes32 id = _id(SEPOLIA, dest, 15e7, 1); // the label was written when the fee was 0.015
        vm.prank(owner);
        bookAs.setFees(address(cc), 2e8, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(CantonRouter.FeeAboveMax.selector, 25e7, 15e7));
        _out(CC, SEPOLIA, dest, 15e7, 1);
        assertFalse(gw.used(id));
    }

    function test_refusesBelowTheMinimum() public {
        _refused(abi.encodeWithSelector(CantonRouter.BelowMinimum.selector, 1e9 - 1, 1e9), 1e9 - 1, SEPOLIA, dest, 15e7, 1);
        _out(1e9, SEPOLIA, dest, 15e7, 1); // exactly the minimum goes
    }

    function test_refusesWhenNothingIsLeftAfterTheFee() public {
        vm.startPrank(owner);
        bookAs.setLimits(address(cc), 0, 10 * CC);
        vm.stopPrank();
        _refused(abi.encodeWithSelector(CantonRouter.NothingLeft.selector), 15e7, SEPOLIA, dest, 15e7, 1); // the amount is the fee
        _refused(abi.encodeWithSelector(CantonRouter.NothingLeft.selector), 1, SEPOLIA, dest, 15e7, 1);
        _refused(abi.encodeWithSelector(CantonRouter.NothingLeft.selector), 1e8 + 9, HADRIAN, dest, 1e8, 1); // under one Solana unit after the fee
        _out(15e7 + 1, SEPOLIA, dest, 15e7, 1); // one base unit left is enough on Sepolia
        assertEq(bridge.leaf(0).amount, 1);
    }

    function test_refusesOverTheLockCap() public {
        _lock(95e9); // 9.5 CC already in the bridge: room 0.5 CC
        assertEq(router.lockRoom(address(cc)), 5e9);
        uint256 supply = cc.totalSupply();
        bytes32 id = _id(SEPOLIA, dest, 15e7, 1);
        vm.expectRevert(abi.encodeWithSelector(CantonRouter.OverLockCap.selector, CC - 15e7, 5e9));
        _out(CC, SEPOLIA, dest, 15e7, 1);
        assertFalse(gw.used(id)); // all checks come before the claim
        assertEq(cc.totalSupply(), supply);
        _out(5e9 + 15e7, SEPOLIA, dest, 15e7, 1); // a send that fills the room exactly goes
        assertEq(router.lockRoom(address(cc)), 0);
        vm.prank(owner);
        bookAs.setLimits(address(cc), 0, 10 * CC);
        vm.expectRevert(abi.encodeWithSelector(CantonRouter.OverLockCap.selector, 1, 0));
        _out(15e7 + 1, SEPOLIA, dest, 15e7, 2);
    }

    function test_lockRoomFollowsTheBridgeBalanceAndTheCap() public {
        assertEq(router.lockRoom(address(cc)), 10 * CC);
        _lock(3 * CC);
        assertEq(router.lockRoom(address(cc)), 7 * CC);
        _lock(8 * CC);
        assertEq(router.lockRoom(address(cc)), 0); // over the cap: none is left, never a wrap
        vm.prank(owner);
        bookAs.setLimits(address(cc), 1e9, 20 * CC);
        assertEq(router.lockRoom(address(cc)), 9 * CC);
        assertEq(router.lockRoom(gw.register("Other", "OT")), 0); // an unlisted token has no cap
    }

    function test_bridgeInEmergencyStateUndoesTheWholeCall() public {
        bridge.setEmergency(true);
        bytes32 id = _id(SEPOLIA, dest, 15e7, 1);
        vm.expectRevert("emergency");
        _out(CC, SEPOLIA, dest, 15e7, 1);
        assertFalse(gw.used(id)); // the claim, the mint and the fee went with it
        assertEq(cc.totalSupply(), 0);
        assertEq(cc.balanceOf(feeTo), 0);
        bridge.setEmergency(false);
        _out(CC, SEPOLIA, dest, 15e7, 1); // the same deposit goes through afterwards
        assertTrue(gw.used(id));
    }

    function test_theRouterEndsEveryCallWithZero() public {
        _out(CC, SEPOLIA, dest, 15e7, 1);
        _out(CC + 7, HADRIAN, dest, 1e8, 2);
        assertEq(cc.balanceOf(ROUTER), 0);
        assertEq(cc.totalSupply(), cc.balanceOf(address(bridge)) + cc.balanceOf(feeTo));
    }

    function testFuzz_sendPlusFeeIsTheAmountAndTheSendIsWholeUnits(uint256 amount, uint8 which) public {
        amount = bound(amount, 1e9, 10 * CC);
        uint32 net = which % 2 == 0 ? SEPOLIA : HADRIAN;
        (bool ok,) = address(router).call(abi.encodeCall(CantonRouter.claimAndBridge, (PARTY, address(cc), amount, net, dest, 2e8, uint64(which))));
        if (!ok) return;
        assertEq(bridge.leaf(0).amount % (net == HADRIAN ? 10 : 1), 0);
        assertEq(bridge.leaf(0).amount + cc.balanceOf(feeTo), amount);
        assertEq(cc.balanceOf(ROUTER), 0);
    }
}
