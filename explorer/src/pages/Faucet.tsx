import { unready } from "../components/Cards.tsx";
import { FaucetPage } from "../faucet/FaucetPage.tsx";
import { useStatus } from "../useStatus.ts";

/** The Faucet route: the page's content, with the coin's name and decimals from the status answer. The faucet's own address and balance come from `GET /api/faucet`, which the page reads. */
export function Faucet() {
  const st = useStatus();
  const wait = unready(st, "Looking up the faucet…");
  if (wait) return wait;
  return <FaucetPage coin={st.data!.coin} />;
}
