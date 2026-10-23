import { useQuery } from "@tanstack/react-query";
import { Fragment, useRef, useState } from "react";
import { getContract, getContractList, getFaucetInfo, getOpenApi, type ApiStatus, type OpenApiDoc } from "../api.ts";
import { addNetwork, rpcUrl } from "../wallet.ts";
import { copyText } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { useStatus } from "../useStatus.ts";
import "./api-docs.css";

/** A block of code with a Copy button; the button copies exactly the text drawn. */
function Code({ title, note, label, text }: { title: string; note?: string; label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  return (
    <section className="card api-code" aria-labelledby={`${label}-h`} role="region">
      <header className="api-head">
        <h2 id={`${label}-h`}>{title}</h2>{note && <span className="muted mono small">{note}</span>}
        <button type="button" className="api-copy" onClick={async () => {
          if (!(await copyText(text))) return;
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        }}><Icon name={copied ? "check" : "copy"} size={13} />{copied ? "Copied" : "Copy"}</button>
      </header>
      <pre className="api-pre mono" aria-label={`${title} setup`}>{text}</pre>
    </section>
  );
}

/** Words from the server that are drawn in a line of one: bounded, so that a long one cannot widen the page. */
const clip = (v: string, n = 40) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^\d{1,80}$/;
const SOURCE_PATH = /^[\w@./-]{1,120}$/, SOURCE_NAME = /^\w{1,80}$/;

/** The network's details, the way a wallet asks for them, and the button that asks the wallet to add it. Nothing where the explorer serves no public RPC. */
function WalletCard({ status }: { status: ApiStatus }) {
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  if (!status.publicRpc) return null;
  const url = rpcUrl(), name = clip(status.chainName);
  const add = async () => setNote(await addNetwork(status, name, "above"));
  const rows: [string, React.ReactNode][] = [
    ["Network name", `${name} ${clip(status.networkName ?? "", 20)}`.trim()],
    ["RPC address", <><span className="mono">{url}</span><button type="button" className="copy" aria-label={copied ? "Copied" : "Copy the RPC address"} onClick={async () => {
      if (!(await copyText(url))) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }}><Icon name={copied ? "check" : "copy"} size={13} /></button></>],
    ["Chain id", <>{status.chainId} <span className="muted small">· 0x{status.chainId.toString(16)}</span></>],
    ["Coin", `${clip(status.coin.symbol, 12)}, ${status.coin.decimals} decimals`],
    ["Explorer", <span className="mono">{location.origin}</span>],
    ["Final only", "\"latest\" is the newest final block; a block being proven is not served"],
  ];
  return (
    <section className="card api-wallet" aria-labelledby="rpc-h">
      <header className="api-head"><h2 id="rpc-h">Add {name} to your wallet</h2></header>
      <table className="api-table api-details" aria-label="Wallet details"><tbody>
        {rows.map(([k, v]) => <tr key={k}><td className="muted">{k}</td><td>{v}</td></tr>)}
      </tbody></table>
      <div className="api-add"><button type="button" className="rpc-btn" onClick={add}>Add {name} to your wallet</button><span className="muted small">asks your wallet to add the network</span></div>
      <div className="rpc-msg" role="status">{note}</div>
    </section>
  );
}

const firstSentence = (s: string) => /^.*?[.!?](?=\s|$)/s.exec(s)?.[0] ?? s;

/** One row for each method of each route in the description, in the order the description gives; `{id}` is drawn `:id`. */
function routes(doc: OpenApiDoc): { method: string; path: string; about: string }[] {
  return Object.entries(doc.paths ?? {}).filter(([path]) => path !== "/api" && path !== "/v2/api").flatMap(([path, ops]) =>
    (["get", "post"] as const).filter((m) => ops[m]).map((m) => ({ method: m.toUpperCase(), path: path.replace(/\{(\w+)\}/g, ":$1"), about: firstSentence(ops[m]!.summary ?? "") })));
}

function Rest({ doc, failed }: { doc?: OpenApiDoc; failed: boolean }) {
  const rows = doc ? routes(doc) : [];
  const page = doc?.info?.["x-limits"]?.pageSize;
  return (
    <section className="card api-rest" aria-labelledby="rest-h">
      <header className="api-head">
        <h2 id="rest-h">REST API</h2>
        <span className="muted small">the routes this site uses{page ? `; lists are keyset-paginated, at most ${page} a page` : ""}</span>
        <a className="api-copy" href="/api/openapi.json" download="openapi.json"><Icon name="down" size={13} />openapi.json</a>
      </header>
      {failed ? <p className="muted pad">The routes cannot be read right now. The description is at /api/openapi.json.</p>
        : !doc ? <p className="muted pad">Reading…</p>
        : <div className="scroll"><table className="api-table" aria-label="REST routes"><tbody>
            {rows.map((r) => (
              <tr key={r.method + r.path}><td><span className={`verb verb-${r.method.toLowerCase()}`}>{r.method}</span></td><td className="mono">{r.path}</td><td className="muted">{r.about}</td></tr>
            ))}
          </tbody></table></div>}
    </section>
  );
}

function Limits({ doc, rpc }: { doc?: OpenApiDoc; rpc: boolean }) {
  const l = doc?.info?.["x-limits"];
  const rows: [string, string][] = [];
  if (l?.rest) rows.push(["Site routes (REST)", `${l.rest.perSecond} a second, bursts of ${l.rest.burst}`]);
  if (rpc && l?.rpcPerMinute) rows.push(["JSON-RPC", `${l.rpcPerMinute} a minute`]);
  if (l?.etherscan && etherscanDoor(doc)) rows.push(["Etherscan-compatible", `${l.etherscan.perSecond} a second and ${l.etherscan.perMinute} a minute`]);
  if (l?.verification && etherscanDoor(doc)) rows.push(["Verification", `${l.verification.perHour} an hour, ${l.verification.maxBodyKb} KB a request`]);
  if (l?.streams) rows.push(["Live streams", `${l.streams.perClient} open at a time`]);
  if (l?.pageSize) rows.push(["Page size", `at most ${l.pageSize} a page`]);
  return (
    <section className="card api-limits" aria-labelledby="limits-h">
      <header className="api-head"><h2 id="limits-h">Rate limits</h2><span className="muted small">per client</span></header>
      <dl className="api-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="muted small pad">Over the limit: HTTP 429 with Retry-After{etherscanDoor(doc) ? "; the Etherscan-compatible API answers as Etherscan does, with status 0" : ""}.</p>
    </section>
  );
}

/** The modules the server's description lists for the Etherscan-compatible door, or null while it does not serve one. */
const etherscanDoor = (doc?: OpenApiDoc): [string, string[]][] | null => {
  const door = doc?.paths?.["/api"]?.get;
  return door ? Object.entries(door["x-modules"] ?? {}) : null;
};

export function ApiDocs() {
  const st = useStatus();
  const doc = useQuery({ queryKey: ["openapi"], queryFn: getOpenApi, retry: false, staleTime: 60_000 });
  const s = st.data, origin = location.origin, id = s?.chainId, modules = etherscanDoor(doc.data);
  const name = clip(s?.chainName ?? "this chain");
  // The faucet's own address and its balance at the final head are real, so the example is a real answer; where the faucet is off the examples keep placeholders.
  const f = useQuery({ queryKey: ["faucet-info"], queryFn: getFaucetInfo, staleTime: 30_000 }).data;
  const example = f?.on && f.address && ADDRESS.test(f.address) ? f.address : null;
  // The route answers from the final head, so only a balance read at a named final block is the answer it would give.
  const exBalance = example && f?.balance && typeof f.balanceBlock === "number" && DECIMAL.test(f.balance) ? f.balance : null;
  // The verify example is a real one: the chain's most used verified contract, by its address and the source path and name it was verified with. Nothing is named where there is none.
  const top = useQuery({ queryKey: ["api-verified-contract"], queryFn: async () => { const [c] = (await getContractList("interactions", true, null, 1)).items; return c && ADDRESS.test(c.address) ? getContract(c.address) : null; }, staleTime: 60_000, retry: false }).data;
  const v = top?.verification;
  const verified = top && v && SOURCE_PATH.test(v.contractPath) && SOURCE_NAME.test(v.contractName) ? { address: top.address, file: `${v.contractPath}:${v.contractName}` } : null;
  const request = `GET ${origin}/api\n    ?module=account&action=balance\n    &address=${example ?? "<address>"}\n    &tag=latest`;
  const answer = `{\n  "status": "1",\n  "message": "OK",\n  "result": "${exBalance ?? "<balance in wei, a decimal string>"}"\n}`;
  const foundry = `# verify a contract, as on Etherscan\nforge verify-contract ${verified?.address ?? "<address>"} \\\n  ${verified?.file ?? "src/<File>.sol:<Contract>"} \\\n  --chain-id ${id ?? ""} \\\n  --verifier etherscan \\\n  --verifier-url ${origin}/api \\\n  --etherscan-api-key any`;
  const hardhat = `etherscan: {\n  apiKey: { ${name.toLowerCase().replace(/\W+/g, "") || "chain"}: "any" },\n  customChains: [{\n    network: "${name.toLowerCase().replace(/\W+/g, "") || "chain"}", chainId: ${id ?? ""},\n    urls: { apiURL: "${origin}/api",\n            browserURL: "${origin}" }\n  }]\n}`;
  return (
    <>
      <div className="ptitle"><h1>API</h1> <span className="muted">No keys. Every answer is built only from final data, except where it says not final.</span></div>
      <div className="api-intro">
        <div className="card"><h2><Icon name="expand" size={15} /> Etherscan-compatible</h2><p className="muted small">{modules ? <>For Foundry, Hardhat, cast and ethers. Same requests and answers as Etherscan, at <span className="mono">/api</span>.</> : "The Etherscan-compatible API is not served yet."}</p></div>
        <div className="card"><h2><Icon name="next" size={15} /> REST</h2><p className="muted small">What this site&apos;s pages read, including the Canton record and each transaction&apos;s lifecycle. Described in <span className="mono">/api/openapi.json</span>.</p></div>
        <div className="card"><h2><Icon name="link" size={15} /> JSON-RPC</h2><p className="muted small">Standard Ethereum JSON-RPC at <span className="mono">/rpc</span>. It serves final blocks only, and sends your transactions on.</p></div>
      </div>
      {modules && <section className="card api-eth" aria-labelledby="eth-h">
        <div className="api-eth-main">
          <header className="api-head"><h2 id="eth-h">Etherscan-compatible API</h2>
            <span className="muted mono small">{origin}/api · apikey is accepted and ignored{id ? ` · chainid, if given, must be ${id}` : ""}</span></header>
          <div className="scroll"><table className="api-table" aria-label="Etherscan-compatible modules"><tbody>
            {modules.map(([m, actions]) => (
              <tr key={m}><td className="mod mono">{m}</td><td>{actions.map((a) => <Fragment key={a}><span className="mchip mono">{clip(a, 60)}</span>{" "}</Fragment>)}</td></tr>
            ))}
          </tbody></table></div>
        </div>
        <div className="api-eth-side">
          <p className="muted small">Example: an address&apos;s balance</p>
          <pre className="api-pre mono" aria-label="Example request">{request}</pre>
          <p className="muted small">Answer</p>
          <pre className="api-pre mono" aria-label="Example answer">{answer}</pre>
          <p className="muted small">Balances are read from the chain at the newest final block. Numbers are decimal strings, as Etherscan gives them.</p>
        </div>
      </section>}
      {/* The blocks carry the chain id, so they wait for the status rather than show a blank one. */}
      {s && modules && <div className="api-two">
        <Code title="Foundry" label="foundry" text={foundry} />
        <Code title="Hardhat" note="hardhat.config" label="hardhat" text={hardhat} />
      </div>}
      <div className="api-two api-lower">
        <Rest doc={doc.data} failed={doc.isError} />
        <div className="api-side">
          {s && <WalletCard status={s} />}
          <Limits doc={doc.data} rpc={!!s?.publicRpc} />
        </div>
      </div>
    </>
  );
}
