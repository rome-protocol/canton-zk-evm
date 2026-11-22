// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

import {Initializable} from "./vendor/Initializable.sol";
import {IBook, IGateway, IOstiaBridge, IToken, Asset, ClaimArgs, RouteState} from "./Interfaces.sol";
import {Labels} from "./Labels.sol";
import {InboxCode} from "./InboxCode.sol";

// One user action each way between Canton and the AggLayer chains. Anyone may call it, because every call can only pay out to an
// address the user fixed. It holds no funds between calls. Behind a proxy; all state is in one namespaced struct, fields only
// ever appended. Flow A (out): claimAndBridge. Flow C (back to Canton): openInbox, claimAndWithdraw, claimToInbox, forward, mark, refund.
contract CantonRouter is Initializable {
    /// @custom:storage-location erc7201:rome.canton.router.v1
    struct Layout {
        IBook book;
        IGateway gateway;
        IOstiaBridge bridge;
        bytes32 inboxCodeHash;
        mapping(address inbox => mapping(address token => uint256)) refundAt;
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
        uint256 room = lockRoom(token);
        if (send > room) revert OverLockCap(send, room);
        uint256 fee = amount - send;
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
        return cap > held ? cap - held : 0;
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
