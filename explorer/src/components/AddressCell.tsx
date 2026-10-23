import { Link } from "react-router-dom";
import type { Label } from "../api.ts";
import { short } from "../format.ts";
import { labelName } from "../labels.ts";
import { Icon } from "./Icon.tsx";

/** Where an address leads: a token to its page, a contract to its, anything else to the address. */
export const addressPath = (address: string, label?: Label | null) =>
  label?.kind === "token" ? `/token/${address}` : label?.kind === "contract" ? `/contract/${address}` : `/address/${address}`;

/**
 * An address in a list: a token or a contract by its name (a document icon, the name and symbol, and a check when its source is
 * verified), anything else by its short address (0x and six, then four, as the screens show it). `label` comes from `useLabels` for the whole page, so a cell asks nothing itself.
 */
export function AddressCell({ address, label, to }: { address: string; label?: Label | null; to?: string }) {
  const name = labelName(label);
  const href = to ?? addressPath(address, label);
  if (!name) return <Link className="hx" to={href} title={address}><span className="mono">{short(address, 8, 4)}</span></Link>;
  return (
    <span className="acell">
      <Link className="hx" to={href} title={address}><Icon name="doc" size={13} /><span className="aname" title={name}><bdi>{name}</bdi></span></Link>
      {label?.verified && <span className="verified" role="img" aria-label="Verified" title="Its source code is verified"><Icon name="check" size={13} /></span>}
    </span>
  );
}
