// Merces (TACEO) from Node: throwaway MPC keys, and client-side proofs for private transfers, made with TACEO's published client (@taceo/merces1-client).
// The client's own Client class talks to TACEO's MPC nodes, which are not part of this test; only its proof functions are used.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { RUN } from "./lib.mjs";

const client = await import("@taceo/merces1-client");
// the BabyJubJub curve, from the copy of @noble/curves that the client itself uses
const req = createRequire(createRequire(import.meta.url).resolve("@taceo/merces1-client"));
const { babyjubjub } = await import(pathToFileURL(req.resolve("@noble/curves/misc.js")));

/** Three MPC key pairs made for this test and kept in keys/merces-mpc.json (0600). No MPC node holds them, so nothing is ever settled. */
export function mpcKeys() {
  const p = `${RUN}/keys/merces-mpc.json`;
  if (!existsSync(p)) {
    const n = babyjubjub.Point.Fn.ORDER;
    const sks = [0, 1, 2].map(() => (BigInt("0x" + randomBytes(32).toString("hex")) % (n - 1n) + 1n).toString());
    writeFileSync(p, JSON.stringify({ note: "throwaway: made for the load test, held by no MPC node", sks }, null, 2), { mode: 0o600 });
  }
  const { sks } = JSON.parse(readFileSync(p, "utf8"));
  return sks.map((sk) => babyjubjub.Point.BASE.multiply(BigInt(sk)).toAffine());
}

/**
 * The arguments of Merces.transfer for `amount` (wei), proved on this machine. The receiver is added by the caller.
 * The proof is compressed by the client verifier contract's own compressProof (a view call): the JavaScript client's compression picked the wrong sign
 * for one point in about two proofs of five (its square root is not the one the contract expects), and the contract refused those.
 */
export async function proveTransfer(amount, pks, clientVerifier) {
  const t0 = Date.now();
  const prep = client.prepareTransfer(amount, pks);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(prep.inputs, await client.fetchWitnessWasm(), await client.fetchZkey());
  const B = proof.pi_b;
  // EIP-197 order: A.x, A.y, B.x(imaginary, real), B.y(imaginary, real), C.x, C.y
  const flat = [proof.pi_a[0], proof.pi_a[1], B[0][1], B[0][0], B[1][1], B[1][0], proof.pi_c[0], proof.pi_c[1]].map(BigInt);
  const compressed = (await clientVerifier.compressProof(flat)).map(BigInt);
  return {
    args: [prep.amountCommitment, BigInt(publicSignals[0]), client.encodeCiphertexts(prep.ciphertexts, prep.senderPk), compressed],
    proveMs: Date.now() - t0,
  };
}
