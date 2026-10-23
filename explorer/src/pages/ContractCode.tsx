import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { getContractSource, type ContractDetail, type ContractSource } from "../api.ts";
import { decodeArgs, signature, type AbiEntry, type AbiParam } from "../abi.ts";
import { ErrorCard, LoadingCard } from "../components/Cards.tsx";
import { CopyButton, HashLink } from "../components/HashLink.tsx";
import { Item, Kv } from "../components/Kv.tsx";
import { count, plural } from "../format.ts";
import { disassemble } from "../opcodes.ts";
import { useStatus } from "../useStatus.ts";
import { evmVersionNote, forgeCommand, MatchChip } from "./ContractParts.tsx";

const SHOWN_HEX = 1200;
const SHOWN_OPS = 200;

/** Source and JSON are text: each line is a text node, so nothing in it is ever read as markup. */
function Lines({ text }: { text: string }) {
  return <pre className="src">{text.split("\n").map((l, i) => <div key={i}><span className="ln">{i + 1}</span>{l}</div>)}</pre>;
}
const Json = ({ value }: { value: unknown }) => <pre className="dark">{JSON.stringify(value, null, 2)}</pre>;

function Segmented<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: readonly T[]; onPick: (v: T) => void }) {
  return <div className="seg" role="group" aria-label={label}>{options.map((o) => <button key={o} type="button" aria-pressed={o === value} onClick={() => onPick(o)}>{o}</button>)}</div>;
}

function Sources({ s }: { s: ContractSource }) {
  const chain = useStatus().data?.chainName ?? "This chain";
  const note = evmVersionNote(s.evmVersion, chain);
  const files = [...s.files].sort((a, b) => Number(b.path === s.contractPath) - Number(a.path === s.contractPath));
  const [path, setPath] = useState<string | null>(null);
  const open = files.find((f) => f.path === path) ?? files[0];
  const format = s.codeFormat === "solidity-standard-json-input" ? `Standard JSON input, ${plural(files.length, "file")}` : s.codeFormat === "solidity-single-file" ? "Single file" : s.codeFormat;
  const name = s.contractName ?? "contract";
  const libs = !!s.libraries && Object.keys(s.libraries as object).length > 0;
  const download = "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(Object.fromEntries(files.map((f) => [f.path, f.content])), null, 2));
  return (
    <section className="card" aria-label="Contract source code">
      <div className="list-h">
        <h2>Contract source code <MatchChip matchType={s.matchType} /></h2>
        <a className="btn-line" href={download} download={`${name}-sources.json`}>Download sources</a>
      </div>
      {s.matchNote && <p className="small muted card-note">{s.matchNote}</p>}
      <div className="code-cols">
        <Kv label="The compile">
          <Item label="Contract name"><span className="mono">{s.contractName}</span></Item>
          <Item label="Compiler"><span className="mono">{s.compilerVersion && /^\d/.test(s.compilerVersion) ? `v${s.compilerVersion}` : s.compilerVersion}</span></Item>
          <Item label="Optimization">{s.optimizerEnabled === null ? <span className="muted">Not recorded</span> : s.optimizerEnabled ? `Yes, ${count(s.optimizerRuns ?? 0)} runs` : "No"}</Item>
          <Item label="EVM version">{s.evmVersion ? <><span className="mono">{s.evmVersion}</span>{note && <span className="muted small"> · {note}</span>}</> : <span className="muted">Compiler default</span>}</Item>
          <Item label="License">{s.license ?? <span className="muted">None given</span>}</Item>
          <Item label="Source format">{format}</Item>
          {libs && <Item label="Libraries"><span className="mono">{JSON.stringify(s.libraries)}</span></Item>}
        </Kv>
        <div>
          <div className="files" role="group" aria-label="Source files">
            {files.map((f) => <button key={f.path} type="button" className="chip chip-kind" aria-pressed={f.path === open?.path} onClick={() => setPath(f.path)}>{f.path}</button>)}
          </div>
          {open ? <Lines text={open.content} /> : <p className="muted">The verification kept no source files.</p>}
        </div>
      </div>
    </section>
  );
}

function Abi({ abi }: { abi: unknown }) {
  const [view, setView] = useState<"JSON" | "Text">("JSON");
  if (!Array.isArray(abi)) return null;
  const text = (abi as AbiEntry[]).map(signature).join("\n");
  return (
    <section className="card" aria-label="Contract ABI">
      <div className="list-h">
        <h2>Contract ABI <span className="muted thin">{plural(abi.length, "entry", "entries")}</span></h2>
        <span className="row-gap"><CopyButton value={view === "JSON" ? JSON.stringify(abi, null, 2) : text} label="Copy the ABI" /><Segmented label="ABI view" value={view} options={["JSON", "Text"] as const} onPick={setView} /></span>
      </div>
      {view === "JSON" ? <Json value={abi} /> : <pre className="dark">{text}</pre>}
    </section>
  );
}

function Constructor({ s }: { s: ContractSource }) {
  const ctor = Array.isArray(s.abi) ? (s.abi as AbiEntry[]).find((e) => e.type === "constructor") : undefined;
  if (!s.constructorArgs || s.constructorArgs === "0x") return <p className="muted small">The contract was made with no constructor arguments.</p>;
  const decoded = ctor?.inputs ? decodeArgs(ctor.inputs as AbiParam[], s.constructorArgs) : null;
  return (
    <>
      <h3>Constructor arguments</h3>
      {ctor && <div className="ctor"><code className="mono">{signature(ctor)}</code></div>}
      {decoded
        ? <table className="tbl"><tbody>{decoded.map((a, i) => (
          <tr key={i}><td className="muted">{i}</td><td className="mono">{a.name}</td><td className="muted mono">{a.type}</td>
            <td>{a.type === "address" ? <HashLink value={a.value} to={`/address/${a.value}`} /> : <span className="mono wrap">{a.value}</span>}</td></tr>
        ))}</tbody></table>
        : <><p className="muted small">These cannot be read word by word here, so this is the raw value.</p><pre className="dark wrap">{s.constructorArgs}</pre></>}
    </>
  );
}

function Settings({ s }: { s: ContractSource }) {
  return (
    <section className="card" aria-label="Compiler settings">
      <h2>Compiler settings <span className="muted thin">as given at verification</span></h2>
      {s.settings ? <Json value={s.settings} /> : <p className="muted">No settings were kept.</p>}
      <Constructor s={s} />
    </section>
  );
}

function Deployed({ detail }: { detail: ContractDetail }) {
  const [view, setView] = useState<"Hex" | "Opcodes">("Hex");
  const size = (detail.code.length - 2) / 2;
  const ops = view === "Opcodes" ? disassemble(detail.code, SHOWN_OPS) : null;
  const cut = detail.code.length > SHOWN_HEX;
  return (
    <section className="card" aria-label="Deployed code">
      <div className="list-h">
        <h2>Deployed code <span className="muted thin">{count(size)} bytes, the explorer's copy of the code at this address · hash <span className="mono">{detail.codeHash.slice(0, 10)}…{detail.codeHash.slice(-4)}</span></span></h2>
        <span className="row-gap"><CopyButton value={detail.code} label="Copy the code" /><Segmented label="Code view" value={view} options={["Hex", "Opcodes"] as const} onPick={setView} /></span>
      </div>
      {ops
        ? <pre className="light">{ops.ops.map((o) => `${String(o.pc).padStart(5, "0")}  ${o.name}${o.data ? " " + o.data : ""}`).join("\n")}{ops.more ? `\n… the first ${count(SHOWN_OPS)} opcodes of the code` : ""}</pre>
        : <pre className="light wrap">{cut ? detail.code.slice(0, SHOWN_HEX) + `… (${count(size)} bytes)` : detail.code}</pre>}
    </section>
  );
}

/** How to verify a contract that is not: the tools already used, aimed at this explorer's own Etherscan-compatible door. */
function HowToVerify({ detail, chainId }: { detail: ContractDetail; chainId: number | undefined }): ReactNode {
  return (
    <section className="card" aria-label="Verify this contract">
      <h2>Verify this contract</h2>
      <p>The source of this contract is not verified. Verify it with the tools you already use; the source is compiled in a sandbox and matched against the code on chain.</p>
      {chainId !== undefined && <pre className="dark wrap">{forgeCommand(detail.address, "<path/to/File.sol>:<ContractName>", chainId)}</pre>}
      <p className="small muted">Hardhat's <code className="mono">customChains</code> works the same way, with <code className="mono">{window.location.origin}/api</code> as the API URL. The routes are in the <Link to="/docs/api">API</Link> page.</p>
    </section>
  );
}

/** What is known of the code at the address: its source and compile when verified, the way to verify when not, and the deployed code either way. */
export function CodeTab({ detail, chainId }: { detail: ContractDetail; chainId: number | undefined }) {
  const q = useQuery({ queryKey: ["contract-source", detail.address, detail.matchType], queryFn: () => getContractSource(detail.address) });
  if (q.error && !q.data) return <ErrorCard message={q.error.message} retrying />;
  if (!q.data) return <LoadingCard>Reading the source…</LoadingCard>;
  const s = q.data;
  return (
    <div className="code-tab">
      {s.verified ? (
        <>
          <Sources s={s} />
          <div className="code-pair"><Abi abi={s.abi} /><Settings s={s} /></div>
        </>
      ) : <HowToVerify detail={detail} chainId={chainId} />}
      <Deployed detail={detail} />
    </div>
  );
}
