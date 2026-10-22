// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// The contracts the indexer's trace reading must get right on a real reth (design sections 4.3 and 5.2): contracts made by a factory with CREATE and
/// CREATE2, clones, a contract that destroys itself in its creation transaction and one that destroys itself later, a call whose inner call fails,
/// work that is undone by a failing parent, and a proxy of each kind. Used by the real-reth test (server/indexer/real-reth.test.ts). Written for this
/// repository, with no library: the proxies keep their address in the standard slots, as the standards say.

contract Impl {
    uint256 public x;
    function init(uint256 v) external { x = v; }
    function boom() external pure { revert("inner"); }
    /// What a UUPS implementation answers (EIP-1822 and OpenZeppelin's UUPSUpgradeable).
    function proxiableUUID() external pure returns (bytes32) { return 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc; }
}

contract Child {
    uint256 public tag;
    constructor(uint256 t) { tag = t; }
}

/// A creation that fails: the call that makes it reverts, and no contract exists.
contract Reverter {
    constructor() { revert("no"); }
}

/// Destroys itself when told to. In the transaction that made it, the code is gone at the end of the block; in a later transaction, a chain that follows
/// EIP-6780 keeps the code.
contract Mortal {
    function kill(address payable to) external { selfdestruct(to); }
}

abstract contract Forward {
    function _forward(address to) internal {
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), to, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }
}

/// EIP-1967: the implementation in the slot keccak256("eip1967.proxy.implementation") - 1. Also what a UUPS proxy is (the upgrade logic is in the implementation).
contract Proxy1967 is Forward {
    bytes32 private constant SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    constructor(address impl) { bytes32 s = SLOT; assembly { sstore(s, impl) } }
    fallback() external payable { address to; bytes32 s = SLOT; assembly { to := sload(s) } _forward(to); }
}

contract Beacon {
    address public implementation;
    constructor(address i) { implementation = i; }
}

/// EIP-1967's beacon slot: keccak256("eip1967.proxy.beacon") - 1.
contract BeaconProxy is Forward {
    bytes32 private constant SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    constructor(address beacon) { bytes32 s = SLOT; assembly { sstore(s, beacon) } }
    fallback() external payable { address to; bytes32 s = SLOT; assembly { to := sload(s) } _forward(Beacon(to).implementation()); }
}

/// The older EIP-1822 slot: keccak256("PROXIABLE").
contract Proxy1822 is Forward {
    bytes32 private constant SLOT = 0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7;
    constructor(address impl) { bytes32 s = SLOT; assembly { sstore(s, impl) } }
    fallback() external payable { address to; bytes32 s = SLOT; assembly { to := sload(s) } _forward(to); }
}

contract Lab {
    /// kind: 1 CREATE child, 2 CREATE2 child, 3 clone (CREATE), 4 clone (CREATE2), 5 made and destroyed in one transaction, 6 EIP-1967 proxy, 7 UUPS proxy,
    /// 8 beacon, 9 beacon proxy, 10 EIP-1822 proxy, 11 implementation, 12 mortal.
    event Made(uint8 indexed kind, address made);

    address public mortal;

    function _clone(address impl, bool two, bytes32 salt) internal returns (address inst) {
        bytes memory code = abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3");
        if (two) { assembly { inst := create2(0, add(code, 0x20), mload(code), salt) } }
        else { assembly { inst := create(0, add(code, 0x20), mload(code)) } }
        require(inst != address(0), "clone failed");
    }

    /// One transaction that makes every kind, and calls a contract whose call fails with the failure caught.
    function build() external {
        Impl impl = new Impl();
        emit Made(11, address(impl));
        emit Made(1, address(new Child(1)));
        emit Made(2, address(new Child{salt: bytes32(uint256(2))}(2)));
        emit Made(3, _clone(address(impl), false, 0));
        emit Made(4, _clone(address(impl), true, bytes32(uint256(4))));
        Mortal doomed = new Mortal();
        emit Made(5, address(doomed));
        doomed.kill(payable(address(this)));
        emit Made(6, address(new Proxy1967(address(impl))));
        // A UUPS proxy: the same slot, over an implementation that answers proxiableUUID().
        emit Made(7, address(new Proxy1967(address(impl))));
        Beacon beacon = new Beacon(address(impl));
        emit Made(8, address(beacon));
        emit Made(9, address(new BeaconProxy(address(beacon))));
        emit Made(10, address(new Proxy1822(address(impl))));
        Mortal m = new Mortal();
        mortal = address(m);
        emit Made(12, address(m));
        // A creation that fails, and an inner call that fails; this call does not.
        try new Reverter() { revert("the creation must fail"); } catch {}
        (bool ok, ) = address(impl).call(abi.encodeWithSignature("boom()"));
        require(!ok, "the inner call must fail");
    }

    /// Makes a contract and then fails: nothing it made stays.
    function undone() external {
        new Child(99);
        revert("undone");
    }

    /// The contract made by build() destroys itself, in a later transaction.
    function kill() external { Mortal(mortal).kill(payable(msg.sender)); }
}
