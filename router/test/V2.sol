// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Initializable} from "../src/vendor/Initializable.sol";
import {IBook, IGateway, IOstiaBridge, IToken, Asset, ClaimArgs, Destination, RouteState} from "../src/Interfaces.sol";
import {Labels} from "../src/Labels.sol";
import {InboxCode} from "../src/InboxCode.sol";

// Test versions 2 for the upgrade test (design section 3.7): each is a copy of its version 1 contract with one field appended at the end of
// the version 1 struct, its own initializer where it needs one, and changed logic. Marked "version 2" in the lines that differ.
// The copies are in step with src/ as of this commit; the upgrade test fails if a copy moves a version 1 field.

contract CantonRouterV2 is Initializable {
    /// @custom:storage-location erc7201:rome.canton.router.v1
    struct Layout {
        IBook book;
        IGateway gateway;
        IOstiaBridge bridge;
        bytes32 inboxCodeHash;
        mapping(address inbox => mapping(address token => uint256)) refundAt;
        uint256 reserve; // version 2: appended at the end of the version 1 struct
    }

    // keccak256(abi.encode(uint256(keccak256("rome.canton.router.v1")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xdb606f7749e64ed4d4b6a293d752c25e07a0655476e1e7853f3a60d213c4fa00;

    error BadArgument();
    error FeeAboveMax(uint256 fee, uint256 maxFee);
    error BelowMinimum(uint256 amount, uint256 minAmount);
    error NothingLeft();
    error OverLockCap(uint256 send, uint256 room);
    error WrongInbox();
    error InboxNotOpen();
    error NotListed(address token);
    error WrongOrigin();
    error NothingHeld();
    error NotYet(uint256 refundAt);
    error InboxCodeChanged();
    error InboxDeployFailed();
    error InClosed();
    error CallFailed();

    event RoutedOut(bytes32 indexed id, bytes32 indexed partyHash, address indexed destAddress, string party, uint32 destNetwork, address token, uint256 send, uint256 fee, uint256 depositCount);
    event InboxOpened(address indexed inbox, bytes32 indexed partyHash, address indexed refundAddress, string party, uint32 refundNetwork);
    event Held(address indexed inbox, address indexed token, uint256 balance, uint256 refundAt);
    event Forwarded(address indexed inbox, address indexed token, uint256 amount, uint256 fee);
    event Refunded(address indexed inbox, address indexed token, uint256 amount, uint256 fee, uint256 depositCount);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // The inbox's code hash is written here, once, from the embedded bytes. Nothing writes it again.
    function initialize(address book_, address gateway_, address bridge_) external initializer {
        if (book_ == address(0) || gateway_ == address(0) || bridge_ == address(0)) revert BadArgument();
        Layout storage s = _s();
        s.book = IBook(book_);
        s.gateway = IGateway(gateway_);
        s.bridge = IOstiaBridge(bridge_);
        s.inboxCodeHash = keccak256(InboxCode.CREATION);
    }

    function initializeV2(uint256 reserve_) external reinitializer(2) {
        _s().reserve = reserve_;
    }

    function version() external pure returns (uint256) { return 2; }

    function reserve() external view returns (uint256) { return _s().reserve; }

    function _s() internal pure returns (Layout storage s) {
        bytes32 slot = SLOT;
        assembly { s.slot := slot }
    }

    function book() external view returns (address) { return address(_s().book); }
    function gateway() external view returns (address) { return address(_s().gateway); }
    function bridge() external view returns (address) { return address(_s().bridge); }
    function inboxCodeHash() external view returns (bytes32) { return _s().inboxCodeHash; }
    function refundAt(address inbox, address token) external view returns (uint256) { return _s().refundAt[inbox][token]; }

    // ---- Labels

    function routeLabel(uint32 destNetwork, address destAddress, uint256 maxFee, uint64 nonce) public pure returns (string memory) {
        return Labels.route(destNetwork, destAddress, maxFee, nonce);
    }

    function depositId(string memory party, string memory label) public pure returns (bytes32) {
        return Labels.depositId(party, label);
    }

    function parseLabel(string memory label) external pure returns (bool ok, uint32 destNetwork, address destAddress, uint256 maxFee, uint64 nonce) {
        return Labels.parse(label);
    }

    // ---- Flow A: Canton to another chain

    // The Canton deposit names this router as recipient and routeLabel(...) as its label. Every check comes before the claim.
    function claimAndBridge(string calldata party, address token, uint256 amount, uint32 destNetwork, address destAddress, uint256 maxFee, uint64 nonce) external {
        if (destAddress == address(0)) revert BadArgument();
        Layout storage s = _s();
        (Asset memory a, uint256 unit, uint256 claimPart) = s.book.checkOut(token, destNetwork);
        uint256 fee0 = a.feeOut + claimPart;
        if (fee0 > maxFee) revert FeeAboveMax(fee0, maxFee);
        if (amount < a.minAmount) revert BelowMinimum(amount, a.minAmount);
        if (amount <= fee0) revert NothingLeft();
        uint256 send = (amount - fee0) / unit * unit;
        if (send == 0) revert NothingLeft();
        uint256 fee = amount - send; // what is really charged, with the cut-off leftover; never above the user's maxFee
        if (fee > maxFee) revert FeeAboveMax(fee, maxFee);
        uint256 room = lockRoom(token);
        if (send > room) revert OverLockCap(send, room);
        bytes32 id = Labels.depositId(party, Labels.route(destNetwork, destAddress, maxFee, nonce));
        s.gateway.claim(id, token, amount);
        if (fee > 0) _pay(token, s.book.feeRecipient(), fee);
        uint256 count = s.bridge.depositCount();
        IToken(token).approve(address(s.bridge), send);
        s.bridge.bridgeAsset(destNetwork, destAddress, send, token, true, "");
        emit RoutedOut(id, keccak256(bytes(party)), destAddress, party, destNetwork, token, send, fee, count);
    }

    // What flow A may still lock: the asset's cap minus what Ostia's bridge holds of it, 0 if none is left.
    function lockRoom(address token) public view virtual returns (uint256) {
        Layout storage s = _s();
        uint256 cap = s.book.assets(token).lockCap;
        uint256 held = IToken(token).balanceOf(address(s.bridge));
        uint256 room = cap > held ? cap - held : 0;
        return room > s.reserve ? room - s.reserve : 0; // version 2: part of the room is kept back
    }

    // ---- Flow C: back to Canton

    function inboxOf(string calldata party, uint32 refundNetwork, address refundAddress) public view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(party, refundNetwork, refundAddress), _s().inboxCodeHash));
        return address(uint160(uint256(h)));
    }

    function openInbox(string calldata party, uint32 refundNetwork, address refundAddress) external returns (address inbox) {
        Layout storage s = _s();
        if (!s.book.inOpen()) revert InClosed();
        if (refundNetwork == s.bridge.networkID() || s.book.unitOf(refundNetwork) == 0 || refundAddress == address(0) || bytes(party).length == 0) revert BadArgument();
        inbox = inboxOf(party, refundNetwork, refundAddress);
        if (inbox.code.length == 0) {
            bytes memory code = InboxCode.CREATION;
            if (keccak256(code) != s.inboxCodeHash) revert InboxCodeChanged();
            address made;
            bytes32 salt = _salt(party, refundNetwork, refundAddress);
            assembly { made := create2(0, add(code, 32), mload(code), salt) }
            if (made != inbox) revert InboxDeployFailed();
        }
        emit InboxOpened(inbox, keccak256(bytes(party)), refundAddress, party, refundNetwork);
    }

    // Claims the transfer into the inbox and pays it to the party in one call. Left out of the block if Canton cannot pay.
    function claimAndWithdraw(ClaimArgs calldata c, string calldata party, uint32 refundNetwork, address refundAddress) external {
        (address inbox, address token) = _claimInto(c, party, refundNetwork, refundAddress);
        _forward(inbox, party, token);
    }

    // Claim only, with no Canton leg, so it always lands. Starts the clock if it is not running.
    function claimToInbox(ClaimArgs calldata c, string calldata party, uint32 refundNetwork, address refundAddress) external {
        (address inbox, address token) = _claimInto(c, party, refundNetwork, refundAddress);
        _hold(inbox, token, IToken(token).balanceOf(inbox));
    }

    // Pays what the inbox holds to the party, less the fee. A balance at or below the fee goes whole to the fee recipient.
    function forward(string calldata party, uint32 refundNetwork, address refundAddress, address token) external {
        _forward(_open(party, refundNetwork, refundAddress), party, token);
    }

    // For a balance that someone else claimed into the inbox: starts the clock if it is not running.
    function mark(string calldata party, uint32 refundNetwork, address refundAddress, address token) external {
        address inbox = _open(party, refundNetwork, refundAddress);
        uint256 bal = IToken(token).balanceOf(inbox);
        if (bal > 0) _hold(inbox, token, bal);
    }

    // After the clock's end: sends the balance back to the refund address, less the fee, in whole units of that network.
    // It reads no switch, no route state and no destination switch: held coin can always go home. Only the bridge can stop it.
    function refund(string calldata party, uint32 refundNetwork, address refundAddress, address token) external {
        Layout storage s = _s();
        address inbox = _open(party, refundNetwork, refundAddress);
        uint256 at = s.refundAt[inbox][token];
        if (at == 0 || block.timestamp < at) revert NotYet(at);
        uint256 bal = IToken(token).balanceOf(inbox);
        if (bal == 0) revert NothingHeld();
        uint256 fee = s.book.assets(token).feeRefund + s.book.claimFee(token, refundNetwork);
        if (fee > bal) fee = bal;
        uint256 unit = s.book.unitOf(refundNetwork);
        uint256 back = (bal - fee) / unit * unit;
        fee = bal - back;
        delete s.refundAt[inbox][token];
        uint256 count = s.bridge.depositCount();
        if (fee > 0) _exec(inbox, token, abi.encodeCall(IToken.transfer, (s.book.feeRecipient(), fee)));
        if (back > 0) {
            _exec(inbox, token, abi.encodeCall(IToken.approve, (address(s.bridge), back)));
            _exec(inbox, address(s.bridge), abi.encodeCall(IOstiaBridge.bridgeAsset, (refundNetwork, refundAddress, back, token, true, "")));
        }
        emit Refunded(inbox, token, back, fee, count);
    }

    // ---- Internals

    function _salt(string calldata party, uint32 refundNetwork, address refundAddress) internal pure returns (bytes32) {
        return keccak256(abi.encode(party, refundNetwork, refundAddress));
    }

    function _open(string calldata party, uint32 refundNetwork, address refundAddress) internal view returns (address inbox) {
        inbox = inboxOf(party, refundNetwork, refundAddress);
        if (inbox.code.length == 0) revert InboxNotOpen();
    }

    // Checks that the transfer is for this open inbox, born on Ostia and listed, then claims it. The bridge releases the token to the inbox.
    function _claimInto(ClaimArgs calldata c, string calldata party, uint32 refundNetwork, address refundAddress) internal returns (address inbox, address asset) {
        Layout storage s = _s();
        inbox = _open(party, refundNetwork, refundAddress);
        asset = c.originTokenAddress;
        if (c.destinationAddress != inbox) revert WrongInbox();
        if (c.originNetwork != s.bridge.networkID()) revert WrongOrigin();
        if (s.book.assets(asset).state == RouteState.None) revert NotListed(asset);
        s.bridge.claimAsset(c.smtProofLocalExitRoot, c.smtProofRollupExitRoot, c.globalIndex, c.mainnetExitRoot, c.rollupExitRoot, c.originNetwork, asset, c.destinationNetwork, c.destinationAddress, c.amount, c.metadata);
    }

    function _forward(address inbox, string calldata party, address token) internal {
        Layout storage s = _s();
        Asset memory a = s.book.checkIn(token);
        uint256 bal = IToken(token).balanceOf(inbox);
        if (bal == 0) revert NothingHeld();
        uint256 fee = a.feeIn < bal ? a.feeIn : bal;
        uint256 rest = bal - fee;
        delete s.refundAt[inbox][token];
        if (fee > 0) _exec(inbox, token, abi.encodeCall(IToken.transfer, (s.book.feeRecipient(), fee)));
        if (rest > 0) _exec(inbox, address(s.gateway), abi.encodeCall(IGateway.withdraw, (token, rest, party)));
        emit Forwarded(inbox, token, rest, fee);
    }

    // One clock for each (inbox, token): it starts when a balance is first held and keeps the end it was given.
    function _hold(address inbox, address token, uint256 bal) internal {
        Layout storage s = _s();
        uint256 at = s.refundAt[inbox][token];
        if (at == 0) {
            at = block.timestamp + s.book.refundWait();
            s.refundAt[inbox][token] = at;
        }
        emit Held(inbox, token, bal, at);
    }

    // The router pays a fee from its own balance.
    function _pay(address token, address to, uint256 amount) internal {
        if (!IToken(token).transfer(to, amount)) revert CallFailed();
    }

    // An inbox call that must succeed; a token that answers with a bool must answer true.
    function _exec(address inbox, address target, bytes memory data) internal {
        (bool ok, bytes memory ret) = inbox.call(abi.encodeWithSignature("exec(address,bytes)", target, data));
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
        bytes memory inner = abi.decode(ret, (bytes));
        if (inner.length > 0 && !abi.decode(inner, (bool))) revert CallFailed();
    }
}

contract CantonBookV2 is Initializable, IBook {
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
        uint256 minFeeOut; // version 2: appended at the end of the version 1 struct
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
    error FeeBelowFloor(uint256 fee, uint256 floor); // version 2

    event Listed(address indexed token, bytes32 indexed instrument);
    event RouteChanged(address indexed token, RouteState state);
    event DestinationChanged(uint32 indexed network, bool open, uint256 unit);
    event SwitchChanged(bool indexed out, bool open);
    event Updated(bytes32 indexed what);

    /// @custom:oz-upgrades-unsafe-allow constructor
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

    function version() external pure returns (uint256) { return 2; }

    function minFeeOut() external view returns (uint256) { return _s().minFeeOut; }

    function setMinFeeOut(uint256 floor) external onlyOwner { _s().minFeeOut = floor; }

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
        if (feeOut < s.minFeeOut) revert FeeBelowFloor(feeOut, s.minFeeOut); // version 2
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
        if (feeOut < _s().minFeeOut) revert FeeBelowFloor(feeOut, _s().minFeeOut); // version 2
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
