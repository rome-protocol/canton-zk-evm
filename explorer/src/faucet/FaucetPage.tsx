import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { createFaucetClient, type CoinResult, type FaucetClient, type FaucetInfo } from "./faucet-client.ts";
import { formatCoin, formatPeriod, formatWait, shortHash } from "./format.ts";
import "./faucet.css";

export interface FaucetPageProps {
  /** Reads `/api/faucet` and posts to it. A test gives its own. */
  client?: FaucetClient;
  /** The chain's coin, from the explorer's status answer. */
  coin: { symbol: string; decimals: number };
}

const DEFAULT_CLIENT = createFaucetClient();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NOT_AN_ADDRESS = "That is not an address. An address is 0x and 40 hex digits.";

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; info: FaucetInfo };

const icons = {
  ok: <path d="M3 8.4l3.1 3.1L13 4.6" />,
  bad: <path d="M4 4l8 8M12 4l-8 8" />,
  note: <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" /></>,
  copy: <><rect x="5" y="5" width="8.5" height="8.5" rx="1.6" /><path d="M10.5 5V3.6c0-.9-.7-1.6-1.6-1.6H3.6C2.7 2 2 2.7 2 3.6v5.3c0 .9.7 1.6 1.6 1.6H5" /></>,
};

function Icon({ name, size = 15 }: { name: keyof typeof icons; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {icons[name]}
    </svg>
  );
}

function Alert({ tone, icon, role, id, children }: { tone: "ok" | "bad" | "wait" | "muted"; icon: keyof typeof icons; role: "alert" | "status"; id?: string; children: ReactNode }) {
  return (
    <div className={`alert ${tone}-alert`} role={role} id={id}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

function CopyButton({ value, what }: { value: string; what: string }) {
  return (
    <button type="button" className="copy" title="Copy" aria-label={`Copy ${what}`} onClick={() => { navigator.clipboard?.writeText(value).catch(() => {}); }}>
      <Icon name="copy" size={13} />
    </button>
  );
}

/**
 * The faucet's page: a form that asks for the chain's test coin, and every way a request can end. It is the page's content only. The
 * explorer's header, footer and the route around it come from the shell. It must be rendered inside a router, for the links.
 */
export function FaucetPage({ client = DEFAULT_CLIENT, coin }: FaucetPageProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [address, setAddress] = useState("");
  const [sending, setSending] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [result, setResult] = useState<CoinResult | { kind: "invalid" } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const alive = useRef(true);
  const field = useId(), notice = useId();

  useEffect(() => {
    alive.current = true;
    client.info().then(
      (info) => alive.current && setLoaded({ state: "ready", info }),
      (e: unknown) => alive.current && setLoaded({ state: "failed", message: e instanceof Error ? e.message : "The faucet cannot be read right now." }),
    );
    return () => { alive.current = false; };
  }, [client]);

  // After "another request is being sent", the button waits out the time the faucet named.
  useEffect(() => {
    if (result?.kind !== "busy" || result.waitSeconds === null) return;
    setCooling(true);
    const timer = setTimeout(() => setCooling(false), result.waitSeconds * 1000);
    return () => { clearTimeout(timer); setCooling(false); };
  }, [result]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const typed = address.trim();
    if (sending) return;
    setResult(null);
    if (!ADDRESS.test(typed)) { setResult({ kind: "invalid" }); return; }
    setSending(true);
    const answer = await client.request(typed);
    if (!alive.current) return;
    setSending(false);
    setResult(answer);
    if (answer.kind === "sent") {
      setSentTo(typed);
      // The balance has moved: read it again, and keep the old figure if that fails.
      client.info().then((info) => alive.current && setLoaded({ state: "ready", info }), () => {});
    }
  }

  return (
    <div className="faucet-page">
      <div className="ptitle"><h1>Faucet</h1></div>
      <section className="card faucet">{body()}</section>
    </div>
  );

  function body() {
    if (loaded.state === "loading") return <p className="muted">Looking up the faucet…</p>;
    if (loaded.state === "failed") return <Alert tone="bad" icon="bad" role="alert">{loaded.message}</Alert>;
    const { info } = loaded;
    const amount = `${formatCoin(info.amount, coin.decimals)} ${coin.symbol}`;
    const window = formatPeriod(info.perAddressSeconds);
    const invalid = result?.kind === "invalid";
    const disabled = sending || cooling || (sentTo !== null && address.trim() === sentTo);

    return (
      <>
        <p className="lead">
          {coin.symbol} is this chain's test coin. It has no value. The faucet sends {amount} to an address, {info.perAddressSeconds === 86400 ? "once a day" : `once every ${window}`}.
        </p>
        {info.on ? (
          <form className="ff" onSubmit={submit} noValidate>
            <label className="small muted" htmlFor={field}>Your address</label>
            <div className="ff-row">
              <input
                id={field} name="address" className="input mono" type="text" placeholder="0x…" value={address}
                autoComplete="off" autoCapitalize="off" spellCheck={false}
                aria-invalid={invalid} aria-describedby={result ? notice : undefined}
                onChange={(e) => { setAddress(e.target.value); if (invalid) setResult(null); }}
              />
              <button type="submit" className="btn primary" disabled={disabled}>{sending ? "Sending…" : `Request ${amount}`}</button>
            </div>
          </form>
        ) : (
          <Alert tone="muted" icon="note" role="status"><b>The faucet is off.</b> It runs only when the explorer is given the faucet's key.</Alert>
        )}
        {result && outcome(result, notice, amount, window)}
        <ul className="fnotes small muted">
          <li>Coins arrive with the next proven block. Blocks are made only while the chain's builder runs.</li>
          <li>One request per address per {window}.</li>
          {info.address && (
            <li>
              The faucet's address <Link className="hx" to={`/address/${info.address}`} title={info.address}><span className="mono">{shortHash(info.address)}</span></Link>
              <CopyButton value={info.address} what="the faucet's address" />
              {info.balance !== null && <> holds {formatCoin(info.balance, coin.decimals)} {coin.symbol}.</>}
            </li>
          )}
        </ul>
      </>
    );
  }

  function outcome(r: CoinResult | { kind: "invalid" }, id: string, amount: string, window: string) {
    switch (r.kind) {
      case "sent":
        return (
          <Alert tone="ok" icon="ok" role="status" id={id}>
            <b>Sent {formatCoin(r.amount, coin.decimals)} {coin.symbol}.</b> Transaction{" "}
            <Link className="hx" to={`/tx/${r.hash}`} title={r.hash}><span className="mono">{shortHash(r.hash)}</span></Link>
            <CopyButton value={r.hash} what="transaction hash" />{" "}
            <span className="chip chip-waiting"><i className="dot" />Waiting</span>
            <br />
            <span className="small">It arrives with the next proven block. Its page moves from Waiting to Being proven to Final.</span>
          </Alert>
        );
      case "limit":
        return <Alert tone="wait" icon="note" role="alert" id={id}><b>This address was sent {coin.symbol} in the last {window}.</b> {retry(r.waitSeconds)}</Alert>;
      case "busy":
        return <Alert tone="wait" icon="note" role="alert" id={id}><b>Another request is being sent.</b> {retry(r.waitSeconds)}</Alert>;
      case "invalid":
        return <Alert tone="bad" icon="bad" role="alert" id={id}>{NOT_AN_ADDRESS}</Alert>;
      case "problem":
        return <Alert tone="bad" icon="bad" role="alert" id={id}>{r.message}</Alert>;
    }
  }
}

const retry = (wait: number | null) => (wait === null ? "Try again later." : `Try again in ${formatWait(wait)}.`);
