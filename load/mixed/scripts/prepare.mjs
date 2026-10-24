// Run after `forge build --profile pair`: reads the Uniswap V2 pair's creation code, computes its init code hash, and writes contracts/gen/ with a
// copy of the periphery router whose library carries that hash (the router finds a pair by CREATE2 from the factory, with the hash of the pair
// code the factory carries; the published hash belongs to the original build of the pair, not to ours). Nothing is vendored: the copy is made
// at run time from node_modules, in a folder that git ignores.
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { keccak256 } from "ethers";

const art = JSON.parse(readFileSync("out-pair/UniswapV2Pair.sol/UniswapV2Pair.json", "utf8"));
const hash = keccak256(art.bytecode.object).slice(2);
const src = "node_modules/@uniswap/v2-periphery/contracts";
const dst = "contracts/gen/periphery";
rmSync("contracts/gen", { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(`${src}/UniswapV2Router02.sol`, `${dst}/UniswapV2Router02.sol`);
// only what the router imports (the rest of the package, the oracle library for one, does not compile with the solc the router needs)
mkdirSync(`${dst}/interfaces`); mkdirSync(`${dst}/libraries`);
for (const f of ["interfaces/IUniswapV2Router01.sol", "interfaces/IUniswapV2Router02.sol", "interfaces/IERC20.sol", "interfaces/IWETH.sol", "libraries/UniswapV2Library.sol", "libraries/SafeMath.sol"]) cpSync(`${src}/${f}`, `${dst}/${f}`);
const lib = `${dst}/libraries/UniswapV2Library.sol`;
const text = readFileSync(lib, "utf8");
const re = /hex'[0-9a-fA-F]{64}'/;
if (!re.test(text)) throw new Error("the init code hash is not where it was expected in UniswapV2Library.sol");
writeFileSync(lib, text.replace(re, `hex'${hash}'`));
// the exact path the router imports its library from stays the same, so its imports need no change
writeFileSync("contracts/gen/PAIR_INIT_CODE_HASH", `0x${hash}\n`);
console.log("pair init code hash 0x" + hash);
