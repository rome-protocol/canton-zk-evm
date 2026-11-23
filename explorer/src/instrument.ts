/** Canton's own coin is an instrument called "Amulet": people know it as Canton Coin. */
const CANTON_COIN = "Canton Coin";
/** What a Canton instrument is called to people: Canton Coin for the Amulet instrument, otherwise its id. The one place for this mapping. */
export const instrumentName = (id: string): string => (id === "Amulet" ? CANTON_COIN : id);
