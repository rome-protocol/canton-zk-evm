// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Rome Protocol
pragma solidity 0.8.28;

// The route label of a Canton deposit, and the deposit id Canton makes from it. Label form r1, exactly:
//   "r1:" ++ decimal(destNetwork) ++ ":0x" ++ 40 lowercase hex digits of destAddress ++ ":" ++ decimal(maxFee) ++ ":" ++ decimal(nonce)
// with decimals that have no leading zeros. A new form gets a new prefix and never replaces this one.
library Labels {
    function route(uint32 destNetwork, address destAddress, uint256 maxFee, uint64 nonce) internal pure returns (string memory) {
        return string(abi.encodePacked("r1:", decimal(destNetwork), ":0x", hex40(destAddress), ":", decimal(maxFee), ":", decimal(nonce)));
    }

    // What Daml's depositIdOf makes: the SHA-256 of "deposit,<party>,<label>".
    function depositId(string memory party, string memory label) internal pure returns (bytes32) {
        return sha256(abi.encodePacked("deposit,", party, ",", label));
    }

    function decimal(uint256 v) internal pure returns (bytes memory out) {
        uint256 n = 1;
        for (uint256 t = v; t >= 10; t /= 10) n++;
        out = new bytes(n);
        while (n > 0) {
            out[--n] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
    }

    function hex40(address a) internal pure returns (bytes memory out) {
        out = new bytes(40);
        uint160 v = uint160(a);
        for (uint256 i = 40; i > 0; i--) {
            uint8 d = uint8(v & 0xf);
            out[i - 1] = bytes1(d < 10 ? 48 + d : 87 + d);
            v >>= 4;
        }
    }

    // The parts of a label in the exact r1 form. Anything else (capital hex, a leading zero, a missing part, a part too big for its
    // type) gives ok = false: the parts are read loosely, then the label is made again and must be the same bytes.
    function parse(string memory label) internal pure returns (bool ok, uint32 destNetwork, address destAddress, uint256 maxFee, uint64 nonce) {
        bytes memory b = bytes(label);
        if (b.length < 51 || b[0] != "r" || b[1] != "1" || b[2] != ":") return (false, 0, address(0), 0, 0);
        uint256[3] memory cut; // the positions of the three colons after "r1:"
        uint256 found;
        for (uint256 i = 3; i < b.length; i++) {
            if (b[i] == ":") {
                if (found == 3) return (false, 0, address(0), 0, 0);
                cut[found++] = i;
            }
        }
        if (found != 3) return (false, 0, address(0), 0, 0);
        bool a; bool c; bool d;
        uint256 net;
        uint256 n;
        (a, net) = _dec(b, 3, cut[0], type(uint32).max);
        (c, maxFee) = _dec(b, cut[1] + 1, cut[2], type(uint256).max);
        (d, n) = _dec(b, cut[2] + 1, b.length, type(uint64).max);
        if (!a || !c || !d || cut[1] - cut[0] != 43 || b[cut[0] + 1] != "0" || b[cut[0] + 2] != "x") return (false, 0, address(0), 0, 0);
        uint160 addr;
        for (uint256 i = cut[0] + 3; i < cut[1]; i++) {
            uint8 ch = uint8(b[i]);
            uint8 v = ch >= 48 && ch <= 57 ? ch - 48 : ch >= 97 && ch <= 102 ? ch - 87 : 255;
            if (v == 255) return (false, 0, address(0), 0, 0);
            addr = addr * 16 + v;
        }
        destNetwork = uint32(net);
        destAddress = address(addr);
        nonce = uint64(n);
        ok = keccak256(bytes(route(destNetwork, destAddress, maxFee, nonce))) == keccak256(b);
    }

    function _dec(bytes memory b, uint256 from, uint256 to, uint256 max) private pure returns (bool, uint256 v) {
        if (to <= from) return (false, 0);
        for (uint256 i = from; i < to; i++) {
            uint256 d = uint8(b[i]);
            if (d < 48 || d > 57) return (false, 0);
            d -= 48;
            if (v > (type(uint256).max - d) / 10) return (false, 0);
            v = v * 10 + d;
        }
        return (v <= max, v);
    }
}
