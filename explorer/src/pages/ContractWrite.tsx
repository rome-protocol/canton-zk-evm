import { useId, useState } from "react";
import { parseUnits } from "viem";
import { callable, encodeCall, type AbiEntry } from "../abi-call.ts";
import type { ApiStatus, ContractDetail } from "../api.ts";
import { HashLink } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { useStatus } from "../useStatus.ts";
import { injected, useWallet, walletWords } from "../wallet.ts";
import { Fields, Gate, headline, useChoice } from "./ContractCall.tsx";
import { useAbi } from "./useAbi.ts";

type Wallet = ReturnType<typeof useWallet>;
type Coin = ApiStatus["coin"];

function WriteItem({ n, address, e, wallet, coin }: { n: number; address: string; e: AbiEntry; wallet: Wallet; coin: Coin | undefined }) {
  const [values, setValues] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const payable = e.stateMutability === "payable";
  const valueId = `${useId()}-value`;
  const ready = wallet.canSend;
  const send = async () => {
    const w = injected();
    if (!w || !wallet.account || !wallet.canSend || wallet.chainId === null) return;
    let data: string, wei: bigint | null = null;
    try { data = encodeCall(e, values); } catch (x) { return setProblem((x as Error).message); }
    if (payable && value.trim() !== "") {
      try { wei = parseUnits(value.trim(), coin?.decimals ?? 18); } catch { return setProblem(`Value: type the amount in ${coin?.symbol ?? "coin"} as a number, like 0.5`); }
    }
    setProblem(null); setSent(null); setBusy(true);
    try {
      const tx: Record<string, string> = { from: wallet.account, to: address, data, chainId: "0x" + wallet.chainId.toString(16) };
      if (wei !== null) tx.value = "0x" + wei.toString(16);
      setSent(String(await w.request({ method: "eth_sendTransaction", params: [tx] })));
    } catch (x) { setProblem(walletWords(x)); } finally { setBusy(false); }
  };
  return (
    <section className="fn" aria-label={e.name}>
      <div className="fn-h"><span className="muted">{n}.</span> <span className="mono fn-name">{headline(e)}</span>{payable && <span className="muted small">payable</span>}</div>
      <div className="fn-b">
        <Fields e={e} values={values} onChange={(i, v) => setValues((a) => { const b = [...a]; b[i] = v; return b; })} />
        {payable && (
          <div className="field">
            <label htmlFor={valueId} className="muted small">Value ({coin?.symbol ?? "coin"})</label>
            <input id={valueId} className="inp mono" type="text" inputMode="decimal" autoComplete="off" placeholder={`value (${coin?.symbol ?? "coin"})`} value={value} onChange={(ev) => setValue(ev.target.value)} />
          </div>
        )}
        <div className="fn-q">
          <button type="button" className="btn" disabled={!ready || busy} onClick={send}>Write</button>
          {!ready && <span className="muted small">{wallet.account === null ? "Connect a wallet first" : wallet.wrongChain ? "Switch your wallet to this chain first" : "Checking which chain your wallet is on…"}</span>}
        </div>
        {problem && <p className="fact-bad small" role="alert">{problem}</p>}
        {sent && <p className="small" role="status">Your wallet sent it: <HashLink value={sent} to={`/tx/${sent}`} /></p>}
      </div>
    </section>
  );
}

function Connect({ wallet, status }: { wallet: Wallet; status: ApiStatus | undefined }) {
  const chain = status ? `${status.chainName} (chain ${status.chainId})` : "this chain";
  return (
    <div className="wallet-bar card-note" role="group" aria-label="Wallet">
      <Icon name="lock" size={16} />
      <div>
        {wallet.account === null
          ? <><strong>Connect a wallet to write.</strong><div className="small muted">The explorer holds no key. Your wallet signs and sends to {chain}; the transaction then shows on its own page as it goes through.</div></>
          : <><strong>Connected: <span className="mono">{wallet.account.slice(0, 6)}…{wallet.account.slice(-4)}</span></strong>
            {wallet.wrongChain && <div className="small fact-bad">Your wallet is on chain {wallet.chainId}, not {chain}.</div>}</>}
        {wallet.error && <div className="small fact-bad" role="alert">{wallet.error}</div>}
        {!wallet.available && wallet.account === null && <div className="small muted">No wallet was found in this browser.</div>}
      </div>
      {wallet.account === null ? <button type="button" className="btn" onClick={wallet.connect}>Connect wallet</button>
        : wallet.wrongChain ? <button type="button" className="btn" onClick={wallet.switchChain}>Switch network</button> : null}
    </div>
  );
}

/** Write: the functions that change state, sent from the visitor's own wallet (EIP-1193). The explorer encodes the call and holds no key. */
export function WriteTab({ detail }: { detail: ContractDetail }) {
  const abis = useAbi(detail);
  const { entries, note, switcher } = useChoice(abis);
  const status = useStatus().data;
  const wallet = useWallet(status);
  const fns = entries ? callable(entries, "write") : [];
  return (
    <Gate abis={abis} entries={entries} what="Write contract">
      <section className="card" aria-label="Write contract">
        <div className="list-h"><h2>Write contract <span className="muted thin">Drawn from the verified ABI</span></h2>{switcher}</div>
        {note && <p className="small muted card-note">{note}</p>}
        <Connect wallet={wallet} status={status} />
        {fns.length === 0 ? <p className="muted">This contract has no functions that change state.</p>
          : <div className="fn-cols">{fns.map((e, i) => <WriteItem key={`${e.name}-${i}`} n={i + 1} address={detail.address} e={e} wallet={wallet} coin={status?.coin} />)}</div>}
      </section>
    </Gate>
  );
}
