/**
 * Tokens that carry the symbol of one of Rome's own tokens but are not it, by lowercase address, each with the warning the explorer shows beside the
 * token wherever it is named (the labels, the token page, the token list and the search). A reader who knows a token by its symbol is told it is not the one they know.
 */
export const LOOKALIKES: Readonly<Record<string, string>> = {
  // Shares the symbol WtROME with Rome's own twin, 0xc221fc4af51caa9d198e70e3cb3b8f3d9d2adc64.
  "0xdbcdf63c98062eb5cd866d48c20b92ef25147bb5": "Not Rome's WtROME twin",
};
