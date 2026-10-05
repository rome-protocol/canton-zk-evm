/** The status words. Final: proven, checked by the confirmers and committed on Canton. Being proven: made by reth, not on Canton yet. Waiting: in reth's pool, in no block yet. Genesis: the chain's starting block. */
export const STATUS_WORDS = { final: "Final", proving: "Being proven", waiting: "Waiting", genesis: "Genesis" } as const;
export type Status = keyof typeof STATUS_WORDS;

export function Chip({ status }: { status: Status }) {
  return <span className={`chip chip-${status}`}><i className="dot" />{STATUS_WORDS[status]}</span>;
}
