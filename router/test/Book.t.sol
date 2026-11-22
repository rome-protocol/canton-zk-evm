// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Base} from "./Base.sol";
import {CantonBook} from "../src/CantonBook.sol";
import {Initializable} from "../src/vendor/Initializable.sol";
import {Asset, Destination, RouteState} from "../src/Interfaces.sol";

contract BookTest is Base {
    function test_deployedWithEverySwitchOff() public view {
        assertFalse(bookAs.outOpen());
        assertFalse(bookAs.inOpen());
        assertEq(bookAs.owner(), owner);
        assertEq(bookAs.refuser(), refuser);
        assertEq(bookAs.feeRecipient(), feeTo);
        assertEq(bookAs.refundWait(), 3 days);
        assertEq(bookAs.localNetwork(), OSTIA);
    }

    function test_listedAsset() public view {
        Asset memory a = bookAs.assets(address(cc));
        assertEq(uint8(a.state), uint8(RouteState.Open));
        assertEq(a.instrument, INSTRUMENT);
        assertEq(a.feeOut, 1e8);
        assertEq(a.feeIn, 2e8);
        assertEq(a.feeRefund, 3e8);
        assertEq(a.minAmount, 1e9);
        assertEq(a.lockCap, 10 * CC);
        assertEq(bookAs.canonical(INSTRUMENT), address(cc));
        assertEq(bookAs.claimFee(address(cc), SEPOLIA), 5e7);
        assertEq(bookAs.claimFee(address(cc), HADRIAN), 0);
        assertEq(bookAs.unitOf(SEPOLIA), 1);
        assertEq(bookAs.unitOf(HADRIAN), 10);
        assertEq(bookAs.unitOf(99), 0);
    }

    function test_onlyOwnerSetsAnything() public {
        bytes[9] memory calls = [
            abi.encodeCall(CantonBook.list, (address(1), bytes32(uint256(1)), 0, 0, 0, 0, 0)),
            abi.encodeCall(CantonBook.setFees, (address(cc), 0, 0, 0)),
            abi.encodeCall(CantonBook.setLimits, (address(cc), 0, 0)),
            abi.encodeCall(CantonBook.setClaimFee, (address(cc), 0, 0)),
            abi.encodeCall(CantonBook.setDestination, (5, true, 1)),
            abi.encodeCall(CantonBook.setRefundWait, (1)),
            abi.encodeCall(CantonBook.setFeeRecipient, (address(1))),
            abi.encodeCall(CantonBook.setRefuser, (address(1))),
            abi.encodeCall(CantonBook.setRoute, (address(cc), RouteState.Open))
        ];
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(user);
            (bool ok, bytes memory ret) = address(book).call(calls[i]);
            assertFalse(ok);
            assertEq(bytes4(ret), i == 8 ? CantonBook.NotAllowed.selector : CantonBook.NotOwner.selector);
            vm.prank(refuser); // the refuser has no setting either, and cannot open
            (ok,) = address(book).call(calls[i]);
            assertFalse(ok);
        }
    }

    function test_listRules() public {
        vm.startPrank(owner);
        address other = gw.register("Other", "OT");
        vm.expectRevert(CantonBook.AlreadyListed.selector); // the token is listed
        bookAs.list(address(cc), bytes32(uint256(7)), 0, 0, 0, 0, 0);
        vm.expectRevert(CantonBook.AlreadyListed.selector); // one token for each instrument
        bookAs.list(other, INSTRUMENT, 0, 0, 0, 0, 0);
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.list(address(0), bytes32(uint256(7)), 0, 0, 0, 0, 0);
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.list(other, bytes32(0), 0, 0, 0, 0, 0);
        bookAs.list(other, bytes32(uint256(7)), 0, 0, 0, 0, 0);
        assertEq(bookAs.canonical(bytes32(uint256(7))), other);
        vm.expectRevert(CantonBook.BadArgument.selector); // a setting for a token that is not listed
        bookAs.setFees(address(1), 0, 0, 0);
        vm.stopPrank();
    }

    function test_refuserCanOnlyStop() public {
        vm.startPrank(refuser);
        bookAs.setRoute(address(cc), RouteState.Stopped);
        assertEq(uint8(bookAs.assets(address(cc)).state), uint8(RouteState.Stopped));
        vm.expectRevert(CantonBook.NotAllowed.selector);
        bookAs.setRoute(address(cc), RouteState.Open);
        vm.expectRevert(CantonBook.NotAllowed.selector);
        bookAs.setOut(true);
        vm.expectRevert(CantonBook.NotAllowed.selector);
        bookAs.setIn(true);
        bookAs.stopDestination(SEPOLIA);
        assertFalse(bookAs.destinations(SEPOLIA).open);
        vm.stopPrank();
        _open();
        vm.startPrank(refuser);
        bookAs.setOut(false);
        bookAs.setIn(false);
        assertFalse(bookAs.outOpen());
        assertFalse(bookAs.inOpen());
        vm.stopPrank();
        vm.prank(owner); // only the owner opens again
        bookAs.setRoute(address(cc), RouteState.Open);
        assertEq(uint8(bookAs.assets(address(cc)).state), uint8(RouteState.Open));
    }

    function test_setRouteRefusesNoneAndUnlisted() public {
        vm.startPrank(owner);
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.setRoute(address(cc), RouteState.None);
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.setRoute(address(1), RouteState.Open);
        vm.stopPrank();
    }

    function test_destinationUnitIsSetOnceAndNeverCleared() public {
        vm.startPrank(owner);
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.setDestination(OSTIA, true, 1); // never Ostia itself
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.setDestination(5, true, 0); // a known network has a unit
        bookAs.setDestination(5, true, 10);
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.setDestination(5, true, 1); // the unit cannot change
        bookAs.setDestination(5, false, 10); // the switch can
        assertEq(bookAs.unitOf(5), 10);
        assertFalse(bookAs.destinations(5).open);
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.stopDestination(6); // a network that is not known
        vm.stopPrank();
    }

    function test_checkOutRefusals() public {
        vm.expectRevert(CantonBook.OutClosed.selector);
        book.checkOut(address(cc), SEPOLIA);
        _open();
        (Asset memory a, uint256 unit, uint256 claimPart) = book.checkOut(address(cc), SEPOLIA);
        assertEq(a.feeOut, 1e8);
        assertEq(unit, 1);
        assertEq(claimPart, 5e7);
        (, unit, claimPart) = book.checkOut(address(cc), HADRIAN);
        assertEq(unit, 10);
        assertEq(claimPart, 0);
        vm.expectRevert(abi.encodeWithSelector(CantonBook.DestinationNotOpen.selector, uint32(99)));
        book.checkOut(address(cc), 99);
        vm.prank(refuser);
        bookAs.stopDestination(SEPOLIA);
        vm.expectRevert(abi.encodeWithSelector(CantonBook.DestinationNotOpen.selector, SEPOLIA));
        book.checkOut(address(cc), SEPOLIA);
        vm.prank(refuser);
        bookAs.setRoute(address(cc), RouteState.Stopped);
        vm.expectRevert(abi.encodeWithSelector(CantonBook.RouteNotOpen.selector, address(cc)));
        book.checkOut(address(cc), HADRIAN);
        vm.expectRevert(abi.encodeWithSelector(CantonBook.RouteNotOpen.selector, address(1)));
        book.checkOut(address(1), HADRIAN);
    }

    function test_checkInRefusals() public {
        vm.expectRevert(CantonBook.InClosed.selector);
        book.checkIn(address(cc));
        _open();
        assertEq(book.checkIn(address(cc)).feeIn, 2e8);
        vm.prank(refuser);
        bookAs.setRoute(address(cc), RouteState.Stopped);
        vm.expectRevert(abi.encodeWithSelector(CantonBook.RouteNotOpen.selector, address(cc)));
        book.checkIn(address(cc));
    }

    function test_settingsTakeEffect() public {
        vm.startPrank(owner);
        bookAs.setFees(address(cc), 11, 22, 33);
        bookAs.setLimits(address(cc), 44, 55);
        bookAs.setClaimFee(address(cc), HADRIAN, 66);
        bookAs.setRefundWait(1 days);
        bookAs.setFeeRecipient(user);
        bookAs.setRefuser(user);
        vm.stopPrank();
        Asset memory a = bookAs.assets(address(cc));
        assertEq(a.feeOut, 11);
        assertEq(a.feeIn, 22);
        assertEq(a.feeRefund, 33);
        assertEq(a.minAmount, 44);
        assertEq(a.lockCap, 55);
        assertEq(bookAs.claimFee(address(cc), HADRIAN), 66);
        assertEq(bookAs.refundWait(), 1 days);
        assertEq(bookAs.feeRecipient(), user);
        assertEq(bookAs.refuser(), user);
        vm.prank(owner);
        vm.expectRevert(CantonBook.BadArgument.selector);
        bookAs.setFeeRecipient(address(0));
    }

    function test_initializersAreLocked() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector); // the proxy, already initialised
        bookAs.initialize(user, user, user, 1, 1);
        vm.expectRevert(Initializable.InvalidInitialization.selector); // the implementation
        CantonBook(bookImpl).initialize(user, user, user, 1, 1);
    }

    function test_initializeRefusesZero() public {
        CantonBook fresh = new CantonBook();
        bytes memory bad = abi.encodeCall(CantonBook.initialize, (address(0), refuser, feeTo, 1, OSTIA));
        vm.expectRevert(); // the proxy constructor passes the revert up
        deployCode("artifacts/TransparentUpgradeableProxy.json", abi.encode(address(fresh), admin, bad));
    }
}
