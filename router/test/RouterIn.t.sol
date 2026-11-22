// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Base, MockBridge} from "./Base.sol";
import {CantonRouter, CantonRouter as R} from "../src/CantonRouter.sol";
import {CantonBook} from "../src/CantonBook.sol";
import {CantonInbox} from "../src/CantonInbox.sol";
import {ClaimArgs, RouteState} from "../src/Interfaces.sol";
import {Wrapped} from "gateway/Gateway.sol";

// Flow C: back to Canton, through the inbox of a party, and the refund when Canton cannot pay.
contract RouterInTest is Base {
    uint256 internal index;

    function setUp() public override {
        super.setUp();
        _open();
    }

    // CC that a sender's transfer put into the bridge for this inbox, then claimed into it without the Canton leg.
    function _hold(address inbox, uint256 amount) internal {
        _lock(amount);
        router.claimToInbox(_claim(inbox, amount, ++index), PARTY, SEPOLIA, user);
    }

    // Someone claims straight through the bridge, so the router sees a balance and no clock.
    function _claimDirect(address inbox, address token, uint256 amount) internal {
        ClaimArgs memory c = _claim(inbox, amount, ++index);
        c.originTokenAddress = token;
        bridge.claimAsset(c.smtProofLocalExitRoot, c.smtProofRollupExitRoot, c.globalIndex, c.mainnetExitRoot, c.rollupExitRoot, c.originNetwork, token, c.destinationNetwork, inbox, amount, "");
    }

    // ---- openInbox

    function test_openInbox() public {
        address expected = router.inboxOf(PARTY, SEPOLIA, user);
        assertEq(expected.code.length, 0);
        vm.expectEmit(true, true, true, true, ROUTER);
        emit CantonRouter.InboxOpened(expected, keccak256(bytes(PARTY)), user, PARTY, SEPOLIA);
        vm.prank(makeAddr("anyone"));
        address inbox = router.openInbox(PARTY, SEPOLIA, user);
        assertEq(inbox, expected);
        assertTrue(inbox.code.length > 0);
        assertEq(CantonInbox(inbox).router(), ROUTER);
        assertEq(router.openInbox(PARTY, SEPOLIA, user), inbox); // opened once, usable again
    }

    function test_inboxAddressFollowsTheThreeParts() public {
        address a = _inbox();
        assertTrue(a != router.inboxOf(PARTY, HADRIAN, user));
        assertTrue(a != router.inboxOf(PARTY, SEPOLIA, makeAddr("other")));
        assertTrue(a != router.inboxOf("bob::1220", SEPOLIA, user));
        assertEq(a, router.openInbox(PARTY, SEPOLIA, user));
    }

    function test_openInboxRefusals() public {
        vm.expectRevert(R.BadArgument.selector); // Ostia itself
        router.openInbox(PARTY, OSTIA, user);
        vm.expectRevert(R.BadArgument.selector); // a network the book does not know
        router.openInbox(PARTY, 99, user);
        vm.expectRevert(R.BadArgument.selector);
        router.openInbox(PARTY, SEPOLIA, address(0));
        vm.expectRevert(R.BadArgument.selector);
        router.openInbox("", SEPOLIA, user);
    }

    function test_openInboxNeedsTheSwitchButInboxesAlreadyOpenKeepWorking() public {
        address inbox = _inbox();
        vm.prank(refuser);
        bookAs.setIn(false);
        vm.expectRevert(R.InClosed.selector);
        router.openInbox("bob::1220", SEPOLIA, user);
        _hold(inbox, CC); // claimToInbox still lands
        assertEq(cc.balanceOf(inbox), CC);
    }

    function test_openInboxStopsWhenTheNetworkNeverWasKnown() public {
        vm.prank(owner);
        bookAs.setDestination(5, false, 10); // known but closed: an inbox may still name it, so it can be refunded
        router.openInbox(PARTY, 5, user);
    }

    function test_inboxObeysOnlyTheRouter() public {
        address inbox = _inbox();
        vm.expectRevert("router only");
        CantonInbox(inbox).exec(address(cc), abi.encodeCall(Wrapped.transfer, (user, 1)));
        vm.prank(address(bridge));
        vm.expectRevert("router only");
        CantonInbox(inbox).exec(address(cc), "");
    }

    // ---- claimAndWithdraw and forward

    function test_claimAndWithdrawPaysTheParty() public {
        address inbox = _inbox();
        _lock(CC);
        uint256 supply = cc.totalSupply();
        bytes32 id = keccak256(abi.encode(block.chainid, address(gw), uint256(1)));
        vm.expectEmit(false, false, false, true, address(gw)); // the gateway's withdrawal leg, with the party
        emit Leg(2, id, address(cc), inbox, CC - 2e8, PARTY);
        vm.expectEmit(true, true, false, true, ROUTER);
        emit CantonRouter.Forwarded(inbox, address(cc), CC - 2e8, 2e8);
        router.claimAndWithdraw(_claim(inbox, CC, 1), PARTY, SEPOLIA, user);
        assertEq(gw.withdrawals(), 1);
        assertEq(cc.balanceOf(inbox), 0);
        assertEq(cc.balanceOf(feeTo), 2e8); // feeIn
        assertEq(cc.balanceOf(address(bridge)), 0);
        assertEq(cc.totalSupply(), supply - (CC - 2e8)); // burnt: that much leaves custody on Canton
        assertEq(router.refundAt(inbox, address(cc)), 0);
    }

    event Leg(uint8 kind, bytes32 id, address token, address account, uint256 amount, string party);

    function test_claimAndWithdrawRefusals() public {
        address inbox = _inbox();
        _lock(CC);
        ClaimArgs memory c = _claim(inbox, CC, 1);
        c.destinationAddress = user; // not the inbox
        vm.expectRevert(R.WrongInbox.selector);
        router.claimAndWithdraw(c, PARTY, SEPOLIA, user);
        c = _claim(inbox, CC, 1);
        vm.expectRevert(R.InboxNotOpen.selector); // the party never opened it
        router.claimAndWithdraw(c, "bob::1220", SEPOLIA, user);
        c.originNetwork = SEPOLIA; // a token born elsewhere
        vm.expectRevert(R.WrongOrigin.selector);
        router.claimAndWithdraw(c, PARTY, SEPOLIA, user);
        c = _claim(inbox, CC, 1);
        address other = gw.register("Other", "OT");
        c.originTokenAddress = other; // not listed
        vm.expectRevert(abi.encodeWithSelector(R.NotListed.selector, other));
        router.claimAndWithdraw(c, PARTY, SEPOLIA, user);
        vm.expectRevert(abi.encodeWithSelector(R.NotListed.selector, other));
        router.claimToInbox(c, PARTY, SEPOLIA, user);
        assertFalse(bridge.claimed(1)); // nothing was claimed
    }

    function test_claimAndWithdrawNeedsTheSwitchAndAnOpenRouteButClaimToInboxDoesNot() public {
        address inbox = _inbox();
        _lock(CC);
        vm.prank(refuser);
        bookAs.setIn(false);
        vm.expectRevert(CantonBook.InClosed.selector);
        router.claimAndWithdraw(_claim(inbox, CC, 1), PARTY, SEPOLIA, user);
        assertFalse(bridge.claimed(1)); // the claim went with the revert
        vm.startPrank(owner);
        bookAs.setIn(true);
        vm.stopPrank();
        vm.prank(refuser);
        bookAs.setRoute(address(cc), RouteState.Stopped);
        vm.expectRevert(abi.encodeWithSelector(CantonBook.RouteNotOpen.selector, address(cc)));
        router.claimAndWithdraw(_claim(inbox, CC, 1), PARTY, SEPOLIA, user);
        router.claimToInbox(_claim(inbox, CC, 1), PARTY, SEPOLIA, user); // the claim that holds always lands
        assertEq(cc.balanceOf(inbox), CC);
    }

    function test_forwardPaysWhatIsHeldAndClearsTheClock() public {
        address inbox = _inbox();
        _hold(inbox, CC);
        assertTrue(router.refundAt(inbox, address(cc)) != 0);
        vm.expectEmit(true, true, false, true, ROUTER);
        emit CantonRouter.Forwarded(inbox, address(cc), CC - 2e8, 2e8);
        router.forward(PARTY, SEPOLIA, user, address(cc));
        assertEq(gw.withdrawals(), 1);
        assertEq(cc.balanceOf(feeTo), 2e8);
        assertEq(cc.balanceOf(inbox), 0);
        assertEq(router.refundAt(inbox, address(cc)), 0);
    }

    function test_forwardWithNothingHeldOrNoInbox() public {
        address inbox = _inbox();
        vm.expectRevert(R.NothingHeld.selector);
        router.forward(PARTY, SEPOLIA, user, address(cc));
        vm.expectRevert(R.InboxNotOpen.selector);
        router.forward("bob::1220", SEPOLIA, user, address(cc));
        assertEq(inbox, router.inboxOf(PARTY, SEPOLIA, user));
    }

    function test_forwardOfADustBalanceGoesWholeToTheFee() public {
        address inbox = _inbox();
        _hold(inbox, 1e8); // at or below the 0.02 CC fee
        assertTrue(router.refundAt(inbox, address(cc)) != 0);
        vm.expectEmit(true, true, false, true, ROUTER);
        emit CantonRouter.Forwarded(inbox, address(cc), 0, 1e8);
        router.forward(PARTY, SEPOLIA, user, address(cc));
        assertEq(gw.withdrawals(), 0); // no gateway call
        assertEq(cc.balanceOf(feeTo), 1e8);
        assertEq(cc.balanceOf(inbox), 0);
        assertEq(router.refundAt(inbox, address(cc)), 0);
    }

    function test_forwardOfExactlyTheFeeIsDustToo() public {
        address inbox = _inbox();
        _hold(inbox, 2e8);
        router.forward(PARTY, SEPOLIA, user, address(cc));
        assertEq(gw.withdrawals(), 0);
        assertEq(cc.balanceOf(feeTo), 2e8);
        _hold(inbox, 2e8 + 1); // one above the fee pays one unit
        router.forward(PARTY, SEPOLIA, user, address(cc));
        assertEq(gw.withdrawals(), 1);
    }

    // ---- claimToInbox, mark and the clock

    function test_claimToInboxHoldsAndStartsTheClock() public {
        address inbox = _inbox();
        _lock(CC);
        uint256 end = block.timestamp + 3 days;
        vm.expectEmit(true, true, false, true, ROUTER);
        emit CantonRouter.Held(inbox, address(cc), CC, end);
        router.claimToInbox(_claim(inbox, CC, 1), PARTY, SEPOLIA, user);
        assertEq(cc.balanceOf(inbox), CC);
        assertEq(router.refundAt(inbox, address(cc)), end);
    }

    function test_oneClockPerInboxAndTokenAndASecondTransferJoinsIt() public {
        address inbox = _inbox();
        uint256 end = block.timestamp + 3 days;
        _hold(inbox, CC);
        skip(2 days);
        _lock(CC);
        vm.expectEmit(true, true, false, true, ROUTER);
        emit CantonRouter.Held(inbox, address(cc), 2 * CC, end); // the second transfer's row carries the running clock's end
        router.claimToInbox(_claim(inbox, CC, 99), PARTY, SEPOLIA, user);
        assertEq(router.refundAt(inbox, address(cc)), end);
        skip(1 days); // the end of the first clock: both can go back, the second before its own three days
        router.refund(PARTY, SEPOLIA, user, address(cc));
        assertEq(bridge.leaf(0).amount, 2 * CC - 35e7);
    }

    function test_aChangeOfTheWaitMovesNoRunningClock() public {
        address inbox = _inbox();
        uint256 end = block.timestamp + 3 days;
        _hold(inbox, CC);
        vm.prank(owner);
        bookAs.setRefundWait(30 days);
        _lock(CC);
        router.claimToInbox(_claim(inbox, CC, 50), PARTY, SEPOLIA, user);
        assertEq(router.refundAt(inbox, address(cc)), end);
        address second = router.openInbox("bob::1220", SEPOLIA, user); // a new clock takes the wait in force
        _lock(CC);
        router.claimToInbox(_claim(second, CC, 51), "bob::1220", SEPOLIA, user);
        assertEq(router.refundAt(second, address(cc)), block.timestamp + 30 days);
    }

    function test_markStartsTheClockForABalanceSomeoneElseClaimed() public {
        address inbox = _inbox();
        _lock(CC);
        _claimDirect(inbox, address(cc), CC);
        assertEq(router.refundAt(inbox, address(cc)), 0);
        vm.expectRevert(abi.encodeWithSelector(R.NotYet.selector, uint256(0))); // no clock yet: it cannot be refunded at once
        router.refund(PARTY, SEPOLIA, user, address(cc));
        uint256 end = block.timestamp + 3 days;
        vm.expectEmit(true, true, false, true, ROUTER);
        emit CantonRouter.Held(inbox, address(cc), CC, end);
        router.mark(PARTY, SEPOLIA, user, address(cc));
        assertEq(router.refundAt(inbox, address(cc)), end);
        skip(1 days);
        router.mark(PARTY, SEPOLIA, user, address(cc)); // the clock keeps its end, and Held says so
        assertEq(router.refundAt(inbox, address(cc)), end);
    }

    function test_markOnAnEmptyInboxMakesNoRow() public {
        address inbox = _inbox();
        vm.recordLogs();
        router.mark(PARTY, SEPOLIA, user, address(cc));
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(router.refundAt(inbox, address(cc)), 0);
        vm.expectRevert(R.InboxNotOpen.selector);
        router.mark("bob::1220", SEPOLIA, user, address(cc));
    }

    // ---- refund

    function test_refundAfterTheWait() public {
        address inbox = _inbox();
        _hold(inbox, CC);
        uint256 end = router.refundAt(inbox, address(cc));
        vm.expectRevert(abi.encodeWithSelector(R.NotYet.selector, end));
        router.refund(PARTY, SEPOLIA, user, address(cc));
        skip(3 days - 1);
        vm.expectRevert(abi.encodeWithSelector(R.NotYet.selector, end));
        router.refund(PARTY, SEPOLIA, user, address(cc));
        skip(1);
        uint256 count = bridge.depositCount();
        vm.expectEmit(true, true, false, true, ROUTER);
        emit CantonRouter.Refunded(inbox, address(cc), CC - 35e7, 35e7, count); // feeRefund 0.03 CC and Sepolia's claim part 0.005
        vm.prank(makeAddr("anyone"));
        router.refund(PARTY, SEPOLIA, user, address(cc));
        MockBridge.Leaf memory l = bridge.leaf(bridge.leafCount() - 1);
        assertEq(l.destNetwork, SEPOLIA);
        assertEq(l.destAddress, user); // the refund address of the inbox, whoever called
        assertEq(l.amount, CC - 35e7);
        assertEq(l.from, inbox);
        assertEq(cc.balanceOf(feeTo), 35e7);
        assertEq(cc.balanceOf(inbox), 0);
        assertEq(cc.allowance(inbox, address(bridge)), 0);
        assertEq(router.refundAt(inbox, address(cc)), 0);
    }

    function test_refundToHadrianCutsToWholeUnitsAndPaysNoClaimPart() public {
        address inbox = router.openInbox(PARTY, HADRIAN, user);
        _lock(CC + 7);
        router.claimToInbox(_claim(inbox, CC + 7, 1), PARTY, HADRIAN, user);
        skip(3 days);
        router.refund(PARTY, HADRIAN, user, address(cc));
        assertEq(bridge.leaf(bridge.leafCount() - 1).amount, 97e8); // 1e10 + 7 - 3e8 = 9.7e9 + 7, cut to 9.7e9
        assertEq(cc.balanceOf(feeTo), 3e8 + 7);
        assertEq(cc.balanceOf(inbox), 0);
    }

    function test_refundOfADustBalanceGoesWholeToTheFeeWithNoBridgeCall() public {
        address inbox = _inbox();
        _hold(inbox, 3e8); // at the refund fee: nothing is left to send
        skip(3 days);
        uint256 leaves = bridge.leafCount();
        vm.expectEmit(true, true, false, true, ROUTER);
        emit CantonRouter.Refunded(inbox, address(cc), 0, 3e8, bridge.depositCount());
        router.refund(PARTY, SEPOLIA, user, address(cc));
        assertEq(bridge.leafCount(), leaves);
        assertEq(cc.balanceOf(feeTo), 3e8);
        assertEq(router.refundAt(inbox, address(cc)), 0);
    }

    function test_refundReadsNoSwitch() public {
        address inbox = _inbox();
        _hold(inbox, CC);
        vm.startPrank(owner);
        bookAs.setOut(false);
        bookAs.setIn(false);
        bookAs.setRoute(address(cc), RouteState.Stopped);
        bookAs.stopDestination(SEPOLIA);
        vm.stopPrank();
        skip(3 days);
        router.refund(PARTY, SEPOLIA, user, address(cc)); // held coin can always go home
        assertEq(bridge.leaf(bridge.leafCount() - 1).amount, CC - 35e7);
    }

    function test_refundBlockedByTheBridgeLeavesTheCoinAndTheClock() public {
        address inbox = _inbox();
        _hold(inbox, CC);
        uint256 end = router.refundAt(inbox, address(cc));
        skip(3 days);
        bridge.setEmergency(true);
        vm.expectRevert("emergency");
        router.refund(PARTY, SEPOLIA, user, address(cc));
        assertEq(cc.balanceOf(inbox), CC);
        assertEq(cc.balanceOf(feeTo), 0);
        assertEq(router.refundAt(inbox, address(cc)), end);
        bridge.setEmergency(false);
        router.refund(PARTY, SEPOLIA, user, address(cc)); // retried
        assertEq(cc.balanceOf(inbox), 0);
    }

    function test_forwardAndRefundRace() public {
        address inbox = _inbox();
        _hold(inbox, CC);
        skip(3 days);
        router.forward(PARTY, SEPOLIA, user, address(cc)); // lands first and empties the inbox, clearing the clock
        vm.expectRevert(abi.encodeWithSelector(R.NotYet.selector, uint256(0)));
        router.refund(PARTY, SEPOLIA, user, address(cc));
        _hold(inbox, CC);
        skip(3 days);
        router.refund(PARTY, SEPOLIA, user, address(cc)); // lands first the other way round
        vm.expectRevert(R.NothingHeld.selector);
        router.forward(PARTY, SEPOLIA, user, address(cc));
    }

    function test_refundOfATokenThatIsNotListedPaysNoFee() public {
        address inbox = _inbox();
        Wrapped other = Wrapped(gw.register("Other", "OT"));
        gw.claim(keccak256("other"), address(other), 5e9);
        other.transfer(address(bridge), 5e9);
        _claimDirect(inbox, address(other), 5e9); // anyone may claim a transfer into an open inbox
        router.mark(PARTY, SEPOLIA, user, address(other));
        skip(3 days);
        router.refund(PARTY, SEPOLIA, user, address(other));
        assertEq(bridge.leaf(bridge.leafCount() - 1).amount, 5e9);
        assertEq(other.balanceOf(feeTo), 0);
        vm.expectRevert(abi.encodeWithSelector(CantonBook.RouteNotOpen.selector, address(other))); // but it cannot go to Canton
        router.forward(PARTY, SEPOLIA, user, address(other));
    }

    function test_refundWithNoInboxOrNoHeldCoin() public {
        vm.expectRevert(R.InboxNotOpen.selector);
        router.refund("bob::1220", SEPOLIA, user, address(cc));
        _inbox();
        vm.expectRevert(abi.encodeWithSelector(R.NotYet.selector, uint256(0)));
        router.refund(PARTY, SEPOLIA, user, address(cc));
    }

    function test_refundWithAZeroWaitIsImmediate() public {
        vm.prank(owner);
        bookAs.setRefundWait(0);
        address inbox = _inbox();
        _hold(inbox, CC);
        router.refund(PARTY, SEPOLIA, user, address(cc));
        assertEq(cc.balanceOf(inbox), 0);
    }

    // A coin sent back, then the same round trip: nothing is lost on any path of this file.
    function test_everyUnitIsInOnePlace() public {
        address inbox = _inbox();
        _hold(inbox, CC);
        skip(3 days);
        router.refund(PARTY, SEPOLIA, user, address(cc));
        assertEq(cc.totalSupply(), cc.balanceOf(address(bridge)) + cc.balanceOf(feeTo) + cc.balanceOf(inbox));
        assertEq(cc.balanceOf(ROUTER), 0);
    }
}
