/** Said on every block page. It says what Canton keeps from the public, and who does see it. It gives no count of legs: a count could point at one public transfer. */
export const LEGS_THIS_BLOCK = "Daml legs settled with this block are not shown to the public. Only the parties to each leg and the chain's operator, confirmer, gateway and builder see them, and each token's registry sees its own token move.";
/** The same, for a list of the legs of many blocks. */
export const LEGS_THESE_BLOCKS = "Daml legs settled with these blocks are not shown to the public. Only the parties to each leg and the chain's operator, confirmer, gateway and builder see them, and each token's registry sees its own token move.";

/** The two sentences that end every page. The second says what the pages promise about where their numbers come from. */
export const FOOTER_LINE = "This explorer reads Canton as the chain's reader party, which is shown the record of every block and nothing else on Canton. Every number on this site is read from the chain, from Canton or from the chain's own producer log; nothing is loaded from another host.";
/** Where the explorer's code is. It is a link a person may follow, and the only web address in the pages. */
export const SOURCE_URL = "https://github.com/rome-protocol/canton-zk-evm";
