/**
 * Tokens that carry a warning, by lowercase address, each with the sentence the explorer shows beside the token wherever it is named (the labels, the token page, the token list and the
 * search): a token that carries the symbol of one of Rome's own and is not it, or one left over from a network the chain has left. A reader who knows a token by its name is told it is not the one they know.
 */
export const LOOKALIKES: Readonly<Record<string, string>> = {
  // Shares the symbol WtROME with Rome's own twin, 0xc221fc4af51caa9d198e70e3cb3b8f3d9d2adc64.
  "0xdbcdf63c98062eb5cd866d48c20b92ef25147bb5": "Not Rome's WtROME twin",
  // DevNet's Canton Coin and wTKB: Ostia left DevNet on 2026-11-21, so nothing backs them on TestNet.
  "0x4db3dea7c13116961fd3e438542ccfcca61a7547": "Left over from DevNet, not backed on TestNet",
  "0x294d3049874526910a69f6b61da14d10a8b1b3af": "Left over from DevNet, not backed on TestNet",
};
