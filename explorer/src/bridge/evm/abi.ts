import { erc20Abi, parseAbi } from "viem";

export { erc20Abi };

/** gateway/Gateway.sol: the calls a person makes, and the `used` map. */
export const gatewayAbi = parseAbi([
  "function pay(bytes32 id, address token, address to, uint256 amount)",
  "function claim(bytes32 id, address token, uint256 amount)",
  "function withdraw(address token, uint256 amount, string party)",
  "function used(bytes32 id) view returns (bool)",
]);

/** gateway/Vault.sol. */
export const vaultAbi = parseAbi([
  "function GATEWAY() view returns (address)",
  "function release(string ref, address token, address to, uint256 amount)",
]);

/** The wrapped coin (WtROME): `deposit()` mints as much as it is sent. */
export const wrapperAbi = parseAbi(["function deposit() payable"]);
