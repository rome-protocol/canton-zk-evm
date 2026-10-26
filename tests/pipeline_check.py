#!/usr/bin/env python3
"""What tests/network_pipeline.sh checks, from the builder's journal and from the two chains.

  pipeline_check.py journal <journal folder> [--sent FILE] [--blocks N]   the journal alone (and the sent transactions, one hash a line, when
                                                                            given): prints the violations and exits 1 if there is one
  pipeline_check.py stats <journal folder> [--proved FILE]                  one JSON line: what the faults left in the journal (FILE: the prover's log)
  pipeline_check.py inflight <journal folder>                               the attempts of the newest run that are still going, "<run> <attempt>" a line
  pipeline_check.py closed <journal folder> <file from inflight>            exits 1 while one of them has no final, cancelled or resolved line and is not committed
  pipeline_check.py chain <journal folder> [--sent FILE]                    reth against the journal, block by block: the block at each committed
                                                                            height is the one the journal says Canton took, and each sent
                                                                            transaction is in it, at or below reth's finalized block
  pipeline_check.py watch <out file> <stop file>                            samples Canton's head and reth's finalized block every second until
                                                                            the stop file exists; each disagreement is a line of <out file>
  pipeline_check.py settled                                                 once: Canton's head is reth's finalized block, hash for hash

`watch` and `settled` read Canton as the builder does (the builder's own environment: CZE_LEDGER_USER, CZE_BUILDER_PARTY, CZE_FEE_RECIPIENT,
CZE_LEDGER_URL, CZE_STATE_DIR, and CZE_READ_AS, the parties it reads as, separated by spaces) and reth on RETH_HTTP_PORT (8545).

The rules the journal must keep (builder/README.md, "The journal"):
  1. A height is committed once at most, and the committed heights have no gap.
  2. A height is submitted again only after the earlier attempt at it ended without a commit: never while its command is in doubt.
  3. A block is submitted only after every lower height it was built on is settled: a height is not submitted while an earlier one is unanswered.
  4. Every committed block was seen final. No transaction is in two committed blocks, and no `lost` line names a transaction.
  5. Every transaction sent is in a committed block."""
import json, os, sys, time, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def read_journal(folder) -> list:
    lines = []
    for path in sorted(Path(folder).glob("*.jsonl")):
        for raw in path.read_text().splitlines():
            try:
                lines.append(json.loads(raw))
            except ValueError:
                continue   # a line cut short by a crash
    return lines


def attempts_of(lines: list) -> dict:
    """(run, attempt) -> what the journal says of the attempt."""
    out: dict = {}
    for ln in lines:
        name, attempt = ln.get("event"), ln.get("attempt")
        if attempt is None:
            continue
        key = (ln.get("attempt_run") or ln["run"], attempt)
        a = out.setdefault(key, {"proofs": []})
        t = ln["time"]
        if name == "cut":
            a["number"], a["cut"] = ln["number"], t
        elif name == "built":
            a["hash"], a["txs"] = ln["block_hash"], [x.lower() for x in ln.get("tx_hashes", [])]
        elif name == "proof_ended":
            a["proofs"].append(ln.get("outcome"))
        elif name == "submitted":
            a["submitted"] = t
        elif name == "answered":
            a["answered"], a["outcome"] = t, ln.get("outcome")
        elif name == "resolved":
            a["resolved"], a["resolution"] = t, ln.get("outcome")
        elif name == "final_seen":
            a["final"] = t
            a.setdefault("number", ln.get("number"))
        elif name == "cancelled":
            a["cancelled"], a["depends_on"] = t, ln.get("depends_on")
            a.setdefault("number", ln.get("number"))
    return out


def committed(a: dict) -> bool:
    return a.get("outcome") == "committed" or a.get("resolution") == "committed"


def ended_at(a: dict):
    """When the attempt's command stopped being in doubt (the later of its answer and its settling), or None while it still is."""
    if a.get("outcome") in ("unknown", None):   # no answer at all: a run killed while the command was out, closed by the next run
        return a.get("resolved")
    return a.get("answered")


def check_journal(lines: list, sent=None, blocks: int = 0) -> list:
    bad: list = []
    atts = attempts_of(lines)
    by_height: dict = {}
    for key, a in atts.items():
        if "submitted" in a and "number" in a:
            by_height.setdefault(a["number"], []).append((key, a))
    done = {a["number"]: key for key, a in atts.items() if committed(a) and "number" in a}
    # 1. one commit a height, no gap
    for n in {a["number"] for a in atts.values() if committed(a) and "number" in a}:
        n_commits = [k for k, a in atts.items() if committed(a) and a.get("number") == n]
        if len(n_commits) > 1:
            bad.append(f"height {n} was committed {len(n_commits)} times: {n_commits}")
    if done:
        gap = [n for n in range(min(done), max(done) + 1) if n not in done]
        if gap:
            bad.append(f"the committed heights have a gap: {gap[:10]}")
    # 2. a height is submitted again only after the earlier attempt ended without a commit
    for n, subs in by_height.items():
        subs.sort(key=lambda kv: kv[1]["submitted"])
        for (k1, a1), (k2, a2) in zip(subs, subs[1:]):
            end = ended_at(a1)
            if committed(a1):
                bad.append(f"height {n} was submitted again ({k2}) after attempt {k1} committed it")
            elif end is None or end > a2["submitted"]:
                bad.append(f"height {n} was submitted again ({k2}) while attempt {k1} was still in doubt")
    # 3. nothing above a height is submitted while that height is unanswered
    open_cmds = sorted(((a["submitted"], ended_at(a), n, k) for n, subs in by_height.items() for k, a in subs), key=lambda x: x[0])
    for t, _, n, k in open_cmds:
        for t0, end0, n0, k0 in open_cmds:
            if n0 < n and t0 < t and (end0 is None or end0 > t):
                bad.append(f"height {n} ({k}) was submitted while height {n0} ({k0}) was in doubt")
    # 4. final, and nothing lost
    for key, a in atts.items():
        if committed(a) and "final" not in a:
            bad.append(f"attempt {key}, height {a.get('number')}, was committed and never seen final")
    seen: dict = {}
    for key, a in atts.items():
        if committed(a):
            for h in a.get("txs", []):
                if h in seen:
                    bad.append(f"transaction {h} is in two committed blocks: {seen[h]} and {key}")
                seen[h] = key
    for ln in lines:
        if ln.get("event") == "lost" and ln.get("transactions"):
            bad.append(f"transactions were named lost: {json.dumps(ln['transactions'])[:300]}")
    # 5. everything sent is in a committed block
    if sent is not None:
        missing = [h for h in (x.lower() for x in sent) if h not in seen]
        if missing:
            bad.append(f"{len(missing)} of {len(sent)} sent transactions are in no committed block, such as {missing[:3]}")
    if blocks and len(done) < blocks:
        bad.append(f"only {len(done)} blocks were committed; {blocks} were expected")
    return bad


def read_proved(path) -> dict:
    """The prover's own log (tests/pipeline_prove.sh): first 16 hex digits of a block's hash -> when its proof was finished."""
    out: dict = {}
    if path and Path(path).exists():
        for raw in Path(path).read_text().splitlines():
            parts = raw.split()
            if len(parts) == 3:
                out[parts[1]] = parts[0]
    return out


def unwind_depth(atts: dict) -> int:
    """The most blocks one refusal took with it: the refused block and every attempt cancelled behind it, one after another (`depends_on`)."""
    best = 0
    for (run, att), a in atts.items():
        if a.get("outcome") != "refused":
            continue
        gone, grew = {att}, True
        while grew:
            grew = False
            for (r2, a2), b in atts.items():
                if r2 == run and a2 not in gone and "cancelled" in b and b.get("depends_on") in gone:
                    gone.add(a2)
                    grew = True
        best = max(best, len(gone))
    return best


def inflight_keys(lines: list) -> list:
    """The attempts of the newest run that are still going: built, and not final, cancelled, resolved, refused or failed."""
    run = lines[-1]["run"] if lines else None
    atts = attempts_of(lines)
    return sorted(k for k, a in atts.items() if k[0] == run and "hash" in a and not ({"final", "cancelled", "resolved"} & a.keys()) and a.get("outcome") not in ("refused", "failed"))


def unclosed(lines: list, keys: list) -> list:
    """Of these attempts (run, attempt), those that nothing has closed yet: no final, cancelled or resolved line, and not committed."""
    atts = attempts_of(lines)
    return [k for k in keys if not ({"final", "cancelled", "resolved"} & atts.get(tuple(k), {}).keys() or committed(atts.get(tuple(k), {})))]


def stats(lines: list, proved=None) -> dict:
    """What the faults left. The journal writes a block's `proof_ended` when the producer next looks at it, which, while a submit runs, is after the
    submit: so whether a dropped block had its proof is read from the prover's own log, `proved`."""
    proved = proved or {}
    atts = attempts_of(lines)
    cancelled = [a for a in atts.values() if "cancelled" in a]
    run = lines[-1]["run"] if lines else None
    return {
        "committed": sum(1 for a in atts.values() if committed(a)),
        "refused": sum(1 for a in atts.values() if a.get("outcome") == "refused"),
        "cancelled": len(cancelled),
        "unwind": unwind_depth(atts),   # blocks of the longest move back of reth: the refused one and the ones behind it
        "restarted": sum(1 for a in atts.values() if a.get("resolution") == "restarted"),   # blocks a restart found in flight and gave up
        "inFlight": len(inflight_keys(lines)),   # of the newest run
        "cancelledProven": sum(1 for a in cancelled if proved.get(a.get("hash", "0x")[2:18], "~") <= a["cancelled"]),   # the block behind the faulted one had its proof when it was dropped
        "unknown": sum(1 for a in atts.values() if a.get("outcome") == "unknown"),
        "unknownCommitted": sum(1 for a in atts.values() if a.get("outcome") == "unknown" and a.get("resolution") == "committed"),
        "submitted": sum(1 for ln in lines if ln.get("event") == "submitted"),
        "provers": len({ln.get("prover") for ln in lines if ln.get("event") == "proof_ended"}),
        "lost": sum(len(ln.get("transactions") or []) for ln in lines if ln.get("event") == "lost"),
    }


# ---- the two chains ---------------------------------------------------------------------------------------------

def reth(method: str, params: list):
    url = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', '8545')}"
    req = urllib.request.Request(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(), {"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r).get("result")


def reth_batch(method: str, params_list: list, size: int = 100) -> list:
    url = f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', '8545')}"
    out: list = []
    for i in range(0, len(params_list), size):
        body = [{"jsonrpc": "2.0", "id": j, "method": method, "params": p} for j, p in enumerate(params_list[i:i + size])]
        req = urllib.request.Request(url, json.dumps(body).encode(), {"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            out += [x.get("result") for x in sorted(json.load(r), key=lambda x: x["id"])]
    return out


def check_chain(lines: list, sent=None) -> list:
    bad: list = []
    held = {}   # tx hash -> (height, block hash) of the committed block that holds it
    commits = {a["number"]: a for a in attempts_of(lines).values() if committed(a) and "hash" in a and "number" in a}
    heights = sorted(commits)
    blocks = reth_batch("eth_getBlockByNumber", [[hex(n), False] for n in heights])
    for n, b in zip(heights, blocks):
        if b is None or norm(b["hash"]) != norm(commits[n]["hash"]):
            bad.append(f"height {n}: the journal says Canton took {commits[n]['hash']}, reth's block is {b and b['hash']}")
        for h in commits[n].get("txs", []):
            held[h] = (n, norm(commits[n]["hash"]))
    finalized = int(reth("eth_getBlockByNumber", ["finalized", False])["number"], 16)
    if sent:
        receipts = reth_batch("eth_getTransactionReceipt", [[h] for h in sent])
        for h, r in zip(sent, receipts):
            if r is None:
                bad.append(f"sent transaction {h} has no receipt")
            elif int(r["blockNumber"], 16) > finalized:
                bad.append(f"sent transaction {h} is in block {int(r['blockNumber'], 16)}, above reth's finalized block {finalized}")
            elif held.get(h.lower()) != (int(r["blockNumber"], 16), norm(r["blockHash"])):
                bad.append(f"sent transaction {h} is in reth's block {int(r['blockNumber'], 16)} {r['blockHash']}, and the journal's committed block is {held.get(h.lower())}")
    return bad


def canton_ledger():
    sys.path.insert(0, str(HERE.parent / "builder"))
    import builder as b
    cfg = b.Config.from_env()
    cfg.read_as = tuple(os.environ.get("CZE_READ_AS", "").split())
    return b.Ledger(cfg)


def norm(h: str) -> str:
    return "0x" + h.lower().removeprefix("0x")


def sample(ledger, strict: bool, finalized_seen: dict) -> list:
    """Reth's finalized block is read first: Canton commits before the builder finalizes, so Canton's head is never below it."""
    bad: list = []
    fin = reth("eth_getBlockByNumber", ["finalized", False])
    head = ledger.head()
    n, h = int(head["headNumber"]), norm(head["headHash"])
    fn = int(fin["number"], 16)
    if fn > n:
        bad.append(f"reth finalized block {fn} is above Canton's head {n}")
    block = reth("eth_getBlockByNumber", [hex(n), False])
    if block is None or norm(block["hash"]) != h:
        bad.append(f"Canton's head {n} is {h}; reth's block {n} is {block and block['hash']}")
    if strict and (fn != n or norm(fin["hash"]) != h):
        bad.append(f"Canton's head is {n} {h}, reth's finalized block is {fn} {fin['hash']}")
    fh = norm(fin["hash"])
    if finalized_seen.get(fn, fh) != fh:
        bad.append(f"reth's finalized block {fn} changed from {finalized_seen[fn]} to {fh}")
    if fn < max(finalized_seen or {0}):
        bad.append(f"reth's finalized block went back from {max(finalized_seen)} to {fn}")
    finalized_seen[fn] = fh
    return bad


def watch(out: str, stop: str) -> int:
    ledger, seen, samples, errors = canton_ledger(), {}, 0, 0
    with open(out, "a") as f:
        while not os.path.exists(stop):
            try:
                for line in sample(ledger, False, seen):
                    f.write(line + "\n"); f.flush()
                samples += 1
            except Exception as e:   # a read that failed is not a disagreement: it is counted, and the run fails if there were too few samples
                errors += 1
                print(f"watch: {type(e).__name__}: {str(e)[:200]}", file=sys.stderr)
            time.sleep(1)
        f.write(f"samples {samples} errors {errors}\n")
    return 0


def options(rest: list) -> dict:
    out: dict = {}
    while rest:
        if rest[0] in ("--sent", "--blocks", "--proved") and len(rest) > 1:
            out[rest[0][2:]] = rest[1]
        else:
            sys.exit(__doc__)
        rest = rest[2:]
    return out


def main(argv: list) -> int:
    if len(argv) >= 3 and argv[1] == "journal":
        o = options(argv[3:])
        sent = [x for x in Path(o["sent"]).read_text().split() if x] if "sent" in o else None
        bad = check_journal(read_journal(argv[2]), sent, int(o.get("blocks", 0)))
        print("\n".join(bad) if bad else f"journal ok: {json.dumps(stats(read_journal(argv[2]), read_proved(o.get('proved'))))}")
        return 1 if bad else 0
    if len(argv) >= 3 and argv[1] == "chain":
        o = options(argv[3:])
        sent = [x for x in Path(o["sent"]).read_text().split() if x] if "sent" in o else None
        bad = check_chain(read_journal(argv[2]), sent)
        print("\n".join(bad[:20]) if bad else "chain ok: every committed block is reth's, every sent transaction is in it and final")
        return 1 if bad else 0
    if len(argv) == 3 and argv[1] == "inflight":   # the attempts in flight now, one "<run> <attempt>" a line
        print("\n".join(f"{r} {a}" for r, a in inflight_keys(read_journal(argv[2]))))
        return 0
    if len(argv) == 4 and argv[1] == "closed":   # exits 1 while an attempt of the file (from `inflight`) is still open
        keys = [tuple(x.split(" ", 1)) for x in Path(argv[3]).read_text().splitlines() if x.strip()]
        keys = [(r, int(a)) for r, a in keys]
        left = unclosed(read_journal(argv[2]), keys)
        print("\n".join(f"{r} {a}" for r, a in left) if left else "closed: every attempt that was in flight is closed")
        return 1 if left else 0
    if len(argv) >= 3 and argv[1] == "stats":
        print(json.dumps(stats(read_journal(argv[2]), read_proved(options(argv[3:]).get("proved")))))
        return 0
    if len(argv) == 4 and argv[1] == "watch":
        return watch(argv[2], argv[3])
    if len(argv) == 2 and argv[1] == "settled":
        bad = sample(canton_ledger(), True, {})
        print("\n".join(bad) if bad else "settled: Canton's head is reth's finalized block")
        return 1 if bad else 0
    sys.exit(__doc__)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
