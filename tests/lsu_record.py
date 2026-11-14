#!/usr/bin/env python3
"""The record of a logical synchronizer upgrade under a running chain (tests/canton_lsu.sh): what the builder's journal says happened to its blocks
around the upgrade time, next to what the upgrade's console printed (network/canton/lsu.canton, its "LSU <what> <time> <detail>" lines).

  lsu_record.py <journal folder> <console log> <out json>

Prints the record as text and writes it as JSON:
  - the upgrade: the two physical synchronizer ids, when it was announced, the upgrade time, when each participant was on the successor
  - every block attempt that was in flight at the upgrade time (cut before it, not answered before it): its height, when it was cut, built, sent
    and answered, the answer and its reason, and what became of its height (the attempt that committed it, and when)
  - the commits: the last one before the upgrade time, the first one after, the gap between them, the longest gap of the whole run, and how
    many blocks committed in the freeze (between the announcement and the upgrade time) and after the upgrade
  - the attempts that did not commit from the announcement on, by answer, and the transactions the journal names lost
Exits 0; the scenario script decides what passes."""
import json, re, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pipeline_check import read_journal  # noqa: E402


def when(text: str) -> float:
    """A UTC time from the journal (milliseconds) or from Canton (up to nanoseconds), in seconds."""
    m = re.match(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?Z$", text.strip())
    if not m:
        raise ValueError(f"not a UTC time: {text}")
    base = datetime.strptime(m.group(1), "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc).timestamp()
    return base + (float("0." + m.group(2)) if m.group(2) else 0.0)


def console(path: str) -> dict:
    out: dict = {"switched": {}, "manual": []}
    for line in Path(path).read_text().splitlines():
        parts = line.split(" ", 3)
        if len(parts) < 3 or parts[0] != "LSU":
            continue
        what, t, detail = parts[1], parts[2], parts[3] if len(parts) > 3 else ""
        if what == "switched":
            out["switched"][detail.split(" ")[0]] = t
        elif what == "manual_lsu":
            out["manual"].append(detail)
        elif what in ("current_psid", "successor_psid"):
            out[what] = detail
        elif what == "upgrade_time":
            out["upgrade_time"] = detail
        else:
            out[what] = {"time": t, "detail": detail} if detail else t
    return out


def attempts(lines: list) -> list:
    out: dict = {}
    for ln in lines:
        if ln.get("attempt") is None:
            continue
        a = out.setdefault((ln.get("attempt_run") or ln["run"], ln["attempt"]), {"attempt": ln["attempt"]})
        name, t = ln.get("event"), ln["time"]
        if name == "cut":
            a.update(number=ln["number"], cut=t, cut_reason=ln.get("cut_reason"))
        elif name == "built":
            a.update(built=t, transactions=len(ln.get("tx_hashes") or []), block_hash=ln.get("block_hash"))
        elif name == "submitted":
            a.update(submitted=t, command_id=ln.get("command_id"))
        elif name == "answered":
            a.update(answered=t, outcome=ln.get("outcome"), reason=(ln.get("reason") or "")[:400] or None, stage=ln.get("stage"), seconds=ln.get("seconds"))
        elif name == "resolved":
            a.update(resolved=t, resolution=ln.get("outcome"), via=ln.get("via"))
        elif name == "cancelled":
            a.update(cancelled=t, reason=(ln.get("reason") or "")[:400] or None)
            a.setdefault("number", ln.get("number"))
        elif name == "skipped":
            a.update(skipped=t)
    return sorted((a for a in out.values() if "cut" in a), key=lambda a: a["cut"])


def is_committed(a: dict) -> bool:
    return a.get("outcome") == "committed" or a.get("resolution") == "committed"


def end_of(a: dict):
    """When the attempt ended: its answer, its settling, its drop or its skip; None while it runs."""
    times = [a[k] for k in ("answered", "resolved", "cancelled", "skipped") if a.get(k)]
    if a.get("outcome") == "unknown" and not a.get("resolved"):
        return None
    return max(times) if times else None


def main(argv: list) -> int:
    if len(argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    lines, lsu = read_journal(argv[1]), console(argv[2])
    if "upgrade_time" not in lsu:
        print("FAIL: the console log has no upgrade time", file=sys.stderr)
        return 1
    up = when(lsu["upgrade_time"])
    announced = when(lsu["announced"]) if isinstance(lsu.get("announced"), str) else None
    atts = attempts(lines)
    commits = sorted((when(a.get("answered") if a.get("outcome") == "committed" else a["resolved"]), a["number"]) for a in atts if is_committed(a))

    def rel(t):   # seconds from the upgrade time
        return None if t is None else round(when(t) - up, 3)

    in_flight = []
    for a in atts:
        end = end_of(a)
        if when(a["cut"]) <= up and (end is None or when(end) > up):
            later = [b for b in atts if b.get("number") == a.get("number") and when(b["cut"]) >= when(a["cut"]) and is_committed(b)]
            fate = later[0] if later else None
            in_flight.append({
                "number": a.get("number"), "attempt": a["attempt"], "transactions": a.get("transactions"), "cut_reason": a.get("cut_reason"),
                "cut": a["cut"], "built": a.get("built"), "submitted": a.get("submitted"), "answered": a.get("answered"),
                "relativeToUpgrade": {k: rel(a.get(k)) for k in ("cut", "built", "submitted", "answered", "resolved", "cancelled")},
                "outcome": a.get("outcome"), "stage": a.get("stage"), "reason": a.get("reason"), "resolution": a.get("resolution"), "via": a.get("via"),
                "seconds": a.get("seconds"),
                "heightCommittedBy": None if fate is None else {"attempt": fate["attempt"], "answered": fate.get("answered") or fate.get("resolved"),
                                                                 "secondsAfterUpgrade": rel(fate.get("answered") or fate.get("resolved")),
                                                                 "sameAttempt": fate is a},
            })
    before = [c for c in commits if c[0] <= up]
    after = [c for c in commits if c[0] > up]
    gaps = [(commits[i][0] - commits[i - 1][0], commits[i - 1][1], commits[i][1]) for i in range(1, len(commits))]
    longest = max(gaps) if gaps else (0.0, None, None)
    window_start = announced if announced is not None else up
    not_committed: dict = {}
    for a in atts:
        if when(a["cut"]) >= window_start and not is_committed(a) and end_of(a) is not None:
            key = a.get("outcome") or ("cancelled" if a.get("cancelled") else "skipped" if a.get("skipped") else "other")
            not_committed.setdefault(key, []).append({"number": a.get("number"), "attempt": a["attempt"], "cut": a["cut"],
                                                       "relativeToUpgrade": rel(a.get("answered") or a.get("cancelled") or a.get("skipped")),
                                                       "reason": a.get("reason"), "stage": a.get("stage")})
    record = {
        "upgrade": {"from": lsu.get("current_psid"), "to": lsu.get("successor_psid"), "announced": lsu.get("announced"),
                    "upgradeTime": lsu["upgrade_time"], "switch": "manual" if lsu["manual"] else "auto",
                    "participantsOnSuccessor": {p: {"time": t, "secondsAfterUpgrade": rel(t)} for p, t in lsu["switched"].items()},
                    "freezeProbe": lsu.get("freeze_probe"), "partyAfter": lsu.get("party_after")},
        "inFlightAtUpgrade": in_flight,
        "commits": {
            "total": len(commits),
            "inFreeze": sum(1 for c in commits if window_start < c[0] <= up),
            "afterUpgrade": len(after),
            "lastBefore": None if not before else {"number": before[-1][1], "secondsBeforeUpgrade": round(up - before[-1][0], 3)},
            "firstAfter": None if not after else {"number": after[0][1], "secondsAfterUpgrade": round(after[0][0] - up, 3)},
            "gapAcrossUpgrade": None if not (before and after) else round(after[0][0] - before[-1][0], 3),
            "longestGap": {"seconds": round(longest[0], 3), "between": [longest[1], longest[2]]},
        },
        "notCommittedFromAnnouncement": not_committed,
        "lost": sum(len(ln.get("transactions") or []) for ln in lines if ln.get("event") == "lost"),
    }
    Path(argv[3]).write_text(json.dumps(record, indent=2) + "\n")
    u, c = record["upgrade"], record["commits"]
    print(f"upgrade {u['from']} -> {u['to']} at {u['upgradeTime']} ({u['switch']} switch)")
    for p, s in u["participantsOnSuccessor"].items():
        print(f"  {p} on the successor {s['secondsAfterUpgrade']} s after the upgrade time")
    print(f"commits: {c['total']} in all, {c['inFreeze']} in the freeze, {c['afterUpgrade']} after the upgrade; last before: {c['lastBefore']}; first after: {c['firstAfter']}")
    print(f"gap across the upgrade: {c['gapAcrossUpgrade']} s; longest gap of the run: {c['longestGap']['seconds']} s (blocks {c['longestGap']['between']})")
    for f in in_flight:
        print(f"in flight at the upgrade: block {f['number']} attempt {f['attempt']} ({f['transactions']} txs): {f['relativeToUpgrade']} s from the upgrade; "
              f"answer {f['outcome']} {f['stage'] or ''} {f['resolution'] or ''}; reason: {(f['reason'] or '-')[:200]}; height committed by: {f['heightCommittedBy']}")
    if not in_flight:
        print("no block attempt was in flight at the upgrade time")
    for k, v in not_committed.items():
        print(f"not committed from the announcement on, {k}: {len(v)}: " + "; ".join(f"block {x['number']} at {x['relativeToUpgrade']} s: {(x['reason'] or '')[:160]}" for x in v[:5]))
    print(f"lost transactions: {record['lost']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
