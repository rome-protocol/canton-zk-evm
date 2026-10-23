import { parseAbiItem } from "viem";
import type { AbiEntry } from "./abi.ts";

/**
 * Entries that nearly every token and proxy on the chain shares, written the way Solidity writes them. They stand in for a verified ABI
 * (see `abiOrStandard`): a transaction to a contract that nobody verified is still read as "transfer" when it is one. A line that is not
 * the same function or event as an earlier one is kept; the same one is kept once, so ERC-20's and ERC-721's `approve` are one entry.
 */
const SOURCE = [
  // ERC-20
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  // ERC-721 (and the OpenZeppelin mint that most of them carry)
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)",
  "function safeMint(address to, uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  // ERC-1155
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
  "function uri(uint256 id) view returns (string)",
  "function safeTransferFrom(address from, address to, uint256 id, uint256 value, bytes data)",
  "function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] values, bytes data)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event URI(string value, uint256 indexed id)",
  // The gateway (gateway/Gateway.sol): its functions and its Leg event, and the wrapped token's mint and burn
  "function register(string name, string symbol) returns (address token)",
  "function claim(bytes32 id, address token, uint256 amount)",
  "function withdraw(address token, uint256 amount, string party)",
  "function pay(bytes32 id, address token, address to, uint256 amount)",
  "function mint(address to, uint256 amount)",
  "function burn(address from, uint256 amount)",
  "event Leg(uint8 kind, bytes32 id, address token, address account, uint256 amount, string party)",
  // EIP-1967 proxies, and EIP-1822's slot function
  "event Upgraded(address indexed implementation)",
  "event AdminChanged(address previousAdmin, address newAdmin)",
  "event BeaconUpgraded(address indexed beacon)",
  "function proxiableUUID() view returns (bytes32)",
];

const key = (e: AbiEntry) => `${e.type}:${e.name}(${(e.inputs ?? []).map((i) => i.type + (i.indexed ? "!" : "")).join(",")})`;

function build(): AbiEntry[] {
  const seen = new Set<string>();
  const out: AbiEntry[] = [];
  for (const line of SOURCE) {
    const e = parseAbiItem(line) as unknown as AbiEntry;
    if (!seen.has(key(e))) { seen.add(key(e)); out.push(e); }
  }
  return out;
}

export const STANDARD_ABI: AbiEntry[] = build();
