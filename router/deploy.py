#!/usr/bin/env python3
"""Deploys the Canton router's contracts and reads everything back.

  deploy.py [options] deploy | settings-schedule | settings-execute | check [--settings]

deploy: the ProxyAdmin, the timelock (a second one for upgrades when the config names one), the book and the router behind proxies, each initialised in
its own deploy transaction, then the ProxyAdmin's hand-over to the timelock, then every read-back. settings-schedule / settings-execute: the book is
owned by the timelock, so listing the asset, the destinations and the claim parts go through it as one batch (execute after the delay). check: the
read-backs alone, against what is on the chain.

Nothing is written to a chain that is not on this machine unless --live is given, and --live also requires the chain id of the config. Keys are keystore
files with password files (paths, never values); the chain's address comes from ROUTER_RPC_URL or --rpc-url-file and is never printed. Needs cast."""
import argparse, json, os, subprocess, sys, time
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103"  # EIP-1967
SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
INVALID_INITIALIZATION = "f92ee8a9"
ZERO = "0x" + "00" * 20
ONE = "0x" + "00" * 19 + "01"


class Fail(Exception):
    pass


def validate(c):
    """Raises Fail naming every field that is missing or malformed."""
    bad = []
    def addr(v, name):
        if not (isinstance(v, str) and len(v) == 42 and v.startswith("0x") and all(ch in "0123456789abcdefABCDEF" for ch in v[2:])):
            bad.append(name)
    def num(v, name):
        if not (isinstance(v, (int, str)) and str(v).isdigit()):
            bad.append(name)
    for k in ("chainId", "localNetwork", "refundWait"):
        num(c.get(k), k)
    for k in ("gateway", "bridge", "refuser", "feeRecipient"):
        addr(c.get(k), k)
    for t in ("settingsTimelock", "upgradeTimelock"):
        v = c.get(t)
        if v is None and t == "upgradeTimelock":
            continue
        if not isinstance(v, dict):
            bad.append(t)
            continue
        num(v.get("minDelay"), t + ".minDelay")
        for role in ("proposers", "executors"):
            if not v.get(role):
                bad.append(f"{t}.{role}")
            for a in v.get(role) or []:
                addr(a, f"{t}.{role}")
    a = c.get("asset") or {}
    addr(a.get("address"), "asset.address")
    if not (isinstance(a.get("instrument"), str) and len(a["instrument"]) == 66 and a["instrument"].startswith("0x")):
        bad.append("instrument")
    for k in ("feeOut", "feeIn", "feeRefund", "minAmount", "lockCap"):
        num(a.get(k), "asset." + k)
    for d in c.get("destinations", []):
        num(d.get("network"), "destinations.network"); num(d.get("unit"), "destinations.unit")
    for f in c.get("claimFees", []):
        num(f.get("network"), "claimFees.network"); num(f.get("fee"), "claimFees.fee")
    if bad:
        raise Fail("the config is missing or has a bad value for: " + ", ".join(dict.fromkeys(bad)))


def secret(env, file_flag):
    if os.environ.get(env):
        return os.environ[env].strip()
    if file_flag:
        return Path(file_flag).read_text().strip()
    raise Fail(f"no chain address: set {env} or --rpc-url-file")


class Deploy:
    def __init__(self, a):
        self.a = a
        self.cfg = json.loads(Path(a.config).read_text())
        validate(self.cfg)
        self.state_path = Path(a.state)
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        self.url = secret("ROUTER_RPC_URL", a.rpc_url_file)
        self.n = 0
        self.problems = []
        host = urlparse(self.url).hostname
        if host not in ("127.0.0.1", "localhost", "::1") and not a.live:
            raise Fail("the chain is not on this machine; nothing is sent unless --live is given")
        self.local = host in ("127.0.0.1", "localhost", "::1")
        if a.live and int(self.cast("chain-id")) != int(self.cfg["chainId"]):
            raise Fail("the chain id of the chain is not the config's chainId")

    # ---- cast

    def cast(self, *args):
        p = subprocess.run(["cast", *map(str, args)], capture_output=True, text=True, env={**os.environ, "ETH_RPC_URL": self.url})
        if p.returncode:
            raise Fail((p.stderr.strip() or p.stdout.strip()).replace(self.url, "<rpc>"))
        return p.stdout.strip()

    def read(self, *args):
        """A read that a read-back may fail without stopping the others: the text 'unreadable' stands for what could not be read."""
        try:
            return self.cast(*args)
        except Fail as e:
            self.problems.append(f"{args[0]} {args[1] if len(args) > 1 else ''}: {e}")
            return "unreadable"

    def call(self, to, sig, *args):
        return self.read("call", to, sig, *args).split("\n")[0].split()[0]

    def signer(self, who):
        ks, pw = getattr(self.a, who + "_keystore"), getattr(self.a, who + "_password_file")
        if not (ks and pw):
            raise Fail(f"--{who}-keystore and --{who}-password-file are needed")
        return ["--keystore", ks, "--password-file", pw]

    def address_of(self, who):
        return self.cast("wallet", "address", *self.signer(who)).lower()

    def send(self, label, who, to=None, sig=None, args=(), code=None):
        cmd = ["send", "--json", *self.signer(who)]
        cmd += ["--create", code, *([sig, *args] if sig else [])] if code else [to, sig, *args]
        r = json.loads(self.cast(*cmd))
        if int(r["status"], 16) != 1:
            raise Fail(f"{label}: the transaction failed ({r['transactionHash']})")
        self.n += 1
        target = f"-> {r['contractAddress']}" if code else f"to {to}"
        print(f"tx {self.n:2d} {label}: {r['transactionHash']} {target} gas {int(r['gasUsed'], 16)}")
        return (r.get("contractAddress") or "").lower() or r

    def save(self):
        self.state_path.write_text(json.dumps(self.state, indent=2) + "\n")

    # ---- artifacts

    def creation(self, name):
        j = json.loads((HERE / "artifacts" / (name + ".json")).read_text())
        b = j["bytecode"]
        return b["object"] if isinstance(b, dict) else b

    def built(self, name):
        j = json.loads((Path(self.a.out) / f"{name}.sol" / f"{name}.json").read_text())
        return j["bytecode"]["object"], j["deployedBytecode"]["object"]

    # ---- deploy

    def timelock(self, label, t):
        return self.send(label, "deployer", sig="constructor(uint256,address[],address[],address)", code=self.creation("TimelockController"),
                         args=(t["minDelay"], "[" + ",".join(t["proposers"]) + "]", "[" + ",".join(t["executors"]) + "]", ZERO))

    def deploy(self):
        c = self.cfg
        if self.state.get("book"):
            raise Fail("this state file already holds a deploy")
        deployer = self.address_of("deployer")
        holders = {x.lower() for t in ("settingsTimelock", "upgradeTimelock") for r in ("proposers", "executors") for x in (c.get(t) or {}).get(r, [])}
        if deployer in holders:
            raise Fail("the deployer key may not be a proposer or an executor: it must hold no role")
        s = self.state
        s["block"] = int(self.cast("block-number"))
        s["proxyAdmin"] = self.send("ProxyAdmin", "deployer", code=self.creation("ProxyAdmin"))
        s["settingsTimelock"] = self.timelock("settings timelock", c["settingsTimelock"])
        s["upgradeTimelock"] = self.timelock("upgrade timelock", c["upgradeTimelock"]) if c.get("upgradeTimelock") else s["settingsTimelock"]
        self.save()
        book_code, s["bookImplCode"] = self.built("CantonBook")
        router_code, s["routerImplCode"] = self.built("CantonRouter")
        s["bookImpl"] = self.send("book implementation", "deployer", code=book_code)
        s["routerImpl"] = self.send("router implementation", "deployer", code=router_code)
        self.save()
        proxy = ("constructor(address,address,bytes)", self.creation("TransparentUpgradeableProxy"))
        init = self.cast("calldata", "initialize(address,address,address,uint256,uint32)", s["settingsTimelock"], c["refuser"], c["feeRecipient"], c["refundWait"], c["localNetwork"])
        s["book"] = self.send("book proxy (initialised)", "deployer", sig=proxy[0], code=proxy[1], args=(s["bookImpl"], s["proxyAdmin"], init))
        init = self.cast("calldata", "initialize(address,address,address)", s["book"], c["gateway"], c["bridge"])
        s["router"] = self.send("router proxy (initialised)", "deployer", sig=proxy[0], code=proxy[1], args=(s["routerImpl"], s["proxyAdmin"], init))
        self.save()
        self.send("ProxyAdmin to its timelock", "deployer", s["proxyAdmin"], "transferOwnership(address)", (s["upgradeTimelock"],))
        print(json.dumps({k: v for k, v in s.items() if not k.endswith("Code")}, indent=2))
        self.check()

    # ---- read-backs

    def expect(self, what, got, want):
        if str(got).lower() != str(want).lower():
            self.problems.append(f"{what}: {got} is not {want}")

    def holders(self, timelock, role, from_block):
        """Who holds `role` on the timelock, from its grant and revoke events."""
        who = set()
        for event, add in (("RoleGranted(bytes32,address,address)", True), ("RoleRevoked(bytes32,address,address)", False)):
            out = self.read("logs", "--json", "--from-block", from_block, "--to-block", "latest", "--address", timelock, event)
            logs = [] if out == "unreadable" else json.loads(out)
            for lg in logs:
                if lg["topics"][1] != role:
                    continue
                (who.add if add else who.discard)("0x" + lg["topics"][2][-40:])
        return who

    def check_timelock(self, name, t, tl, from_block):
        self.expect(f"{name} minDelay", self.call(tl, "getMinDelay()(uint256)"), t["minDelay"])
        keccak = lambda x: self.cast("keccak", x)
        roles = {"PROPOSER_ROLE": (keccak("PROPOSER_ROLE"), t["proposers"]), "CANCELLER_ROLE": (keccak("PROPOSER_ROLE".replace("PROPOSER", "CANCELLER")), t["proposers"]),
                 "EXECUTOR_ROLE": (keccak("EXECUTOR_ROLE"), t["executors"]), "DEFAULT_ADMIN_ROLE": ("0x" + "00" * 32, [tl])}
        for role, (h, want) in roles.items():
            got = self.holders(tl, h, from_block)
            if got != {x.lower() for x in want}:
                self.problems.append(f"{name} {role}: held by {sorted(got)}, should be {sorted(x.lower() for x in want)}")

    def locked(self, what, to):
        """initialize must revert with InvalidInitialization, with arguments that would otherwise be accepted."""
        try:
            self.cast("call", to, "initialize(address,address,address,uint256,uint32)", ONE, ONE, ONE, 1, 1) if "book" in what else \
                self.cast("call", to, "initialize(address,address,address)", ONE, ONE, ONE)
        except Fail as e:
            if INVALID_INITIALIZATION in str(e):
                return
            self.problems.append(f"{what}: initialize failed for another reason: {e}")
            return
        self.problems.append(f"{what}: initialize did not revert")

    def check(self, settings=False):
        c, s = self.cfg, self.state
        if not s.get("book"):
            raise Fail("this state file holds no deploy")
        for who, to in (("book implementation", s["bookImpl"]), ("router implementation", s["routerImpl"]), ("book proxy", s["book"]), ("router proxy", s["router"])):
            self.locked(who, to)
        for who, proxy, impl in (("book", s["book"], s["bookImpl"]), ("router", s["router"], s["routerImpl"])):
            self.expect(f"{who} proxy admin", "0x" + self.read("storage", proxy, SLOT_ADMIN)[-40:], s["proxyAdmin"])
            self.expect(f"{who} implementation slot", "0x" + self.read("storage", proxy, SLOT_IMPL)[-40:], impl)
        for who, impl, code in (("book", s["bookImpl"], s["bookImplCode"]), ("router", s["routerImpl"], s["routerImplCode"])):
            self.expect(f"{who} implementation code hash", self.cast("keccak", self.read("code", impl)), self.cast("keccak", code))
        self.expect("ProxyAdmin owner", self.call(s["proxyAdmin"], "owner()(address)"), s["upgradeTimelock"])
        self.expect("book owner", self.call(s["book"], "owner()(address)"), s["settingsTimelock"])
        self.check_timelock("settings timelock", c["settingsTimelock"], s["settingsTimelock"], s["block"])
        if c.get("upgradeTimelock"):
            self.check_timelock("upgrade timelock", c["upgradeTimelock"], s["upgradeTimelock"], s["block"])
        self.expect("deployer holds no role on the timelocks", self.holders(s["settingsTimelock"], "0x" + "00" * 32, s["block"]) & {self.address_of("deployer")}, set())
        art = "0x" + (HERE / "artifacts" / "CantonInbox.creation.hex").read_text().strip()
        pinned = json.loads(Path(self.a.vectors).read_text())["inboxCodeHash"]
        self.expect("inboxCodeHash (the artifact against the pinned value)", self.cast("keccak", art), pinned)
        self.expect("inboxCodeHash (the router's)", self.call(s["router"], "inboxCodeHash()(bytes32)"), pinned)
        for name in ("gateway", "bridge"):
            self.expect(name, self.call(s["router"], name + "()(address)"), c[name])
        self.expect("router book", self.call(s["router"], "book()(address)"), s["book"])
        for name, want in (("refuser", c["refuser"]), ("feeRecipient", c["feeRecipient"]), ("refundWait", c["refundWait"]), ("localNetwork", c["localNetwork"]), ("outOpen", "false"), ("inOpen", "false")):
            self.expect(f"book {name}", self.call(s["book"], f"{name}()({'address' if name in ('refuser', 'feeRecipient') else 'bool' if name.endswith('Open') else 'uint256'})"), want)
        if settings:
            self.check_settings()
        if self.problems:
            raise Fail("read-backs differ:\n  " + "\n  ".join(self.problems))
        print("all read-backs passed")

    def check_settings(self):
        c, s = self.cfg, self.state
        a, b = c["asset"], s["book"]
        row = self.cast("call", b, "assets(address)(uint8,bytes32,uint256,uint256,uint256,uint256,uint256)", a["address"]).split("\n")
        want = [1, a["instrument"], a["feeOut"], a["feeIn"], a["feeRefund"], a["minAmount"], a["lockCap"]]
        for name, got, w in zip(("route state", "instrument", "feeOut", "feeIn", "feeRefund", "minAmount", "lockCap"), row, want):
            self.expect("asset " + name, got.split()[0], w)
        self.expect("canonical token", self.call(b, "canonical(bytes32)(address)", a["instrument"]), a["address"])
        for d in c["destinations"]:
            got = self.cast("call", b, "destinations(uint32)(bool,uint256)", d["network"]).split("\n")
            self.expect(f"destination {d['network']} open", got[0], str(d["open"]).lower())
            self.expect(f"destination {d['network']} unit", got[1].split()[0], d["unit"])
        for f in c["claimFees"]:
            self.expect(f"claim part for network {f['network']}", self.call(b, "claimFee(address,uint32)(uint256)", a["address"], f["network"]), f["fee"])

    # ---- settings through the timelock

    def batch(self):
        c, b, a = self.cfg, self.state["book"], self.cfg["asset"]
        calls = [("setDestination(uint32,bool,uint256)", (d["network"], str(d["open"]).lower(), d["unit"])) for d in c["destinations"]]
        calls.append(("list(address,bytes32,uint256,uint256,uint256,uint256,uint256)", (a["address"], a["instrument"], a["feeOut"], a["feeIn"], a["feeRefund"], a["minAmount"], a["lockCap"])))
        calls += [("setClaimFee(address,uint32,uint256)", (a["address"], f["network"], f["fee"])) for f in c["claimFees"]]
        payloads = [self.cast("calldata", sig, *args) for sig, args in calls]
        salt = self.cast("keccak", "canton-router-settings-" + c["name"])
        return ("[" + ",".join([b] * len(calls)) + "]", "[" + ",".join(["0"] * len(calls)) + "]", "[" + ",".join(payloads) + "]", "0x" + "00" * 32, salt)

    def op_id(self, batch):
        return self.cast("call", self.state["settingsTimelock"], "hashOperationBatch(address[],uint256[],bytes[],bytes32,bytes32)(bytes32)", *batch)

    def schedule(self):
        t, batch = self.state["settingsTimelock"], self.batch()
        if self.address_of("proposer") not in {x.lower() for x in self.cfg["settingsTimelock"]["proposers"]}:
            raise Fail("the proposer keystore is not a proposer of the settings timelock")
        self.send("schedule the settings batch", "proposer", t, "scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)", (*batch, self.cfg["settingsTimelock"]["minDelay"]))
        print("operation", self.op_id(batch), "ready at", self.call(t, "getTimestamp(bytes32)(uint256)", self.op_id(batch)))

    def execute(self):
        t, batch = self.state["settingsTimelock"], self.batch()
        oid = self.op_id(batch)
        if self.call(t, "isOperationReady(bytes32)(bool)", oid) != "true" and self.local:
            self.cast("rpc", "evm_increaseTime", int(self.cfg["settingsTimelock"]["minDelay"]) + 1)  # a local chain only
            self.cast("rpc", "evm_mine")
        if self.call(t, "isOperationReady(bytes32)(bool)", oid) != "true":
            print("not ready until", self.call(t, "getTimestamp(bytes32)(uint256)", oid), "now", int(time.time()))
            sys.exit(3)
        self.send("execute the settings batch", "proposer", t, "executeBatch(address[],uint256[],bytes[],bytes32,bytes32)", batch)
        self.check(settings=True)


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("--config", default=str(HERE / "deploy" / "testnet.json"))
    p.add_argument("--state", default="router-deploy-state.json")
    p.add_argument("--out", default=str(HERE / "out"), help="forge's output folder (forge build)")
    p.add_argument("--vectors", default=str(HERE / "test" / "vectors" / "r1.json"), help="the file with the pinned inboxCodeHash")
    p.add_argument("--live", action="store_true", help="allow a chain that is not on this machine")
    p.add_argument("--rpc-url-file")
    for who in ("deployer", "proposer"):
        p.add_argument(f"--{who}-keystore")
        p.add_argument(f"--{who}-password-file")
    p.add_argument("command", choices=["deploy", "settings-schedule", "settings-execute", "check"])
    p.add_argument("--settings", action="store_true", help="check: also read back the listed asset, destinations and claim parts")
    a = p.parse_args()
    try:
        d = Deploy(a)
        {"deploy": d.deploy, "settings-schedule": d.schedule, "settings-execute": d.execute, "check": lambda: d.check(a.settings)}[a.command]()
    except Fail as e:
        print("FAIL:", e, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
