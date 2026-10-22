/** The status words. Being built: cut by the producer and made by reth, no proof started. Final: proven, checked by the confirmers and committed on Canton. Being proven: made by reth, not on Canton yet. Not indexed yet: final on Canton, and the explorer has not read the block yet. Waiting: in reth's pool, in no block yet. Genesis: the chain's starting block. */
export const STATUS_WORDS = { final: "Final", building: "Being built", proving: "Being proven", unindexed: "Not indexed yet", waiting: "Waiting", genesis: "Genesis", replaced: "Replaced", dropped: "Dropped" } as const;
export type Status = keyof typeof STATUS_WORDS;

export function Chip({ status }: { status: Status }) {
  return <span className={`chip chip-${status}`}><i className="dot" />{STATUS_WORDS[status]}</span>;
}
