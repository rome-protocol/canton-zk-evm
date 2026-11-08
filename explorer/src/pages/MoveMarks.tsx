import { Link } from "react-router-dom";
import { lostWords, MARK_NAMES, type Marks } from "../bridge/marks.ts";

/** Sent, Proven, Final: a filled dot for a mark that was reached, an empty one for a mark still to come, and (unless `block` is false) the block once the transaction is in one. */
export function MoveMarks({ marks, block = true }: { marks: Marks; block?: boolean }) {
  const on = [marks.sent, marks.proven, marks.final];
  return (
    <>
      <ol className="marks" aria-label="How far the move has got">
        {MARK_NAMES.map((name, i) => <li key={name} className={on[i] ? "on" : undefined} aria-label={`${name}: ${on[i] ? "done" : "waiting"}`}><i aria-hidden="true" />{name}</li>)}
      </ol>
      {marks.lost && <span className="small bad" role="status">{lostWords(marks.lost)}</span>}
      {block && marks.block !== null && <Link className="small" to={`/block/${marks.block}`}>block {marks.block}</Link>}
    </>
  );
}
