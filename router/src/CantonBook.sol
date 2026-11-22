// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Initializable} from "./vendor/Initializable.sol";
import {IBook, Asset, Destination, RouteState} from "./Interfaces.sol";

// What may move: which wrapped token is the one form of each Canton instrument, which routes and destinations are open, the
// fees, the minimums and the lock caps. Behind a proxy; all state is in one namespaced struct, fields only ever appended.
// Switches are deployed off. The owner is a timelock. The refuser can only stop.
contract CantonBook is Initializable, IBook {
    /// @custom:storage-location erc7201:rome.canton.book.v1
    struct Layout {
        mapping(address token => Asset) assets;
        mapping(bytes32 instrument => address token) canonical;
        mapping(uint32 network => Destination) destinations;
        mapping(address token => mapping(uint32 network => uint256)) claimFee;
        bool outOpen;
        bool inOpen;
        uint256 refundWait;
        address feeRecipient;
        address owner;
        address refuser;
        uint32 localNetwork;
    }

    // keccak256(abi.encode(uint256(keccak256("rome.canton.book.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xe8b3961496db754c2eed7688e419263cf71ff6a6dc01f9a076481a34f5b16300;

    error NotOwner();
    error NotAllowed();
    error BadArgument();
    error AlreadyListed();
    error OutClosed();
    error InClosed();
    error RouteNotOpen(address token);
    error DestinationNotOpen(uint32 network);

    event Listed(address indexed token, bytes32 indexed instrument);
    event RouteChanged(address indexed token, RouteState state);
    event DestinationChanged(uint32 indexed network, bool open, uint256 unit);
    event SwitchChanged(bool indexed out, bool open);
    event Updated(bytes32 indexed what);

    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address refuser_, address feeRecipient_, uint256 refundWait_, uint32 localNetwork_) external initializer {
        if (owner_ == address(0) || feeRecipient_ == address(0)) revert BadArgument();
        Layout storage s = _s();
        s.owner = owner_;
        s.refuser = refuser_;
        s.feeRecipient = feeRecipient_;
        s.refundWait = refundWait_;
        s.localNetwork = localNetwork_;
    }

    function _s() internal pure returns (Layout storage s) {
        bytes32 slot = SLOT;
        assembly { s.slot := slot }
    }

    modifier onlyOwner() {
        if (msg.sender != _s().owner) revert NotOwner();
        _;
    }

    // The owner may do anything; the refuser only a stop.
    modifier ownerOrStop(bool stopping) {
        Layout storage s = _s();
        if (msg.sender != s.owner && !(stopping && msg.sender == s.refuser)) revert NotAllowed();
        _;
    }

    function assets(address token) external view returns (Asset memory) { return _s().assets[token]; }
    function canonical(bytes32 instrument) external view returns (address) { return _s().canonical[instrument]; }
    function destinations(uint32 network) external view returns (Destination memory) { return _s().destinations[network]; }
    function claimFee(address token, uint32 network) external view returns (uint256) { return _s().claimFee[token][network]; }
    function outOpen() external view returns (bool) { return _s().outOpen; }
    function inOpen() external view returns (bool) { return _s().inOpen; }
    function refundWait() external view returns (uint256) { return _s().refundWait; }
    function feeRecipient() external view returns (address) { return _s().feeRecipient; }
    function owner() external view returns (address) { return _s().owner; }
    function refuser() external view returns (address) { return _s().refuser; }
    function localNetwork() external view returns (uint32) { return _s().localNetwork; }
    function unitOf(uint32 network) external view returns (uint256) { return _s().destinations[network].unit; }

    // Flow A: the direction is open, the route is Open, the destination is known and open. claimPart is the claim fee on that network.
    function checkOut(address token, uint32 network) external view returns (Asset memory a, uint256 unit, uint256 claimPart) {
        Layout storage s = _s();
        if (!s.outOpen) revert OutClosed();
        a = s.assets[token];
        if (a.state != RouteState.Open) revert RouteNotOpen(token);
        Destination memory d = s.destinations[network];
        if (!d.open || d.unit == 0) revert DestinationNotOpen(network);
        return (a, d.unit, s.claimFee[token][network]);
    }

    // Flow C: the direction is open and the route is Open.
    function checkIn(address token) external view returns (Asset memory a) {
        Layout storage s = _s();
        if (!s.inOpen) revert InClosed();
        a = s.assets[token];
        if (a.state != RouteState.Open) revert RouteNotOpen(token);
    }

    // One token for each instrument, listed once. It starts Open (the direction's switch is still off).
    function list(address token, bytes32 instrument, uint256 feeOut, uint256 feeIn, uint256 feeRefund, uint256 minAmount, uint256 lockCap) external onlyOwner {
        Layout storage s = _s();
        if (token == address(0) || instrument == bytes32(0)) revert BadArgument();
        if (s.assets[token].state != RouteState.None || s.canonical[instrument] != address(0)) revert AlreadyListed();
        s.assets[token] = Asset(RouteState.Open, instrument, feeOut, feeIn, feeRefund, minAmount, lockCap);
        s.canonical[instrument] = token;
        emit Listed(token, instrument);
    }

    function setRoute(address token, RouteState state) external ownerOrStop(state == RouteState.Stopped) {
        Layout storage s = _s();
        if (state == RouteState.None || s.assets[token].state == RouteState.None) revert BadArgument();
        s.assets[token].state = state;
        emit RouteChanged(token, state);
    }

    function setFees(address token, uint256 feeOut, uint256 feeIn, uint256 feeRefund) external onlyOwner {
        Asset storage a = _listed(token);
        (a.feeOut, a.feeIn, a.feeRefund) = (feeOut, feeIn, feeRefund);
        emit Updated("fees");
    }

    function setLimits(address token, uint256 minAmount, uint256 lockCap) external onlyOwner {
        Asset storage a = _listed(token);
        (a.minAmount, a.lockCap) = (minAmount, lockCap);
        emit Updated("limits");
    }

    function setClaimFee(address token, uint32 network, uint256 fee) external onlyOwner {
        _listed(token);
        _s().claimFee[token][network] = fee;
        emit Updated("claimFee");
    }

    // A known network keeps its unit for good, so an inbox that names it can always be refunded. Never Ostia itself.
    function setDestination(uint32 network, bool open, uint256 unit) external onlyOwner {
        Layout storage s = _s();
        uint256 known = s.destinations[network].unit;
        if (network == s.localNetwork || unit == 0 || (known != 0 && known != unit)) revert BadArgument();
        s.destinations[network] = Destination(open, unit);
        emit DestinationChanged(network, open, unit);
    }

    function stopDestination(uint32 network) external ownerOrStop(true) {
        Layout storage s = _s();
        if (s.destinations[network].unit == 0) revert BadArgument();
        s.destinations[network].open = false;
        emit DestinationChanged(network, false, s.destinations[network].unit);
    }

    function setOut(bool open) external ownerOrStop(!open) {
        _s().outOpen = open;
        emit SwitchChanged(true, open);
    }

    function setIn(bool open) external ownerOrStop(!open) {
        _s().inOpen = open;
        emit SwitchChanged(false, open);
    }

    // A clock that is already running keeps its end: the router stores each end when the clock starts.
    function setRefundWait(uint256 wait) external onlyOwner {
        _s().refundWait = wait;
        emit Updated("refundWait");
    }

    function setFeeRecipient(address to) external onlyOwner {
        if (to == address(0)) revert BadArgument();
        _s().feeRecipient = to;
        emit Updated("feeRecipient");
    }

    function setRefuser(address to) external onlyOwner {
        _s().refuser = to;
        emit Updated("refuser");
    }

    function _listed(address token) internal view returns (Asset storage a) {
        a = _s().assets[token];
        if (a.state == RouteState.None) revert BadArgument();
    }
}
