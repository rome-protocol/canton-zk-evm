// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.17;

// Pulls the third-party contracts into the build so forge compiles them from node_modules (they are never copied into this repository).
// ERC-3643 (T-REX), at the version in package.json: the token, its registries, the compliance engine, the factory and the proxies.
import "@erc3643org/erc-3643/contracts/factory/TREXFactory.sol";
import "@erc3643org/erc-3643/contracts/proxy/authority/TREXImplementationAuthority.sol";
import "@erc3643org/erc-3643/contracts/token/Token.sol";
import "@erc3643org/erc-3643/contracts/registry/implementation/IdentityRegistry.sol";
import "@erc3643org/erc-3643/contracts/registry/implementation/IdentityRegistryStorage.sol";
import "@erc3643org/erc-3643/contracts/registry/implementation/ClaimTopicsRegistry.sol";
import "@erc3643org/erc-3643/contracts/registry/implementation/TrustedIssuersRegistry.sol";
import "@erc3643org/erc-3643/contracts/compliance/modular/ModularCompliance.sol";
// ONCHAINID, the identity contracts T-REX points at.
import "@onchain-id/solidity/contracts/Identity.sol";
import "@onchain-id/solidity/contracts/ClaimIssuer.sol";
import "@onchain-id/solidity/contracts/factory/IdFactory.sol";
import "@onchain-id/solidity/contracts/proxy/ImplementationAuthority.sol";
import "@onchain-id/solidity/contracts/proxy/IdentityProxy.sol";
