import { Icon } from "./Icon.tsx";

/** A warning beside a name, in the amber of the other cautions: the sentence the server gave, with a triangle so that it is not read as a name. */
export function Warn({ text }: { text: string }) {
  return <span className="chip chip-warn" role="note"><Icon name="warn" size={12} />{text}</span>;
}
