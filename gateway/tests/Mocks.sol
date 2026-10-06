// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

// Four tokens that are not the gateway's own wrapped tokens, for the gateway's tests only. They are compiled by run.sh and deployed by check.py.

// mint and burn do nothing and never fail: a token that would let the gateway through if the gateway did not check that the
// token is one it made.
contract OpenToken {
    function mint(address, uint256) external {}
    function burn(address, uint256) external {}
}

// transferFrom says no.
contract FalseToken {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

// transferFrom says nothing at all.
contract SilentToken {
    function transferFrom(address, address, uint256) external {}
}

// transferFrom calls back into the gateway with the call that `arm` stored (once), and records whether that call went through.
contract CallbackToken {
    address public immutable gateway;
    bytes public payload;
    bool public lastOk;

    constructor(address gateway_) {
        gateway = gateway_;
    }

    function arm(bytes calldata data) external {
        payload = data;
    }

    function transferFrom(address, address, uint256) external returns (bool) {
        bytes memory p = payload;
        if (p.length > 0) {
            delete payload;
            (bool ok,) = gateway.call(p);
            lastOk = ok;
        }
        return true;
    }
}
