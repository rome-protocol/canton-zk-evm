#!/usr/bin/env python3
"""Deploys the note board (the demo receiver of AggLayer messages) on one chain, bound to that chain's bridge, and reads it back.

  deploy_note_board.py [options] ostia|sepolia

The chains and their bridges are settings (deploy/note-board.json). Nothing is written to a chain unless it is a local test chain (anvil) or --live is given,
and the chain's id must always be the config's. The key is a keystore file with a password file (paths, never values); the chain's address comes from
NOTE_BOARD_RPC_URL or --rpc-url-file and is never printed. Needs cast; run `forge build` first."""
import argparse, json, os, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


class Fail(Exception):
    pass


def cast(url, *args):
    p = subprocess.run(["cast", *map(str, args)], capture_output=True, text=True, env={**os.environ, "ETH_RPC_URL": url})
    if p.returncode:
        raise Fail((p.stderr.strip() or p.stdout.strip()).replace(url, "<rpc>"))
    return p.stdout.strip()


def run(a):
    cfg = json.loads(Path(a.config).read_text())
    if a.chain not in cfg:
        raise Fail(f"{a.chain} is not in {a.config} (it has: {', '.join(cfg)})")
    c = cfg[a.chain]
    if not ADDRESS.match(str(c.get("bridge"))):
        raise Fail(f"the bridge of {a.chain} is not an address")
    url = os.environ.get("NOTE_BOARD_RPC_URL") or (Path(a.rpc_url_file).read_text().strip() if a.rpc_url_file else "")
    if not url:
        raise Fail("no chain address: set NOTE_BOARD_RPC_URL or --rpc-url-file")
    if int(cast(url, "chain-id")) != int(c["chainId"]):
        raise Fail(f"the chain id of the chain is not {a.chain}'s chain id ({c['chainId']})")
    try:
        version = cast(url, "rpc", "web3_clientVersion")
    except Fail:
        version = ""
    if not version.strip('"').lower().startswith("anvil/") and not a.live:
        raise Fail("the chain is not a local test chain (anvil); nothing is sent unless --live is given")
    code = json.loads((Path(a.out) / "NoteBoard.sol" / "NoteBoard.json").read_text())["bytecode"]["object"]
    r = json.loads(cast(url, "send", "--json", "--keystore", a.keystore, "--password-file", a.password_file,
                        "--create", code, "constructor(address)", c["bridge"]))
    if int(r["status"], 16) != 1:
        raise Fail(f"the deploy failed ({r['transactionHash']})")
    board = r["contractAddress"].lower()
    print(f"tx {r['transactionHash']} -> {board} gas {int(r['gasUsed'], 16)}")
    problems = []
    if len(cast(url, "code", board)) <= 2:
        problems.append("no code at the new address")
    if cast(url, "call", board, "BRIDGE()(address)").lower() != c["bridge"].lower():
        problems.append("BRIDGE() is not the configured bridge")
    if cast(url, "call", board, "count()(uint256)").split()[0] != "0":
        problems.append("count() is not 0")
    if problems:
        raise Fail("read-back: " + "; ".join(problems))
    print(f"note board on {a.chain}: {board}, bridge {c['bridge'].lower()}; all read-backs passed")


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--config", default=str(HERE / "deploy" / "note-board.json"))
    p.add_argument("--out", default=str(HERE / "out"), help="forge's output folder (forge build)")
    p.add_argument("--live", action="store_true", help="allow a chain that is not a local test chain (anvil)")
    p.add_argument("--rpc-url-file")
    p.add_argument("--keystore", required=True)
    p.add_argument("--password-file", required=True)
    p.add_argument("chain", help="a chain name in the config: ostia or sepolia")
    a = p.parse_args()
    try:
        run(a)
    except Fail as e:
        print("FAIL:", e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
