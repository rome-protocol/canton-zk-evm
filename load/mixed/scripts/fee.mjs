// The fee fields of a load transaction, from the chain's current gas price (eth_gasPrice, wei).
// The tip is 1 gwei, but never more than the gas price itself: after an idle stretch the base fee
// decays to a few wei, and a node refuses a transaction whose priority fee is above its max fee.
// The max fee is twice the gas price, so it still covers the base fee if it rises while the transaction waits.
export const TIP = 1_000_000_000n;

export function fees(gasPrice) {
  const maxFeePerGas = gasPrice * 2n;
  const maxPriorityFeePerGas = gasPrice < TIP ? gasPrice : TIP;
  return { maxPriorityFeePerGas, maxFeePerGas };
}
