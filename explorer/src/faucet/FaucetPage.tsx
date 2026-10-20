import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { createFaucetClient, type CoinResult, type FaucetClient, type FaucetInfo, type Ticket } from "./faucet-client.ts";
import { formatCoin, formatPeriod, formatWait, shortHash } from "./format.ts";
import "./faucet.css";

export interface FaucetPageProps {
  /** Reads `/api/faucet` and posts to it. A test gives its own. */
  client?: FaucetClient;
  /** The chain's coin, from the explorer's status answer. */
  coin: { symbol: string; decimals: number };
  /** How often a request's progress is read, in milliseconds. A test gives its own. */
  pollMs?: number;
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
export function FaucetPage({ client = DEFAULT_CLIENT, coin, pollMs = 2000 }: FaucetPageProps) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [address, setAddress] = useState("");
  const [sending, setSending] = useState(false);
  const [cooling, setCooling] = useState(false);
  const [result, setResult] = useState<CoinResult | { kind: "invalid" } | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** Counts the times the human check's widget was drawn again, because its token was used. */
  const [widgetRun, setWidgetRun] = useState(0);
  /** The request being followed, as the explorer last described it. */
  const [watch, setWatch] = useState<{ id: string; ticket: Ticket | null; asked: { position: number; amount: string }; reachable: boolean; gone: boolean } | null>(null);
  const watched = watch?.id;
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
    if (result?.kind !== "full" || result.waitSeconds === null) return;
    setCooling(true);
    const timer = setTimeout(() => setCooling(false), result.waitSeconds * 1000);
    return () => { clearTimeout(timer); setCooling(false); };
  }, [result]);

  // The human check's script draws its widget when it runs, and it draws only into what is on the page at that moment. So it is run again each time the
  // form is on the page, and again after a request has used up the token, and the widget it drew before is thrown away with the old form field.
  const check = loaded.state === "ready" && loaded.info.on ? loaded.info.captcha ?? null : null;
  const scriptUrl = check?.scriptUrl;
  useEffect(() => {
    if (!scriptUrl) return;
    for (const old of Array.from(document.scripts)) if (old.getAttribute("src") === scriptUrl) old.remove();
    const script = document.createElement("script");
    script.src = scriptUrl; script.async = true; script.defer = true;
    document.head.appendChild(script);
  }, [scriptUrl, widgetRun]);

  // A request is followed until it is final or has failed, so the page says what is true now, never what was true when it was sent.
  useEffect(() => {
    if (!watched) return;
    let stop = false, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await client.ticket(watched);
      if (stop) return;
      if (r.kind === "unknown") { setWatch((w) => w && { ...w, gone: true }); return; }
      if (r.kind === "ticket") {
        setWatch((w) => w && { ...w, ticket: r.ticket, reachable: true });
        if (r.ticket.status === "final" || r.ticket.status === "failed") {
          client.info().then((info) => !stop && setLoaded({ state: "ready", info }), () => {});
          return;
        }
      } else setWatch((w) => w && { ...w, reachable: false });
      timer = setTimeout(tick, pollMs);
    };
    timer = setTimeout(tick, pollMs);
    return () => { stop = true; clearTimeout(timer); };
  }, [watched, client, pollMs]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const typed = address.trim();
    if (sending) return;
    setResult(null);
    if (!ADDRESS.test(typed)) { setResult({ kind: "invalid" }); return; }
    setSending(true);
    // The check's script puts its answer in a field of the form whose name ends in -response.
    const token = (event.currentTarget.querySelector('[name$="-response"]') as HTMLInputElement | null)?.value || undefined;
    setWatch(null);
    const answer = await client.request(typed, token);
    if (!alive.current) return;
    setSending(false);
    setResult(answer);
    setWidgetRun((n) => n + 1);
    if (answer.kind === "queued") {
      setSentTo(typed);
      setWatch({ id: answer.ticket, ticket: null, asked: { position: answer.position, amount: answer.amount }, reachable: true, gone: false });
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
    const failed = watch?.ticket?.status === "failed";
    const disabled = sending || cooling || (sentTo !== null && address.trim() === sentTo && !failed);

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
            {info.captcha && <div key={widgetRun} className={info.captcha.widgetClass} data-sitekey={info.captcha.siteKey} />}
          </form>
        ) : (
          <Alert tone="muted" icon="note" role="status"><b>The faucet is off.</b> It runs only when the explorer is given the faucet's key.</Alert>
        )}
        {result && outcome(result, notice, amount, window)}
        <ul className="fnotes small muted">
          <li>A request is taken at once and sent in a batch. The coins count only when the block holding them is final on Canton, and this page says when.</li>
          <li>Blocks are made only while the chain's builder runs.</li>
          <li>One request per address per {window}{info.perIpSeconds ? `, and one per connection every ${formatPeriod(info.perIpSeconds)}` : ""}.</li>
          {info.queue !== undefined && info.queue > 0 && <li>{info.queue} {info.queue === 1 ? "request is" : "requests are"} waiting in line.</li>}
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

  /** Where the request is, in plain words. "Final on Canton" is the only word of success. */
  function progress(id: string, amount: string) {
    if (!watch) return null;
    const t = watch.ticket;
    const tx = t?.hash && (
      <>
        {" "}Transaction{" "}
        <Link className="hx" to={`/tx/${t.hash}`} title={t.hash}><span className="mono">{shortHash(t.hash)}</span></Link>
        <CopyButton value={t.hash} what="transaction hash" />
      </>
    );
    const lost = !watch.reachable && <><br /><span className="small">The explorer cannot be reached just now. This page keeps asking.</span></>;
    if (watch.gone) return <Alert tone="muted" icon="note" role="status" id={id}><b>The explorer no longer knows this request.</b> Look at the address's balance, or ask again.</Alert>;
    switch (t?.status ?? "queued") {
      case "final":
        return <Alert tone="ok" icon="ok" role="status" id={id}><b>{amount} is final on Canton.</b>{tx}{t?.block !== null && t?.block !== undefined && <> In block {t.block}.</>}</Alert>;
      case "failed":
        return <Alert tone="bad" icon="bad" role="alert" id={id}><b>The coins were not sent.</b> {t?.reason ?? "The transfer did not happen."} Nothing was taken from you, and you may ask again.</Alert>;
      case "sent":
        return (
          <Alert tone="wait" icon="note" role="status" id={id}>
            <b>{t?.state === "dropped" ? "Sent, and the explorer stopped following it." : t?.state === "proving" ? "Sent, and being proven." : "Sent, waiting to be proven."}</b>{tx}{" "}
            <span className="chip chip-waiting"><i className="dot" />{t?.state === "dropped" ? "Not followed" : t?.state === "proving" ? "Being proven" : "Waiting"}</span>
            <br /><span className="small">
              {t?.state === "dropped"
                ? "The chain may still take it. Open the transaction, or look at the address's balance in a few minutes. Your turn is used until then."
                : "Not final yet. It is final when the block holding it is one Canton transaction. This page updates by itself."}
            </span>{lost}
          </Alert>
        );
      default: {
        const place = t?.position ?? watch.asked.position;
        return (
          <Alert tone="wait" icon="note" role="status" id={id}>
            <b>Your request is taken. You are number {place} in line.</b>
            <br /><span className="small">The faucet sends in batches. This page updates by itself.</span>{lost}
          </Alert>
        );
      }
    }
  }

  function outcome(r: CoinResult | { kind: "invalid" }, id: string, amount: string, window: string) {
    switch (r.kind) {
      case "queued":
        return progress(id, amount);
      case "limit":
        return <Alert tone="wait" icon="note" role="alert" id={id}><b>{r.message}</b> {retry(r.waitSeconds)}</Alert>;
      case "full":
        return <Alert tone="wait" icon="note" role="alert" id={id}><b>{r.message}</b> {retry(r.waitSeconds)}</Alert>;
      case "captcha":
        return <Alert tone="bad" icon="bad" role="alert" id={id}>{r.message}</Alert>;
      case "invalid":
        return <Alert tone="bad" icon="bad" role="alert" id={id}>{NOT_AN_ADDRESS}</Alert>;
      case "problem":
        return <Alert tone="bad" icon="bad" role="alert" id={id}>{r.message}</Alert>;
    }
  }
}

const retry = (wait: number | null) => (wait === null ? "Try again later." : `Try again in ${formatWait(wait)}.`);
