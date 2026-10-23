/** The EVM's opcodes up to the Prague rules, by byte. A byte not in the list is shown as INVALID, as a disassembler does. */
const NAMES: Record<number, string> = {
  0x00: "STOP", 0x01: "ADD", 0x02: "MUL", 0x03: "SUB", 0x04: "DIV", 0x05: "SDIV", 0x06: "MOD", 0x07: "SMOD", 0x08: "ADDMOD", 0x09: "MULMOD", 0x0a: "EXP", 0x0b: "SIGNEXTEND",
  0x10: "LT", 0x11: "GT", 0x12: "SLT", 0x13: "SGT", 0x14: "EQ", 0x15: "ISZERO", 0x16: "AND", 0x17: "OR", 0x18: "XOR", 0x19: "NOT", 0x1a: "BYTE", 0x1b: "SHL", 0x1c: "SHR", 0x1d: "SAR",
  0x20: "KECCAK256",
  0x30: "ADDRESS", 0x31: "BALANCE", 0x32: "ORIGIN", 0x33: "CALLER", 0x34: "CALLVALUE", 0x35: "CALLDATALOAD", 0x36: "CALLDATASIZE", 0x37: "CALLDATACOPY", 0x38: "CODESIZE", 0x39: "CODECOPY",
  0x3a: "GASPRICE", 0x3b: "EXTCODESIZE", 0x3c: "EXTCODECOPY", 0x3d: "RETURNDATASIZE", 0x3e: "RETURNDATACOPY", 0x3f: "EXTCODEHASH",
  0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER", 0x44: "PREVRANDAO", 0x45: "GASLIMIT", 0x46: "CHAINID", 0x47: "SELFBALANCE", 0x48: "BASEFEE", 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE",
  0x50: "POP", 0x51: "MLOAD", 0x52: "MSTORE", 0x53: "MSTORE8", 0x54: "SLOAD", 0x55: "SSTORE", 0x56: "JUMP", 0x57: "JUMPI", 0x58: "PC", 0x59: "MSIZE", 0x5a: "GAS", 0x5b: "JUMPDEST",
  0x5c: "TLOAD", 0x5d: "TSTORE", 0x5e: "MCOPY", 0x5f: "PUSH0",
  0xa0: "LOG0", 0xa1: "LOG1", 0xa2: "LOG2", 0xa3: "LOG3", 0xa4: "LOG4",
  0xf0: "CREATE", 0xf1: "CALL", 0xf2: "CALLCODE", 0xf3: "RETURN", 0xf4: "DELEGATECALL", 0xf5: "CREATE2", 0xfa: "STATICCALL", 0xfd: "REVERT", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
};
for (let i = 1; i <= 32; i++) NAMES[0x5f + i] = `PUSH${i}`;
for (let i = 1; i <= 16; i++) { NAMES[0x7f + i] = `DUP${i}`; NAMES[0x8f + i] = `SWAP${i}`; }

export interface Op { pc: number; name: string; data: string | null }

/** Reads code as opcodes, at most `limit` of them. A PUSH carries the bytes after it, which are data and not opcodes; a push cut short by the end of the code shows what is there. */
export function disassemble(hex: string, limit: number): { ops: Op[]; more: boolean } {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const ops: Op[] = [];
  let pc = 0;
  while (pc * 2 < h.length) {
    if (ops.length >= limit) return { ops, more: true };
    const byte = parseInt(h.slice(pc * 2, pc * 2 + 2), 16);
    const name = NAMES[byte] ?? "INVALID";
    const n = byte >= 0x60 && byte <= 0x7f ? byte - 0x5f : 0;
    ops.push({ pc, name, data: n ? "0x" + h.slice((pc + 1) * 2, (pc + 1 + n) * 2) : null });
    pc += 1 + n;
  }
  return { ops, more: false };
}
