"""The Sepolia claimer (flow A): claims on Ethereum Sepolia the transfers that the router sent, paid by the fee that the router took on Ostia. The user's own claim stays the fallback.

It reads the router's RoutedOut events from Ostia's finalized blocks, asks AggKit's bridge service (loopback only, not trusted: every answer is checked, and the leaf must be the one the
router's event describes) for the leaf and its proof, and sends claimAsset once the transfer is ready and nobody has claimed it. Guards: a floor, caps by the hour, the day and the recipient,
gas and gas price limits, and the key's balance. Transfers that the router did not send are never claimed.
"""
import json, re, time, urllib.error, urllib.request

from eth_abi import decode
from eth_utils import keccak

import chain
from records import over_caps

USER_AGENT = chain.USER_AGENT
ROUTED_OUT = "0x" + keccak(text="RoutedOut(bytes32,bytes32,address,string,uint32,address,uint256,uint256,uint256)").hex()
CLAIM = "claimAsset(bytes32[32],bytes32[32],uint256,bytes32,bytes32,uint32,address,uint32,address,uint256,bytes)"
CLAIM_TYPES = ["bytes32[32]", "bytes32[32]", "uint256", "bytes32", "bytes32", "uint32", "address", "uint32", "address", "uint256", "bytes"]
LOOPBACK = re.compile(r"http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?")
HASH, ADDRESS, DECIMAL, BYTES = re.compile(r"0x[0-9a-fA-F]{64}"), re.compile(r"0x[0-9a-fA-F]{40}"), re.compile(r"[0-9]{1,78}"), re.compile(r"0x([0-9a-fA-F]{2}){0,4096}")
MAX_TRIES = 3


class Aggkit:
    """A GET to a fixed list of routes of AggKit's bridge service and nothing else."""
    def __init__(self, base: str):
        if not LOOPBACK.fullmatch(base.rstrip("/")):
            raise SystemExit("the bridge service must be http on this machine (127.0.0.1, localhost or [::1]): it is never opened to the outside")
        self.base = base.rstrip("/")

    def get(self, path: str, params: dict):
        if any(not 0 <= v < 2**32 for v in params.values()):
            raise chain.ChainError("a number for the bridge service does not fit 32 bits")
        url = f"{self.base}/bridge/v1/{path}?" + "&".join(f"{k}={v}" for k, v in params.items())
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"accept": "application/json", "user-agent": USER_AGENT}), timeout=5) as r:
                return json.loads(r.read(1024 * 1024))
        except urllib.error.HTTPError as e:
            e.close()
            if e.code in (404, 503):
                return None   # not there yet
            raise chain.ChainError(f"the bridge service answered HTTP {e.code}") from None
        except (OSError, ValueError):
            raise chain.ChainError("the bridge service cannot be read") from None

    def leaf(self, network: int, count: int) -> "dict | None":
        found = self.get("bridges", {"network_id": network, "deposit_count": count})
        raw = next((b for b in (found or {}).get("bridges") or [] if isinstance(b, dict) and b.get("deposit_count") == count), None)
        if raw is None:
            return None
        ok = (isinstance(raw.get("leaf_type"), int) and isinstance(raw.get("origin_network"), int) and isinstance(raw.get("destination_network"), int)
              and all(ADDRESS.fullmatch(str(raw.get(k))) for k in ("origin_address", "destination_address")) and DECIMAL.fullmatch(str(raw.get("global_index")))
              and DECIMAL.fullmatch(str(raw.get("amount"))) and BYTES.fullmatch(str(raw.get("metadata"))))
        if not ok:
            raise chain.ChainError("the bridge service's leaf is not in the expected form")
        return raw

    def number(self, path: str, params: dict, field: str = None) -> "int | None":
        found = self.get(path, params)
        found = found.get(field) if field and isinstance(found, dict) else found
        if found is None:
            return None
        if type(found) is not int or found < 0:
            raise chain.ChainError(f"the bridge service's {path} is not a number")
        return found

    def proof(self, network: int, leaf_index: int, count: int) -> "dict | None":
        found = self.get("claim-proof", {"network_id": network, "leaf_index": leaf_index, "deposit_count": count})
        if found is None:
            return None
        info = found.get("l1_info_tree_leaf") if isinstance(found, dict) else None
        local, rollup = (found or {}).get("proof_local_exit_root"), (found or {}).get("proof_rollup_exit_root")
        if not (isinstance(info, dict) and all(isinstance(p, list) and len(p) == 32 and all(HASH.fullmatch(str(h)) for h in p) for p in (local, rollup))
                and all(HASH.fullmatch(str(info.get(k))) for k in ("mainnet_exit_root", "rollup_exit_root"))):
            raise chain.ChainError("the bridge service's claim proof is not in the expected form")
        return {"local": local, "rollup": rollup, "mainnet": info["mainnet_exit_root"], "rollupRoot": info["rollup_exit_root"]}


def scan(ostia: chain.Rpc, router: str, records, cfg: dict) -> None:
    """New RoutedOut events of the router in Ostia's finalized blocks, for this claimer's destination, into the records as pending."""
    head = ostia.finalized()
    start = records.data["cursor"] + 1 if records.data["cursor"] is not None else cfg["from_block"]
    while start <= head:
        end = min(start + cfg["chunk"] - 1, head)
        for entry in ostia.call("eth_getLogs", [{"address": router, "topics": [ROUTED_OUT], "fromBlock": hex(start), "toBlock": hex(end)}]):
            party, network, coin, send, fee, count = decode(["string", "uint32", "address", "uint256", "uint256", "uint256"], bytes.fromhex(entry["data"][2:]))
            if network == cfg["network"] and not records.get(str(count)):
                records.put(str(count), state="pending", count=count, asset=coin.lower(), dest="0x" + entry["topics"][3][-40:], send=str(send), tries=0)
        records.data["cursor"] = end
        records.save()
        start = end + 1


def claimed(sepolia: chain.Rpc, bridge: str, count: int, ostia_network: int) -> bool:
    return sepolia.view(bridge, "isClaimed(uint32,uint32)", ["uint32", "uint32"], [count, ostia_network], ["bool"])[0]


def resolve(sepolia: chain.Rpc, signer, bridge: str, ostia_network: int, records, cfg: dict, log) -> None:
    for key, sent in records.where("sent"):
        try:
            state, _ = chain.settle(sepolia, signer, sent, cfg["limits"], cfg["wait"], final=False)
            if state == "waiting":
                continue
            if state != "done" and claimed(sepolia, bridge, sent["count"], ostia_network):
                state = "done"   # somebody else's claim landed first
        except chain.ChainError as e:
            log(f"claim-sepolia: {e}")
            continue
        tries = sent["tries"] + 1
        records.put(key, state="claimed" if state == "done" else "pending" if state == "replaced" and tries < MAX_TRIES else "failed", tries=tries)
        log(f"claim-sepolia: {key} {state}")


def claim_one(aggkit: Aggkit, sepolia: chain.Rpc, signer, bridge: str, ostia_network: int, item: dict, records, cfg: dict, now: float) -> "str | None":
    """Sends the claim for one transfer, or says why it waits (None: it was sent)."""
    count, dest = item["count"], item["dest"]
    leaf = aggkit.leaf(ostia_network, count)
    if leaf is None:
        return "the bridge service has not indexed it"
    if (leaf["leaf_type"], leaf["origin_network"], leaf["origin_address"].lower(), leaf["destination_network"], leaf["destination_address"].lower(), int(leaf["amount"])) != (0, ostia_network, item["asset"], cfg["network"], dest, int(item["send"])):
        records.put(str(count), state="mismatch")   # the service's leaf is not what the router sent: never claimed
        return "the bridge service's leaf is not the router's send"
    index = aggkit.number("l1-info-tree-index", {"network_id": ostia_network, "deposit_count": count})
    taken = None if index is None else aggkit.number("injected-l1-info-leaf", {"network_id": 0, "leaf_index": index}, "l1_info_tree_index")   # Ethereum itself takes the root
    proof = None if taken is None else aggkit.proof(ostia_network, taken, count)
    if proof is None:
        return "it is not ready on Ethereum yet"
    if claimed(sepolia, bridge, count, ostia_network):
        records.put(str(count), state="claimed")
        return "it is claimed already"
    if int(item["send"]) < cfg["floor"]:
        return "the amount is under the floor: the user claims"
    capped = over_caps(records, dest, cfg["caps"], now)
    if capped or sepolia.number("eth_getBalance", [signer.address, "latest"]) < cfg["min_balance"]:
        return capped or "the claimer's balance is under its floor"
    h = lambda xs: [bytes.fromhex(x[2:]) for x in xs]
    args = [h(proof["local"]), h(proof["rollup"]), int(leaf["global_index"]), bytes.fromhex(proof["mainnet"][2:]), bytes.fromhex(proof["rollupRoot"][2:]), ostia_network,
            item["asset"], cfg["network"], dest, int(item["send"]), bytes.fromhex(leaf["metadata"][2:])]
    note = lambda sent: records.put(str(count), state="sent", recipient=dest, **sent) if sent else records.put(str(count), at=None, tx=None)
    chain.send(sepolia, signer, bridge, chain.call_data(CLAIM, CLAIM_TYPES, args), cfg["limits"], record=note)
    return None


def run_once(aggkit: Aggkit, ostia: chain.Rpc, sepolia: chain.Rpc, router: str, bridge: str, ostia_network: int, signer, records, cfg: dict, log=print, now: float = None) -> None:
    now = time.time() if now is None else now
    resolve(sepolia, signer, bridge, ostia_network, records, cfg, log)
    scan(ostia, router, records, cfg)
    if records.where("sent"):
        return   # one at a time
    for key, item in sorted(records.where("pending"), key=lambda kv: kv[1]["count"]):
        try:
            why = claim_one(aggkit, sepolia, signer, bridge, ostia_network, item, records, cfg, now)
        except chain.ChainError as e:
            if records.get(key).get("state") == "sent":   # a timeout after the send: the record finds it again
                log(f"claim-sepolia: {key} sent, the node's answer is unknown")
                return
            why = str(e)
        if why is None:
            log(f"claim-sepolia: {key} sent")
            return
        if item.get("why") != why:
            records.put(key, why=why)
            log(f"claim-sepolia: {key} waits: {why}")
