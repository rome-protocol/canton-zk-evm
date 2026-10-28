/** Said on every block page: what Canton keeps from the public. It gives no count of legs: a count could point at one public transfer. The sentence on who does see them is behind the small i. */
export const LEGS_NOT_PUBLIC_THIS = "Daml legs settled with this block are not shown to the public.";
/** The same, for a list of the legs of many blocks. */
export const LEGS_NOT_PUBLIC_THESE = "Daml legs settled with these blocks are not shown to the public.";
export const LEGS_WHO_SEES = "Only the parties to each leg and the chain's operator, confirmer, gateway and builder see them, and each token's registry sees its own token move.";
/** The sentence behind the small i of the panel of a block's legs: what a swap shows, what stays private, and who does know it. */
export const LEGS_PANEL_WHO = "A swap shows both its amounts; the Canton party behind it stays private: only the parties to each leg and the chain's operator, confirmer, gateway and builder know who it is, and each token's registry sees its own token move.";
export const LEGS_THIS_BLOCK = `${LEGS_NOT_PUBLIC_THIS} ${LEGS_WHO_SEES}`;
export const LEGS_THESE_BLOCKS = `${LEGS_NOT_PUBLIC_THESE} ${LEGS_WHO_SEES}`;

/** The line that ends every page: what the pages promise about where their numbers come from. The rest of what the explorer says about itself is on the About page. */
export const FOOTER_LINE = "Every number on this site is read from the chain, from Canton or from the chain's own producer log; nothing is loaded from another host.";

/** The About page: what the chain is, what the explorer shows and does not, and whose eyes it reads Canton with. */
export const ABOUT_CHAIN = "Ostia is an EVM chain on Canton. Every block is proven with ZisK and then committed to Canton as one transaction, so a transaction is final when its block is final on Canton.";
export const ABOUT_SHOWN = "Every EVM block, transaction and address, and for each final block its record on Canton: update id, record time, synchronizer, offset and the proof.";
export const ABOUT_NOT_SHOWN = "Anything else on Canton. Daml legs settled with a block are seen only by their parties, the chain's operator, confirmer, gateway and builder, and each token's registry.";
export const ABOUT_READER = "This explorer reads Canton as the chain's reader party, which is shown the record of every block and nothing else on Canton.";
/** Where the explorer's code is. It is a link a person may follow, and the only web address in the pages. */
export const SOURCE_URL = "https://github.com/rome-protocol/canton-zk-evm";
