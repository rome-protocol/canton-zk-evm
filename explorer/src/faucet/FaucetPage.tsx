import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ago, at as instant, clock, secs } from "../block-times.ts";
import { createFaucetClient, type CoinResult, type FaucetClient, type FaucetInfo, type RecentSend, type Ticket, type TxTimes } from "./faucet-client.ts";
import { formatCoin, formatCount, formatMoment, formatPeriod, formatTiny, formatWait, shortHash } from "./format.ts";
import "./faucet.css";

export interface FaucetPageProps {
  /** Reads `/api/faucet` and posts to it. A test gives its own. */
  client?: FaucetClient;
  /** The chain's coin, from the explorer's status answer. */
  coin: { symbol: string; decimals: number };
  /** The chain's name and id, for the line under the title. */
  chain?: { name: string | null; id: number };
  /** How often a request's progress is read, in milliseconds. A test gives its own. */
  pollMs?: number;
}

/** How many payouts the list shows. */
const RECENT = 6;
/** A reason from the server is cut to this many characters. */
const REASON_MAX = 300;
const DEFAULT_CLIENT = createFaucetClient();
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NOT_AN_ADDRESS = "That is not an address. An address is 0x and 40 hex digits.";

type Loaded = { state: "loading" } | { state: "failed"; message: string } | { state: "ready"; info: FaucetInfo };

const icons = {
  ok: <path d="M3 8.4l3.1 3.1L13 4.6" />,
  bad: <path d="M4 4l8 8M12 4l-8 8" />,
  note: <><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4M8 4.9v.1" /></>,
  drop: <path d="M8 1.8c2.2 2.8 4 4.8 4 7.2a4 4 0 0 1-8 0c0-2.4 1.8-4.4 4-7.2z" />,
  clock: <><circle cx="8" cy="8" r="6.2" /><path d="M8 4.6V8l2.3 1.4" /></>,
  globe: <><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c1.8 1.8 2.6 3.9 2.6 6.2S9.8 12.4 8 14.2C6.2 12.4 5.4 10.3 5.4 8S6.2 3.6 8 1.8z" /></>,
  people: <><circle cx="6" cy="5.6" r="2.3" /><path d="M1.6 13c.3-2.3 2-3.6 4.4-3.6s4.1 1.3 4.4 3.6M10.6 3.6a2.2 2.2 0 0 1 0 4M12 9.6c1.4.5 2.2 1.6 2.4 3.2" /></>,
  cube: <><path d="M8 1.6l5.6 3.2v6.4L8 14.4l-5.6-3.2V4.8z" /><path d="M2.6 4.9L8 8l5.4-3.1M8 8v6.2" /></>,
  shield: <><path d="M8 1.6l5 1.8v4.3c0 3-2 5.2-5 6.7-3-1.5-5-3.7-5-6.7V3.4z" /><path d="M5.7 8.2l1.7 1.6 3-3.2" /></>,
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
export function FaucetPage({ client = DEFAULT_CLIENT, coin, chain, pollMs = 2000 }: FaucetPageProps) {
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
  /** When the request was taken (the page's clock), for "you can ask again after". */
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [fee, setFee] = useState<string | null>(null);
  /** The faucet's newest final payouts; null while unread or when they cannot be read. */
  const [recent, setRecent] = useState<RecentSend[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [times, setTimes] = useState<TxTimes | null>(null);
  const [usual, setUsual] = useState<{ lowMs: number; highMs: number } | null>(null);
  const [commitMs, setCommitMs] = useState<number | null>(null);
  const [second, setSecond] = useState(() => Date.now());
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

  // The fee of a plain transfer and the faucet's newest final payouts are read once the faucet is known, and again when a request ends.
  const faucetAddress = loaded.state === "ready" ? loaded.info.address : null;
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let stop = false;
    client.baseFee?.().then((f) => !stop && setFee(f), () => {});
    if (faucetAddress) client.recent?.(faucetAddress, RECENT).then((r) => !stop && setRecent(r), () => {});
    return () => { stop = true; };
  }, [client, faucetAddress, reads]);
  // The times on the page are read against the clock, so they are drawn again every few seconds.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  // While a request is being proven, how far the proof has got is drawn every second, and how long a proof usually takes is read once.
  const proving = watch?.ticket?.status === "sent" && watch.ticket.state === "proving" && !!watch.ticket.hash;
  useEffect(() => {
    if (!proving) return;
    let stop = false;
    client.usualProof?.().then((u) => !stop && setUsual(u), () => {});
    client.usualCommitMs?.().then((c) => !stop && setCommitMs(c), () => {});
    const timer = setInterval(() => setSecond(Date.now()), 1000);
    return () => { stop = true; clearInterval(timer); };
  }, [proving, client]);

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
        if (r.ticket.hash) client.txTimes?.(r.ticket.hash).then((t) => !stop && setTimes(t), () => {});
        if (r.ticket.status === "final" || r.ticket.status === "failed") {
          client.info().then((info) => !stop && setLoaded({ state: "ready", info }), () => {});
          setReads((n) => n + 1);
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
    setTimes(null);
    const answer = await client.request(typed, token);
    if (!alive.current) return;
    setSending(false);
    setResult(answer);
    setWidgetRun((n) => n + 1);
    if (answer.kind === "queued") {
      setSentTo(typed);
      setAskedAt(Date.now());
      setWatch({ id: answer.ticket, ticket: null, asked: { position: answer.position, amount: answer.amount }, reachable: true, gone: false });
    }
  }

  const info = loaded.state === "ready" ? loaded.info : null;
  const ticket = watch?.ticket ?? null;
  const failed = ticket?.status === "failed";
  const amount = info ? `${formatCoin(info.amount, coin.decimals)} ${coin.symbol}` : "";

  return (
    <div className="faucet-page">
      <div className="ptitle">
        <h1>Faucet</h1>
        {chain && <span className="muted psub">{[chain.name, `chain ${chain.id}`].filter(Boolean).join(" · ")}</span>}
      </div>
      <div className="fgrid">
        <div className="fcol">
          <section className="card faucet">
            <header className="chead"><h2>Get test {coin.symbol}</h2><span className="muted small">{coin.symbol} is this chain's test coin. It has no value.</span></header>
            <div className="cbody">{body()}</div>
          </section>
          {watch && info && request(info, amount)}
        </div>
        {info && (
          <div className="fcol">
            {limits(info)}
            {faucetCard(info)}
            {sends(info)}
          </div>
        )}
      </div>
    </div>
  );

  function body() {
    if (loaded.state === "loading") return <p className="muted">Looking up the faucet…</p>;
    if (loaded.state === "failed") return <Alert tone="bad" icon="bad" role="alert">{loaded.message}</Alert>;
    const { info } = loaded;
    const window = formatPeriod(info.perAddressSeconds);
    const invalid = result?.kind === "invalid";
    const disabled = sending || cooling || (sentTo !== null && address.trim() === sentTo && !failed);
    const again = askedAt !== null && sentTo !== null && address.trim() === sentTo && result?.kind === "queued" && !failed;

    return (
      <>
        <p className="lead">
          The faucet sends <b>{amount}</b> to an address, {info.perAddressSeconds === 86400 ? "once a day" : `once every ${window}`}.
          {fee !== null && <> At today's fees a plain transfer costs about {formatTiny((BigInt(fee) * 21000n).toString(), coin.decimals)} {coin.symbol}.</>}
        </p>
        {info.on ? (
          <form className="ff" onSubmit={submit} noValidate>
            <label className="small muted" htmlFor={field}>Your address</label>
            <input
              id={field} name="address" className="input mono" type="text" placeholder="0x…" value={address}
              autoComplete="off" autoCapitalize="off" spellCheck={false}
              aria-invalid={invalid} aria-describedby={result && result.kind !== "queued" ? notice : undefined}
              onChange={(e) => { setAddress(e.target.value); if (invalid) setResult(null); }}
            />
            {info.captcha && <div key={widgetRun} className={info.captcha.widgetClass} data-sitekey={info.captcha.siteKey} />}
            <div className="ff-row">
              <button type="submit" className="btn primary" disabled={disabled}><Icon name="drop" size={14} /> {sending ? "Sending…" : `Request ${amount}`}</button>
              {again && <span className="small muted">Taken. You can ask again for this address after {formatMoment(askedAt! + info.perAddressSeconds * 1000)}.</span>}
            </div>
          </form>
        ) : (
          <Alert tone="muted" icon="note" role="status"><b>The faucet is off.</b> It runs only when the explorer is given the faucet's key.</Alert>
        )}
        {result && result.kind !== "queued" && outcome(result, notice)}
        <p className="small muted fnote">Blocks are made only while the chain's builder runs.</p>
      </>
    );
  }

  /** The limits, each from what the faucet says. A limit it does not give is not made up. */
  function limits(info: FaucetInfo) {
    return (
      <section className="card limits">
        <header className="chead"><h2>The limits, in plain words</h2></header>
        <ul className="cbody lim">
          <li><Icon name="drop" /><span>Each request sends <b>{amount}</b>.</span></li>
          <li><Icon name="clock" /><span>One request per <b>address</b> every {formatPeriod(info.perAddressSeconds)}.</span></li>
          {info.perIpSeconds ? <li><Icon name="globe" /><span>One request per <b>network address</b> every {formatPeriod(info.perIpSeconds)}.</span></li> : null}
          {info.maxPerHour ? <li><Icon name="people" /><span>At most <b>{formatCount(info.maxPerHour)} requests an hour</b> for everyone together. When that is reached, the page says when to try again.</span></li> : null}
          <li><Icon name="cube" /><span>Requests are sent in order{info.batch ? <>, up to {formatCount(info.batch)} in one block</> : ""}. A burst waits for the blocks after. The coins count only when the block holding them is final on Canton, and this page says when.</span></li>
          {info.captcha && <li><Icon name="shield" /><span>The human check keeps scripts from emptying the faucet. It is the only thing the faucet asks of you.</span></li>}
        </ul>
      </section>
    );
  }

  /** The faucet's own facts. Where the server does not count one, the row says so. */
  function faucetCard(info: FaucetInfo) {
    const sent = info.sentToday, final = info.finalToday;
    const notFinal = sent !== null && sent !== undefined && final !== null && final !== undefined ? Math.max(0, sent - final) : null;
    return (
      <section className="card">
        <header className="chead"><h2>The faucet</h2></header>
        <dl className="cbody fkv">
          <div><dt>Address</dt><dd>
            {info.address ? (
              <>
                <Link className="hx" to={`/address/${info.address}`} title={info.address}><span className="mono">{shortHash(info.address)}</span></Link>
                <CopyButton value={info.address} what="the faucet's address" />
              </>
            ) : <span className="muted">none: the faucet is off</span>}
          </dd></div>
          <div><dt>Balance</dt><dd>
            {info.balance !== null ? (
              <>
                <b>{formatCoin(info.balance, coin.decimals)} {coin.symbol}</b>{" "}
                <span className="muted small">
                  · {typeof info.balanceBlock === "number" ? `as of block ${formatCount(info.balanceBlock)}` : info.balanceBlock === null ? "as of the newest block, which may not be final" : ""}
                </span>
              </>
            ) : <span className="muted">not known just now</span>}
          </dd></div>
          <div><dt>Queue now</dt><dd>
            {typeof info.queue === "number" ? <><b>{formatCount(info.queue)}</b> <span className="muted small">waiting</span></> : <span className="muted">not served</span>}
            {" "}<span className="muted small">· {typeof info.beingProven === "number" ? `${formatCount(info.beingProven)} being proven` : "being proven: not counted"}</span>
          </dd></div>
          <div><dt>Sent today</dt><dd>
            {typeof sent === "number" ? (
              <>
                <b>{formatCount(sent)}</b>{" "}
                <span className="muted small">· {notFinal === null ? "how many are final: not counted" : notFinal === 0 ? "all final" : `all final but ${formatCount(notFinal)}`}</span>
              </>
            ) : <span className="muted">not counted</span>}
          </dd></div>
        </dl>
      </section>
    );
  }

  /** The faucet address's final transactions, and the request being followed while it is not final. No list of the faucet's other not-final sends is served, so the others are said to be missing. */
  function sends(info: FaucetInfo) {
    const own = ticket && ticket.hash && ticket.status === "sent" ? ticket : null;
    const rows = (recent ?? []).filter((r) => r.hash !== own?.hash);
    return (
      <section className="card">
        <header className="chead"><h2>Recent sends</h2></header>
        {!info.address ? <p className="cbody muted small">The faucet is off, so it has sent nothing from this explorer.</p>
          : recent === null ? <p className="cbody muted small">The faucet's payouts cannot be read just now.</p>
          : !own && rows.length === 0 ? <p className="cbody muted small">No final payout yet.</p>
          : (
            <div className="scroll">
              <table className="tbl">
                <thead><tr><th>Transaction</th><th>To</th><th className="r">Block</th><th>Stage</th></tr></thead>
                <tbody>
                  {own && (
                    <tr className="live">
                      <td><Link className="mono hx" to={`/tx/${own.hash}`} title={own.hash!}>{shortHash(own.hash!)}</Link></td>
                      <td><Link className="mono hx" to={`/address/${own.to}`} title={own.to}>{shortHash(own.to)}</Link></td>
                      <td className="r">{own.block ?? "—"}</td>
                      <td>{chip(own)}</td>
                    </tr>
                  )}
                  {rows.map((r) => (
                    <tr key={r.hash}>
                      <td><Link className="mono hx" to={`/tx/${r.hash}`} title={r.hash}>{shortHash(r.hash)}</Link><span className="ago">{ago(new Date(r.timestamp * 1000).toISOString(), now)}</span></td>
                      <td><Link className="mono hx" to={`/address/${r.to}`} title={r.to}>{shortHash(r.to)}</Link></td>
                      <td className="r"><Link to={`/block/${r.block}`}>{r.block}</Link></td>
                      <td><span className="chip chip-final"><i className="dot" />Final</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        <p className="cfoot small muted">Final payouts only, read from the faucet's address. Sends that are not final yet are not listed here, except your own request.</p>
      </section>
    );
  }

  /** The state of a followed request as a chip. */
  function chip(t: Ticket | null) {
    const [tone, word] =
      t?.status === "final" ? ["final", "Final"] : t?.status === "failed" ? ["failed", "Failed"]
      : t?.status === "sent" ? (t.state === "dropped" ? ["waiting", "Not followed"] : t.state === "proving" ? ["proving", "Being proven"] : ["waiting", "Waiting"])
      : ["waiting", "Queued"];
    return <span className={`chip chip-${tone}`}><i className="dot" />{word}</span>;
  }

  /** The four steps of a request. "Final on Canton" is the only word of success, and a step is done only when the explorer says it is. */
  function request(info: FaucetInfo, amount: string) {
    if (!watch) return null;
    const t = ticket, status = t?.status ?? "queued";
    const proving = status === "sent" && t?.state === "proving";
    const dropped = status === "sent" && t?.state === "dropped";
    const sent = status === "sent" || status === "final";
    const tx = t?.hash ? <> Transaction <Link className="hx" to={`/tx/${t.hash}`} title={t.hash}><span className="mono">{shortHash(t.hash)}</span></Link><CopyButton value={t.hash} what="transaction hash" /></> : null;
    const place = t?.position ?? watch.asked.position;
    const block = t?.block !== null && t?.block !== undefined ? ` in block ${formatCount(t.block)}` : "";
    type Step = { state: "done" | "active" | "todo" | "bad"; title: string; detail: ReactNode; at?: string | null; extra?: ReactNode };
    // The times are the explorer's own, from the transaction route; a time it does not serve is not drawn. Queued has none: the page's own clock is not the chain's.
    const stamp = (iso: string | null | undefined) => (iso ? clock(iso, 3) : null);
    const startedAt = times?.proofStartedAt ?? null;
    const elapsed = startedAt ? Math.max(0, second - instant(startedAt)) : null;
    const range = usual ? `${(usual.lowMs / 1000).toFixed(1)}–${(usual.highMs / 1000).toFixed(1)} s` : null;
    // Final is the proof's end, the send to Canton and Canton's commit; with either usual time unknown there is no estimate, never a partial one.
    const expected = proving && startedAt && usual && commitMs !== null ? new Date(instant(startedAt) + (usual.lowMs + usual.highMs) / 2 + commitMs).toISOString() : null;
    const commitClause = commitMs !== null ? ` Then Canton commits in about ${secs(commitMs, 1)}.` : "";
    const nonce = times?.nonce !== null && times?.nonce !== undefined ? `, nonce ${times.nonce},` : "";
    const steps: Step[] = [
      status === "queued"
        ? { state: "active", title: "Queued", detail: place <= 1 ? "Taken by the faucet. No one is ahead of you." : `You are number ${formatCount(place)} in line. The faucet sends in batches.` }
        : { state: "done", title: "Queued", detail: "Taken by the faucet." },
      failed
        ? { state: "bad", title: "Not sent", detail: <>{(t?.reason ?? "The transfer did not happen.").slice(0, REASON_MAX)} Nothing was taken from you, and you may ask again.</> }
        : dropped
          ? { state: "active", title: "Sent, not followed", detail: <>The explorer stopped following it, and the chain may still take it.{tx} Look at the address's balance in a few minutes. Your turn is used until then.</> }
          : sent
            ? { at: stamp(times?.acceptedAt), state: "done", title: "Sent", detail: <>{tx ?? "The transfer"}{nonce} {status === "final" || proving ? "went to the chain." : "is in the pool, waiting for the next block."}</> }
            : { state: "todo", title: "Sent", detail: "The transfer goes to the chain in the next batch." },
      status === "final" ? { state: "done", title: `Proven${block}`, detail: "The proof was checked and the block was committed." }
        : proving ? {
          at: stamp(startedAt), state: "active", title: `Being proven${block}`,
          detail: <>A proof of the block is being made. It is not final until Canton has committed it.{elapsed !== null && ` ${secs(elapsed, 1)} so far.`}{range && ` A proof usually takes ${range}.`}{commitClause}</>,
          extra: elapsed !== null && usual ? <i className="pbar" role="progressbar" aria-label="How far the proof has got, against how long a proof usually takes" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round((elapsed / Math.max(1, usual.highMs)) * 100))}><b style={{ width: `${Math.min(100, (elapsed / Math.max(1, usual.highMs)) * 100)}%` }} /></i> : null,
        }
        : { state: "todo", title: "Being proven", detail: "The block holding the transfer is proven." },
      status === "final" ? { at: stamp(times?.finalAt), state: "done", title: "Final on Canton", detail: <>{amount} is final on Canton{block}. The coins are yours, and the balance shown everywhere includes them.</> }
        : { at: expected ? `about ${clock(expected, 3).slice(0, 8)}` : null, state: "todo", title: "Final on Canton", detail: "Then the coins are yours, and the balance shown everywhere includes them." },
    ];
    if (watch.gone) {
      return (
        <section className="card request">
          <header className="chead"><h2>Your request</h2></header>
          <div className="cbody"><Alert tone="muted" icon="note" role="status"><b>The explorer no longer knows this request.</b> Look at the address's balance, or ask again.</Alert></div>
        </section>
      );
    }
    return (
      <section className="card request" aria-label="Your request">
        <header className="chead rq">
          <Icon name="drop" size={16} />
          <div><h2>Your request</h2><span className="muted small">ticket <span className="mono">{watch.id.slice(0, 24)}</span> · {amount} to <span className="mono" title={watch.ticket?.to ?? sentTo ?? ""}>{shortHash(t?.to ?? sentTo ?? "")}</span></span></div>
          {chip(t)}
        </header>
        <ol className="steps" role="status">
          {steps.map((st, i) => (
            <li key={i} className={`step step-${st.state}`}>
              <i className="smark" aria-hidden="true">{st.state === "done" ? <Icon name="ok" size={12} /> : st.state === "bad" ? <Icon name="bad" size={12} /> : st.state === "active" ? <Icon name="clock" size={12} /> : null}</i>
              <div><div className="srow"><b>{st.title}</b>{st.at && <time className="stime mono">{st.at}</time>}</div><span className="small muted">{st.detail}</span>{st.extra}</div>
            </li>
          ))}
        </ol>
        {!watch.reachable && <p className="cbody small muted">The explorer cannot be reached just now. This page keeps asking.</p>}
        <p className="cfoot small muted">This card updates by itself. You can leave the page: the request goes on, and the transaction's page shows the same steps.</p>
      </section>
    );
  }

  function outcome(r: CoinResult | { kind: "invalid" }, id: string) {
    switch (r.kind) {
      case "limit":
      case "full":
        return <Alert tone="wait" icon="note" role="alert" id={id}><b>{r.message}</b> {retry(r.waitSeconds)}</Alert>;
      case "captcha":
      case "problem":
        return <Alert tone="bad" icon="bad" role="alert" id={id}>{r.message}</Alert>;
      case "invalid":
        return <Alert tone="bad" icon="bad" role="alert" id={id}>{NOT_AN_ADDRESS}</Alert>;
      case "queued":
        return null;
    }
  }
}

const retry = (wait: number | null) => (wait === null ? "Try again later." : `Try again in ${formatWait(wait)}.`);
