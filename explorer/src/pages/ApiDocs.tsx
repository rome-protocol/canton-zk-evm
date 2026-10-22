import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { getOpenApi, type OpenApiDoc } from "../api.ts";
import { AddToWallet } from "../components/AddToWallet.tsx";
import { copyText } from "../components/HashLink.tsx";
import { Icon } from "../components/Icon.tsx";
import { useStatus } from "../useStatus.ts";
import "./api-docs.css";

/** The Etherscan modules the compatible API answers, and the actions of each (the approved screen). None is built yet: E8a builds them. */
const MODULES: ReadonlyArray<readonly [module: string, actions: readonly string[]]> = [
  ["account", ["balance", "balancemulti", "txlist", "txlistinternal", "tokentx", "tokennfttx", "token1155tx", "tokenbalance", "getminedblocks"]],
  ["contract", ["getabi", "getsourcecode", "getcontractcreation", "verifysourcecode", "checkverifystatus", "verifyproxycontract", "checkproxyverification"]],
  ["transaction", ["getstatus", "gettxreceiptstatus"]],
  ["block", ["getblockreward", "getblocknobytime", "getblockcountdown"]],
  ["logs", ["getLogs"]],
  ["token", ["tokenholderlist", "tokenholdercount", "tokeninfo"]],
  ["stats", ["ethsupply", "tokensupply", "ethprice"]],
  ["proxy", ["eth_blockNumber", "eth_getBlockByNumber", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call", "eth_getCode", "eth_sendRawTransaction", "eth_estimateGas"]],
  ["gastracker", ["gasoracle", "gasestimate"]],
];
const SOON = "coming with E8a";

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

const firstSentence = (s: string) => /^.*?[.!?](?=\s|$)/s.exec(s)?.[0] ?? s;

/** One row for each method of each route in the description, in the order the description gives; `{id}` is drawn `:id`. */
function routes(doc: OpenApiDoc): { method: string; path: string; about: string }[] {
  return Object.entries(doc.paths ?? {}).flatMap(([path, ops]) =>
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
        : <table className="api-table" aria-label="REST routes"><tbody>
            {rows.map((r) => (
              <tr key={r.method + r.path}><td><span className={`verb verb-${r.method.toLowerCase()}`}>{r.method}</span></td><td className="mono">{r.path}</td><td className="muted">{r.about}</td></tr>
            ))}
          </tbody></table>}
    </section>
  );
}

function Limits({ doc, rpc }: { doc?: OpenApiDoc; rpc: boolean }) {
  const l = doc?.info?.["x-limits"];
  const rows: [string, string][] = [];
  if (rpc && l?.rpcPerMinute) rows.push(["JSON-RPC", `${l.rpcPerMinute} a minute`]);
  if (l?.pageSize) rows.push(["Page size", `at most ${l.pageSize} a page`]);
  return (
    <section className="card api-limits" aria-labelledby="limits-h">
      <header className="api-head"><h2 id="limits-h">Rate limits</h2><span className="muted small">per client</span></header>
      <dl className="api-kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="muted small pad">Over the limit: HTTP 429 with Retry-After.</p>
    </section>
  );
}

export function ApiDocs() {
  const st = useStatus();
  const doc = useQuery({ queryKey: ["openapi"], queryFn: getOpenApi, retry: false, staleTime: 60_000 });
  const s = st.data, origin = location.origin, id = s?.chainId;
  const name = s?.chainName ?? "this chain";
  const request = `GET ${origin}/api\n    ?module=account&action=balance\n    &address=<address>\n    &tag=latest`;
  const answer = `{\n  "status": "1",\n  "message": "OK",\n  "result": "<balance in wei, a decimal string>"\n}`;
  const foundry = `# verify a contract, as on Etherscan\nforge verify-contract <address> \\\n  src/<File>.sol:<Contract> \\\n  --chain-id ${id ?? ""} \\\n  --verifier etherscan \\\n  --verifier-url ${origin}/api \\\n  --etherscan-api-key any`;
  const hardhat = `etherscan: {\n  apiKey: { ${name.toLowerCase().replace(/\W+/g, "") || "chain"}: "any" },\n  customChains: [{\n    network: "${name.toLowerCase().replace(/\W+/g, "") || "chain"}", chainId: ${id ?? ""},\n    urls: { apiURL: "${origin}/api", browserURL: "${origin}" }\n  }]\n}`;
  return (
    <>
      <div className="ptitle"><h1>API</h1> <span className="muted">No keys. Every answer is built only from final data, except where it says not final.</span></div>
      <div className="api-intro">
        <div className="card"><h2><Icon name="expand" size={15} /> Etherscan-compatible</h2><p className="muted small">For Foundry, Hardhat, cast and ethers. Same requests and answers as Etherscan, at <span className="mono">/api</span>. {SOON}.</p></div>
        <div className="card"><h2><Icon name="next" size={15} /> REST</h2><p className="muted small">What this site&apos;s pages read, including the Canton record and each transaction&apos;s lifecycle. Described in <span className="mono">/api/openapi.json</span>.</p></div>
        <div className="card"><h2><Icon name="link" size={15} /> JSON-RPC</h2><p className="muted small">Standard Ethereum JSON-RPC at <span className="mono">/rpc</span>. It serves final blocks only, and sends your transactions on.</p></div>
      </div>
      <section className="card api-eth" aria-labelledby="eth-h">
        <div className="api-eth-main">
          <header className="api-head"><h2 id="eth-h">Etherscan-compatible API</h2>
            <span className="muted mono small">{origin}/api · apikey is accepted and ignored{id ? ` · chainid, if given, must be ${id}` : ""}</span></header>
          <table className="api-table" aria-label="Etherscan-compatible modules"><tbody>
            {MODULES.map(([m, actions]) => (
              <tr key={m}><td className="mod mono">{m}</td><td>{actions.map((a) => <span key={a} className="mchip mono">{a}</span>)}</td><td className="soon small muted">{SOON}</td></tr>
            ))}
          </tbody></table>
        </div>
        <div className="api-eth-side">
          <p className="muted small">Example: an address&apos;s balance <span className="soon">({SOON})</span></p>
          <pre className="api-pre mono" aria-label="Example request">{request}</pre>
          <p className="muted small">Answer</p>
          <pre className="api-pre mono" aria-label="Example answer">{answer}</pre>
          <p className="muted small">Balances are read from the chain at the newest final block. Numbers are decimal strings, as Etherscan gives them.</p>
        </div>
      </section>
      {/* The blocks carry the chain id, so they wait for the status rather than show a blank one. */}
      {s && <div className="api-two">
        <Code title="Foundry" label="foundry" text={foundry} />
        <Code title="Hardhat" note="hardhat.config" label="hardhat" text={hardhat} />
      </div>}
      <div className="api-two api-lower">
        <Rest doc={doc.data} failed={doc.isError} />
        <div className="api-side">
          {s && <AddToWallet status={s} />}
          <Limits doc={doc.data} rpc={!!s?.publicRpc} />
        </div>
      </div>
    </>
  );
}
