// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Base, IProxyAdmin, MockBridge} from "./Base.sol";
import {CantonRouterV2, CantonBookV2} from "./V2.sol";
import {CantonBook} from "../src/CantonBook.sol";
import {CantonRouter} from "../src/CantonRouter.sol";
import {Initializable} from "../src/vendor/Initializable.sol";
import {Asset} from "../src/Interfaces.sol";

// The proxies, the inbox's fixed bytes, and what an upgrade may not change (design section 3.7).
contract UpgradeTest is Base {
    address internal dest = makeAddr("dest");
    string internal constant BOB = "bob::1220";

    function _json() internal view returns (string memory) {
        return vm.readFile("test/vectors/r1.json");
    }

    function _held(address inbox, uint32 net, string memory party, uint256 amount) internal {
        _lock(amount);
        router.claimToInbox(_claim(inbox, amount, ++lockNonce + 1000), party, net, user);
    }

    // ---- The deploy read-backs

    function test_deployReadBacks() public view {
        IProxyAdmin pa = IProxyAdmin(admin);
        assertEq(pa.owner(), owner); // the timelock owns the ProxyAdmin
        assertEq(pa.getProxyAdmin(address(book)), admin);
        assertEq(pa.getProxyAdmin(ROUTER), admin);
        assertEq(pa.getProxyImplementation(address(book)), bookImpl);
        assertEq(pa.getProxyImplementation(ROUTER), routerImpl);
        assertEq(bookAs.owner(), owner);
        assertEq(router.book(), address(book));
        assertEq(router.gateway(), address(gw));
        assertEq(router.bridge(), address(bridge));
        assertFalse(bookAs.outOpen()); // every switch is off
        assertFalse(bookAs.inOpen());
    }

    function test_initializeRevertsOnEveryProxyAndImplementation() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        router.initialize(address(1), address(1), address(1));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        CantonRouter(routerImpl).initialize(address(1), address(1), address(1));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bookAs.initialize(user, user, user, 1, 1);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        CantonBook(bookImpl).initialize(user, user, user, 1, 1);
    }

    function test_routerInitializeRefusesZero() public {
        vm.expectRevert();
        deployCode("artifacts/TransparentUpgradeableProxy.json", abi.encode(routerImpl, admin,
            abi.encodeCall(CantonRouter.initialize, (address(0), address(gw), address(bridge)))));
    }

    function test_onlyTheTimelockUpgrades() public {
        address v2 = address(new CantonRouterV2());
        vm.prank(user);
        vm.expectRevert("Ownable: caller is not the owner");
        IProxyAdmin(admin).upgrade(ROUTER, v2);
        vm.prank(refuser);
        vm.expectRevert("Ownable: caller is not the owner");
        IProxyAdmin(admin).upgrade(address(book), v2);
    }

    // ---- The inbox's fixed bytes

    function test_inboxBytesAreTheCheckedInArtifactAndThePinnedHash() public view {
        bytes memory art = vm.parseBytes(string.concat("0x", vm.readFile("artifacts/CantonInbox.creation.hex")));
        bytes32 pinned = vm.parseJsonBytes32(_json(), ".inboxCodeHash");
        assertEq(keccak256(art), pinned);
        assertEq(router.inboxCodeHash(), pinned); // written at initialize from the bytes the router embeds
        assertEq(CantonRouter(routerImpl).inboxCodeHash(), bytes32(0)); // the implementation keeps no state of its own
    }

    function test_theRouterIsAtTheVectorsAddress() public view {
        assertEq(vm.parseJsonAddress(_json(), ".routerProxy"), ROUTER);
    }

    function _inboxVector(uint256 i, string memory field) internal view returns (string memory) {
        return vm.parseJsonString(_json(), string.concat(".inboxes[", vm.toString(i), "].", field));
    }

    function _labelVector(uint256 i, string memory field) internal view returns (string memory) {
        return vm.parseJsonString(_json(), string.concat(".labels[", vm.toString(i), "].", field));
    }

    // Every label vector (text, deposit id, parse): the same for every implementation.
    function _checkLabelVectors() internal view {
        for (uint256 i = 0; i < 4; i++) {
            uint32 net = uint32(vm.parseUint(_labelVector(i, "net")));
            address to = vm.parseAddress(_labelVector(i, "dest"));
            uint256 maxFee = vm.parseUint(_labelVector(i, "maxFee"));
            uint64 nonce = uint64(vm.parseUint(_labelVector(i, "nonce")));
            string memory label = router.routeLabel(net, to, maxFee, nonce);
            assertEq(label, _labelVector(i, "label"));
            assertEq(router.depositId(_labelVector(i, "party"), label), vm.parseBytes32(_labelVector(i, "id")));
            (bool ok, uint32 n2, address d2, uint256 f2, uint64 q2) = router.parseLabel(label);
            assertTrue(ok);
            assertEq(n2, net);
            assertEq(d2, to);
            assertEq(f2, maxFee);
            assertEq(q2, nonce);
        }
    }

    // A fixed set of (party, network, address) to their inbox addresses: the same for every implementation.
    function test_inboxAddressesAreFixed() public view {
        for (uint256 i = 0; i < 4; i++) {
            address got = router.inboxOf(_inboxVector(i, "party"), uint32(vm.parseUint(_inboxVector(i, "refundNetwork"))), vm.parseAddress(_inboxVector(i, "refundAddress")));
            assertEq(got, vm.parseAddress(_inboxVector(i, "inbox")));
        }
    }

    // openInbox deploys exactly the checked-in bytes: the address commits to them, so a deployed inbox at the vector's address proves it.
    function test_openInboxDeploysTheCheckedInBytes() public {
        _open();
        vm.prank(owner);
        bookAs.setDestination(1, true, 1);
        for (uint256 i = 0; i < 4; i++) {
            address want = vm.parseAddress(_inboxVector(i, "inbox"));
            assertEq(want.code.length, 0);
            address made = router.openInbox(_inboxVector(i, "party"), uint32(vm.parseUint(_inboxVector(i, "refundNetwork"))), vm.parseAddress(_inboxVector(i, "refundAddress")));
            assertEq(made, want);
            assertTrue(want.code.length > 0);
        }
    }

    // If the embedded bytes ever differed from the stored hash, openInbox would fail closed instead of making a new address.
    function test_openInboxFailsClosedWhenTheBytesChanged() public {
        _open();
        bytes32 routerSlot = keccak256(abi.encode(uint256(keccak256("rome.canton.router.v1")) - 1)) & ~bytes32(uint256(0xff));
        vm.store(ROUTER, bytes32(uint256(routerSlot) + 3), bytes32(uint256(1)));
        vm.expectRevert(CantonRouter.InboxCodeChanged.selector);
        router.openInbox(PARTY, SEPOLIA, user);
    }

    // ---- The upgrade test

    function test_upgradeKeepsCoinsInboxesLabelsClocksAndTheCap() public {
        _open();
        // Version 1 at work: an open inbox holding a coin with a running clock, another with its own clock, and a deposit waiting on Canton.
        address a = router.openInbox(PARTY, SEPOLIA, user);
        address b = router.openInbox(BOB, HADRIAN, user);
        _held(a, SEPOLIA, PARTY, CC);
        skip(1 hours);
        _held(b, HADRIAN, BOB, 2 * CC + 7);
        uint256 endA = router.refundAt(a, address(cc));
        uint256 endB = router.refundAt(b, address(cc));
        assertTrue(endA != 0 && endB > endA);
        string memory label = router.routeLabel(SEPOLIA, dest, 15e7, 5);
        bytes32 waiting = router.depositId(PARTY, label); // on the ledger, not yet relayed
        assertFalse(gw.used(waiting));
        Asset memory before = bookAs.assets(address(cc));
        uint256 roomBefore = router.lockRoom(address(cc));
        bytes32 hashBefore = router.inboxCodeHash();

        // The timelock upgrades both proxies to version 2: the router with a reinitializer, the book without.
        address routerV2 = address(new CantonRouterV2());
        address bookV2 = address(new CantonBookV2());
        vm.startPrank(owner);
        IProxyAdmin(admin).upgradeAndCall(ROUTER, routerV2, abi.encodeCall(CantonRouterV2.initializeV2, (CC)));
        IProxyAdmin(admin).upgrade(address(book), bookV2);
        vm.stopPrank();
        assertEq(IProxyAdmin(admin).getProxyImplementation(ROUTER), routerV2);
        assertEq(IProxyAdmin(admin).getProxyImplementation(address(book)), bookV2);
        assertEq(CantonRouterV2(ROUTER).version(), 2);
        assertEq(CantonBookV2(address(book)).version(), 2);
        assertEq(CantonRouterV2(ROUTER).reserve(), CC); // the appended field reads back after the reinitializer
        assertEq(CantonBookV2(address(book)).minFeeOut(), 0); // the appended field of the book starts empty

        // Nothing moved: inbox addresses, clocks, held coin, the router's zero, the book's settings, the stored hash, the label.
        assertEq(router.inboxOf(PARTY, SEPOLIA, user), a);
        assertEq(router.inboxOf(BOB, HADRIAN, user), b);
        assertEq(router.refundAt(a, address(cc)), endA);
        assertEq(router.refundAt(b, address(cc)), endB);
        assertEq(cc.balanceOf(a), CC);
        assertEq(cc.balanceOf(b), 2 * CC + 7);
        assertEq(cc.balanceOf(ROUTER), 0);
        Asset memory afterUp = bookAs.assets(address(cc));
        assertEq(afterUp.feeOut, before.feeOut);
        assertEq(afterUp.lockCap, before.lockCap);
        assertEq(afterUp.instrument, before.instrument);
        assertEq(bookAs.owner(), owner);
        assertEq(bookAs.refundWait(), 3 days);
        assertEq(router.inboxCodeHash(), hashBefore);
        assertEq(router.depositId(PARTY, router.routeLabel(SEPOLIA, dest, 15e7, 5)), waiting);
        assertEq(router.routeLabel(SEPOLIA, dest, 15e7, 5), label);
        _checkLabelVectors();
        for (uint256 i = 0; i < 4; i++) {
            assertEq(router.inboxOf(_inboxVector(i, "party"), uint32(vm.parseUint(_inboxVector(i, "refundNetwork"))), vm.parseAddress(_inboxVector(i, "refundAddress"))),
                vm.parseAddress(_inboxVector(i, "inbox")));
        }
        // The new rule is in force: version 2 keeps 1 CC of the room back.
        assertEq(router.lockRoom(address(cc)), roomBefore - CC);

        // The coin held before the upgrade goes to Canton, and the other goes back at its old time to its old address.
        router.forward(PARTY, SEPOLIA, user, address(cc));
        assertEq(cc.balanceOf(a), 0);
        assertEq(gw.withdrawals(), 1);
        vm.warp(endB - 1);
        vm.expectRevert(abi.encodeWithSelector(CantonRouter.NotYet.selector, endB));
        router.refund(BOB, HADRIAN, user, address(cc));
        vm.warp(endB);
        router.refund(BOB, HADRIAN, user, address(cc));
        MockBridge.Leaf memory l = bridge.leaf(bridge.leafCount() - 1);
        assertEq(l.destNetwork, HADRIAN);
        assertEq(l.destAddress, user);
        assertEq(l.amount, 2 * CC - 3e8); // 2e10 + 7 - 3e8 = 1.97e10 + 7, in whole units of 10
        assertEq(l.from, b);

        // The deposit that waited is claimed and bridged under the same id.
        _out(CC, SEPOLIA, dest, 15e7, 5);
        assertTrue(gw.used(waiting));
        assertEq(cc.balanceOf(ROUTER), 0);
    }

    // The book's appended field is written and read at the end of the version 1 struct, and its new refusal works; nothing before it moved.
    function test_bookUpgradeAppendsAFieldAndAddsARefusal() public {
        Asset memory before = bookAs.assets(address(cc));
        vm.startPrank(owner);
        IProxyAdmin(admin).upgrade(address(book), address(new CantonBookV2()));
        CantonBookV2 b2 = CantonBookV2(address(book));
        assertEq(b2.outOpen(), false);
        assertEq(b2.refundWait(), 3 days);
        assertEq(b2.localNetwork(), 75);
        assertEq(b2.feeRecipient(), bookAs.feeRecipient());
        b2.setMinFeeOut(before.feeOut + 1);
        assertEq(b2.minFeeOut(), before.feeOut + 1);
        assertEq(b2.refundWait(), 3 days); // the neighbour of the new field is untouched
        assertEq(b2.localNetwork(), 75);
        vm.expectRevert(abi.encodeWithSelector(CantonBookV2.FeeBelowFloor.selector, before.feeOut, before.feeOut + 1));
        b2.setFees(address(cc), before.feeOut, before.feeIn, before.feeRefund);
        b2.setFees(address(cc), before.feeOut + 1, before.feeIn, before.feeRefund);
        vm.stopPrank();
        assertEq(bookAs.assets(address(cc)).feeOut, before.feeOut + 1);
        assertEq(bookAs.assets(address(cc)).instrument, before.instrument);
    }

    function test_theCapStaysAfterAnUpgrade() public {
        _open();
        address routerV2 = address(new CantonRouterV2());
        vm.prank(owner);
        IProxyAdmin(admin).upgradeAndCall(ROUTER, routerV2, abi.encodeCall(CantonRouterV2.initializeV2, (0)));
        _lock(95e9);
        assertEq(router.lockRoom(address(cc)), 5e9);
        bytes32 id = router.depositId(PARTY, router.routeLabel(SEPOLIA, dest, 15e7, 1));
        vm.expectRevert(abi.encodeWithSelector(CantonRouter.OverLockCap.selector, CC - 15e7, 5e9));
        _out(CC, SEPOLIA, dest, 15e7, 1);
        assertFalse(gw.used(id));
    }

    function test_theUpgradedImplementationsAreLocked() public {
        CantonRouterV2 routerV2 = new CantonRouterV2();
        CantonBookV2 bookV2 = new CantonBookV2();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        routerV2.initialize(address(1), address(1), address(1));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        routerV2.initializeV2(1);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bookV2.initialize(user, user, user, 1, 1);
        vm.startPrank(owner);
        IProxyAdmin(admin).upgradeAndCall(ROUTER, address(routerV2), abi.encodeCall(CantonRouterV2.initializeV2, (3)));
        IProxyAdmin(admin).upgrade(address(book), address(bookV2));
        vm.stopPrank();
        assertEq(CantonRouterV2(ROUTER).reserve(), 3);
        vm.expectRevert(Initializable.InvalidInitialization.selector); // on the proxies too: version 1 is used and so is version 2
        router.initialize(address(1), address(1), address(1));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        CantonRouterV2(ROUTER).initializeV2(4);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        bookAs.initialize(user, user, user, 1, 1);
    }
}
