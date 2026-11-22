// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Gateway, Wrapped} from "gateway/Gateway.sol";
import {CantonBook} from "../src/CantonBook.sol";
import {CantonRouter} from "../src/CantonRouter.sol";
import {IBook, ClaimArgs, RouteState, Asset} from "../src/Interfaces.sol";

interface IProxyAdmin {
    function owner() external view returns (address);
    function getProxyAdmin(address proxy) external view returns (address);
    function getProxyImplementation(address proxy) external view returns (address);
    function upgrade(address proxy, address implementation) external;
    function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}

// The part of Ostia's bridge that the router meets, for a token born on Ostia: bridgeAsset locks it, claimAsset releases it.
contract MockBridge {
    uint32 public networkID = 75;
    uint256 public depositCount;
    bool public emergency;
    struct Leaf { uint32 destNetwork; address destAddress; uint256 amount; address token; address from; }
    Leaf[] internal _leaves;
    mapping(uint256 => bool) public claimed;

    function setEmergency(bool on) external { emergency = on; }
    function leafCount() external view returns (uint256) { return _leaves.length; }
    function leaf(uint256 i) external view returns (Leaf memory) { return _leaves[i]; }

    function bridgeAsset(uint32 destNetwork, address destAddress, uint256 amount, address token, bool force, bytes calldata) external payable {
        require(!emergency, "emergency");
        require(force, "force");
        require(Wrapped(token).transferFrom(msg.sender, address(this), amount), "lock");
        _leaves.push(Leaf(destNetwork, destAddress, amount, token, msg.sender));
        depositCount++;
    }

    function claimAsset(bytes32[32] calldata, bytes32[32] calldata, uint256 globalIndex, bytes32, bytes32, uint32 originNetwork, address originToken,
        uint32 destNetwork, address destAddress, uint256 amount, bytes calldata) external {
        require(!emergency, "emergency");
        require(!claimed[globalIndex], "claimed");
        require(destNetwork == networkID, "network");
        claimed[globalIndex] = true;
        if (originNetwork == networkID) require(Wrapped(originToken).transfer(destAddress, amount), "release");
    }
}

abstract contract Base is Test {
    address internal constant ROUTER = 0x000000000000000000000000000000000C0a7001;
    uint256 internal constant CC = 1e10;
    uint32 internal constant SEPOLIA = 0;
    uint32 internal constant HADRIAN = 74;
    uint32 internal constant OSTIA = 75;
    bytes32 internal constant INSTRUMENT = keccak256("dso::cc");
    string internal constant PARTY = "alice::1220ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12";

    Gateway internal gw;
    MockBridge internal bridge;
    address internal admin; // the ProxyAdmin
    address internal bookImpl;
    address internal routerImpl;
    IBook internal book;
    CantonBook internal bookAs;
    CantonRouter internal router;
    Wrapped internal cc;
    uint256 internal lockNonce;

    address internal owner = makeAddr("owner");
    address internal refuser = makeAddr("refuser");
    address internal feeTo = makeAddr("feeTo");
    address internal user = makeAddr("user");

    function setUp() public virtual {
        gw = new Gateway();
        bridge = new MockBridge();
        cc = Wrapped(gw.register("Canton Coin", "CC"));
        admin = deployCode("artifacts/ProxyAdmin.json");
        (bool ok,) = admin.call(abi.encodeWithSignature("transferOwnership(address)", owner));
        require(ok);
        bookImpl = address(new CantonBook());
        routerImpl = address(new CantonRouter());
        address bookProxy = deployCode("artifacts/TransparentUpgradeableProxy.json", abi.encode(bookImpl, admin,
            abi.encodeCall(CantonBook.initialize, (owner, refuser, feeTo, 3 days, OSTIA))));
        deployCodeTo("artifacts/TransparentUpgradeableProxy.json", abi.encode(routerImpl, admin,
            abi.encodeCall(CantonRouter.initialize, (bookProxy, address(gw), address(bridge)))), ROUTER);
        book = IBook(bookProxy);
        bookAs = CantonBook(bookProxy);
        router = CantonRouter(ROUTER);
        vm.startPrank(owner);
        bookAs.setDestination(SEPOLIA, true, 1);
        bookAs.setDestination(HADRIAN, true, 10);
        bookAs.list(address(cc), INSTRUMENT, 1e8, 2e8, 3e8, 1e9, 10 * CC); // fees 0.01, 0.02, 0.03 CC; minimum 0.1 CC; cap 10 CC
        bookAs.setClaimFee(address(cc), SEPOLIA, 5e7);
        vm.stopPrank();
    }

    function _open() internal {
        vm.startPrank(owner);
        bookAs.setOut(true);
        bookAs.setIn(true);
        vm.stopPrank();
    }

    // Puts `amount` of CC into the bridge, as an earlier send would have.
    function _lock(uint256 amount) internal {
        bytes32 id = keccak256(abi.encode("lock", ++lockNonce));
        gw.claim(id, address(cc), amount);
        cc.transfer(address(bridge), amount);
    }

    function _out(uint256 amount, uint32 net, address dest, uint256 maxFee, uint64 nonce) internal {
        router.claimAndBridge(PARTY, address(cc), amount, net, dest, maxFee, nonce);
    }

    function _args(address inbox, uint256 amount, uint256 index) internal pure returns (ClaimArgs memory c) {
        c.globalIndex = index;
        c.originNetwork = OSTIA;
        c.originTokenAddress = address(0);
        c.destinationNetwork = OSTIA;
        c.destinationAddress = inbox;
        c.amount = amount;
    }

    function _claim(address inbox, uint256 amount, uint256 index) internal view returns (ClaimArgs memory c) {
        c = _args(inbox, amount, index);
        c.originTokenAddress = address(cc);
    }

    function _inbox() internal returns (address) {
        return router.openInbox(PARTY, SEPOLIA, user);
    }

    // A transfer for the inbox, as the bridge holds it: CC in the bridge, claimable.
    function _arrive(uint256 amount) internal {
        _lock(amount);
    }
}
