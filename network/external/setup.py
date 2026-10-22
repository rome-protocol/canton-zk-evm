#!/usr/bin/env python3
"""Sets Ostia up on an existing Canton participant, the one a Splice validator runs for the Canton Network. See network/README.md.

  setup.py --ledger-url <JSON Ledger API URL> --dar <built DAR> [--demo] [-- <propose.py chain arguments>]

    Against one participant, and idempotent: every step looks for what exists and does only what is missing.
      1. uploads the DAR (POST /v2/packages) unless its main package is listed, and checks that the package is vetted on the
         synchronizer the participant is connected to;
      2. allocates the parties operator, confirmer, gateway, builder and reader (with --demo also u, v and registry), with stable
         hints, and writes their ids to $CZE_STATE_DIR/canton/parties.env;
      3. creates the Ledger API users with exactly the rights each role needs, and stops if a user that is there has others;
      4. with the chain arguments of propose.py (--genesis-hash and the rest): proposes the chain and accepts it, or accepts a
         proposal that an earlier run left, or, if the chain is there, checks that it is this chain. Prints one JSON line: the
         chain's contract id, id and head, and "created".
    One participant hosts every party, so it is the only confirmer. Nothing but the Ledger API is used.

Names: the hints and the Ledger API user ids start with CZE_PARTY_PREFIX and CZE_USER_PREFIX (default "ostia-"; propose.py and the
builder use the same prefix, CZE_LEDGER_USER for the builder). Tokens: CZE_TOKEN_FILE_<ROLE> names a file, mode 0600, with the bearer token of
that role's user (ADMIN for the steps above that need the participant's admin right, then OPERATOR, CONFIRMER). Run on its own, setup.py
applies the rules of check-env.sh itself, before it sends anything: the URL is https or on this machine (127.0.0.1), every token file is
mode 0600 with one token, and ADMIN, OPERATOR and CONFIRMER are all named, unless CZE_LEDGER_NO_AUTH=1 says the Ledger API has no login (then
no token is sent). A token is never printed.
"""
import argparse, json, os, re, subprocess, sys, urllib.error, urllib.parse, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "network" / "canton"))
import propose

# Role: (acts as, reads as, primary party). The rights follow network/canton/bootstrap.canton.
# The operator and the gateway sign the chain together, so the operator's user acts as both; the builder reads what they see and acts as neither.
USERS = {
    "operator": (("operator", "gateway"), (), "operator"),
    "builder": (("builder",), ("operator", "gateway"), "builder"),
    "confirmer": (("confirmer",), (), "confirmer"),
    "reader": ((), ("reader",), "reader"),
}
CHAIN_PARTIES = ("operator", "confirmer", "gateway", "builder", "reader")
DEMO_PARTIES = ("u", "v", "registry")
# The demo's setup (demo/canton.py) acts for U, V and the registry together.
DEMO_USERS = {"u": (("u",), (), "u"), "v": (("v",), (), "v"), "registry": (("registry",), (), "registry"),
              "demo": (("u", "v", "registry"), (), "u")}


# The roles whose token setup.py reads (builder's is not read here, but a file that is named must be as safe as the others).
TOKEN_ROLES = ("admin", "operator", "confirmer")
LOOPBACK_OR_HTTPS = re.compile(r"^(https://[^/]+|http://(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?)(/.*)?$")


def check_settings(url: str) -> None:
    """The rules of network/external/check-env.sh, so that setup.py is as safe when it is run on its own: the URL is https or on this machine (a token
    never crosses a network in the clear), and every token file is read, before anything is sent, so that a bad one stops the run before it
    has changed the participant. A token file is one that others cannot read, with one token in it. Without CZE_LEDGER_NO_AUTH=1 every role
    that setup.py reads needs its file."""
    if not LOOPBACK_OR_HTTPS.match(url):
        raise SystemExit("the Ledger API URL must be https, or http on this machine (127.0.0.1): a token must not cross a network in the clear")
    for role in ("builder", *TOKEN_ROLES):
        var = "CZE_TOKEN_FILE_" + role.upper()
        if os.environ.get(var):
            propose.role_token(role)   # refuses a file that others can read, an unreadable one, an empty one, and one with more than a token
        elif role in TOKEN_ROLES and os.environ.get("CZE_LEDGER_NO_AUTH") != "1":
            raise SystemExit(f"{var} is not set: a file with the {role} user's token (or CZE_LEDGER_NO_AUTH=1 for a Ledger API with no login)")


def log(message: str) -> None:
    print("setup: " + message, file=sys.stderr)


def http(url: str, token, data=None, content_type="application/json", method=None):
    """(status, parsed body); a 404 is an answer, any other error stops with the participant's message."""
    body = data if isinstance(data, bytes) else (json.dumps(data).encode() if data is not None else None)
    request = urllib.request.Request(url, body, {"content-type": content_type, **propose.auth(token)}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=300) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return 404, {}
        raise SystemExit(f"{url}: HTTP {err.code} {err.read().decode(errors='replace')[:300]}") from None
    except urllib.error.URLError as err:
        raise SystemExit(f"{url}: {err.reason}") from None


class Participant:
    def __init__(self, url: str):
        self.url, self.admin, self._namespace = url.rstrip("/"), propose.role_token("admin"), None

    def call(self, path, data=None, **kw):
        return http(self.url + path, self.admin, data, **kw)

    def package_ids(self) -> list:
        return self.call("/v2/packages")[1].get("packageIds", [])

    def upload(self, dar: Path) -> None:
        # POST /v2/packages is the upload; a participant that has moved it to /v2/dars (404 here) takes the DAR there.
        if self.call("/v2/packages", dar.read_bytes(), content_type="application/octet-stream")[0] == 404:
            self.call("/v2/dars", dar.read_bytes(), content_type="application/octet-stream")

    def synchronizers(self) -> list:
        found = self.call("/v2/state/connected-synchronizers")[1].get("connectedSynchronizers", [])
        return [s["synchronizerId"] for s in found]

    def own_id(self):
        """This participant's id, or None if it does not say."""
        status, answer = self.call("/v2/parties/participant-id")
        return answer.get("participantId") if status == 200 else None

    def vetted(self, package_id: str, synchronizers: list):
        """True or False once the participant says whether the package is vetted, by THIS participant, on one of the synchronizers; None if it offers
        no vetting list. The vetting of another participant on the synchronizer does not count."""
        me = self.own_id()
        status, answer = self.call("/v2/package-vetting/list", {"packageMetadataFilter": {"packageIds": [package_id], "packageNamePrefixes": []},
                                                                "topologyStateFilter": {"participantIds": [me] if me else [], "synchronizerIds": []}})
        if status == 404:
            return None
        return any(v.get("synchronizerId") in synchronizers and v.get("participantId", me) == me and any(p.get("packageId") == package_id for p in v.get("packages", []))
                   for v in answer.get("vettedPackages", []))

    def namespace(self) -> str:
        """The namespace of this participant, the fingerprint after the last "::" of its id: every party it allocates has an id that ends with it."""
        if not self._namespace:
            me = self.own_id()
            if not me or "::" not in me:
                raise SystemExit("the participant does not say its id (GET /v2/parties/participant-id), so the setup cannot tell which parties are its own")
            self._namespace = me.rsplit("::", 1)[1]
        return self._namespace

    def party(self, hint: str):
        """The id of the party this participant hosts under the hint, or None. One lookup by id (a party allocated with the hint H has the id H::<namespace>):
        listing every party would read all the parties the participant knows, which on a busy network are hundreds of thousands."""
        expected = f"{hint}::{self.namespace()}"
        status, answer = self.call("/v2/parties/" + urllib.parse.quote(expected, safe=""))
        if status == 404:
            return None
        return expected if any(p.get("party") == expected and p.get("isLocal") is True for p in answer.get("partyDetails", [])) else None

    def allocate(self, hint: str) -> str:
        return self.call("/v2/parties", {"partyIdHint": hint, "identityProviderId": ""})[1]["partyDetails"]["party"]

    def rights(self, user: str):
        """The user's rights as {(kind, party)}, or None if there is no such user."""
        status, answer = self.call(f"/v2/users/{user}/rights")
        if status == 404:
            return None
        return {(kind, (body.get("value") or {}).get("party")) for r in answer.get("rights", []) for kind, body in r["kind"].items()}

    def create_user(self, user: str, primary: str, rights: set) -> None:
        self.call("/v2/users", {"user": {"id": user, "primaryParty": primary, "isDeactivated": False, "identityProviderId": ""},
                                "rights": [right_json(k, p) for k, p in sorted(rights)]})

    def grant(self, user: str, rights: set) -> None:
        self.call(f"/v2/users/{user}/rights", {"userId": user, "identityProviderId": "",
                                               "rights": [right_json(k, p) for k, p in sorted(rights)]})


def right_json(kind: str, party: str) -> dict:
    return {"kind": {kind: {"value": {"party": party}}}}


def wanted_rights(acts, reads, parties) -> set:
    return {("CanActAs", parties[a]) for a in acts} | {("CanReadAs", parties[r]) for r in reads}


def package_id_of(dar: Path) -> str:
    """The DAR's main package id, as network/canton/dar-id.sh reads it."""
    out = subprocess.run([str(ROOT / "network" / "canton" / "dar-id.sh"), str(dar)], capture_output=True, text=True, check=True).stdout
    return next(line.split("=", 1)[1] for line in out.splitlines() if line.startswith("package_id="))


def ensure_package(node: Participant, dar: Path) -> None:
    package_id = package_id_of(dar)
    if package_id in node.package_ids():
        log(f"the package {package_id} is on the participant")
    else:
        node.upload(dar)
        if package_id not in node.package_ids():
            raise SystemExit(f"the participant took the DAR but does not list the package {package_id}")
        log(f"uploaded the DAR; the package is {package_id}")
    synchronizers = node.synchronizers()
    if not synchronizers:
        raise SystemExit("the participant is not connected to a synchronizer")
    vetted = node.vetted(package_id, synchronizers)
    if vetted is False:
        raise SystemExit(f"the package {package_id} is not vetted on the synchronizer the participant is connected to: vet it (the validator's operator can), then run this again")
    log("the package is vetted on the synchronizer" if vetted else "WARN: the participant has no vetting list; the chain proposal below fails if the package is not vetted")


def ensure_parties(node: Participant, hints: tuple, prefix: str) -> dict:
    parties = {}
    for name in hints:
        found = node.party(prefix + name)
        if found is None:
            found = node.allocate(prefix + name)
            log(f"allocated the party {prefix}{name}")
            if found != f"{prefix}{name}::{node.namespace()}":
                log(f"the participant gave the party {prefix}{name} the id {found}, not the one expected; using it")
        parties[name] = found
    return parties


def ensure_users(node: Participant, users: dict, parties: dict) -> None:
    for role, (acts, reads, primary) in users.items():
        user, wanted = propose.user_id(role), wanted_rights(acts, reads, parties)
        have = node.rights(user)
        if have is None:
            node.create_user(user, parties[primary], wanted)
            log(f"created the user {user}")
        elif have - wanted:
            raise SystemExit(f"the user {user} has rights that {role} does not need: {sorted(have - wanted)}. Remove them on the participant, then run this again")
        elif wanted - have:
            node.grant(user, wanted - have)
            log(f"granted the user {user} {len(wanted - have)} missing right(s)")


def write_parties(parties: dict, state: Path) -> None:
    text = "".join(f"{name.upper()}_PARTY={party}\n" for name, party in parties.items())
    out = state / "canton" / "parties.env"
    if out.exists() and out.read_text() == text:
        return
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    out.chmod(0o600)


def ensure_chain(args, named: dict, url: str) -> dict:
    parties = {name.upper() + "_PARTY": party for name, party in named.items()}   # as propose.py reads them from parties.env
    operator = propose.operator_ledger(url, parties)
    [chain, *_] = operator.active("ZkChain") or [None]
    created = chain is None
    if created:
        propose.propose(args, parties, url, url, resume=True)
        [chain] = operator.wait_for("ZkChain")
        log("proposed the chain and accepted it")
    else:
        # The chain is there. It must be this one: the same chain id, program, root key, rules, gas cap and gateway. ZkChain does not keep the genesis
        # (only the head), so a chain still at block 0 is checked by its head, which is the genesis; later blocks cannot be compared with it.
        want = {"chainId": str(args.chain_id), "programVK": args.program_vk, "rootC": args.root_c, "rulesHash": args.rules_hash,
                "gasCap": str(args.gas_cap), "gatewayAddress": args.gateway_address,
                **({"headHash": args.genesis_hash, "headStateRoot": args.genesis_state_root} if chain.get("headNumber") == "0" else {})}
        wrong = [k for k, v in want.items() if chain.get(k) != v]
        if wrong:
            raise SystemExit(f"a chain is on this participant already and differs in {wrong}: this setup only finds the chain it made")
        log(f"the chain is there already, at block {chain['headNumber']}")
    return {"contractId": chain["contractId"], "chainId": chain["chainId"], "headNumber": chain["headNumber"], "headHash": chain["headHash"], "created": created}


def main(argv: list) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ledger-url", default=os.environ.get("CZE_LEDGER_URL"))
    ap.add_argument("--dar", default=os.environ.get("CZE_DAR"))
    ap.add_argument("--demo", action="store_true", help="also the demo's parties and users (u, v, registry, demo)")
    own, rest = ap.parse_known_args(argv)
    rest = [a for a in rest if a != "--"]
    if not own.ledger_url or not own.dar:
        ap.error("--ledger-url (CZE_LEDGER_URL) and --dar (CZE_DAR) are required")
    check_settings(own.ledger_url)
    chain_args = propose.parse(rest, propose.read_env_file(ROOT / "PINS"))[1] if rest else None
    prefix = os.environ.get("CZE_PARTY_PREFIX", "ostia-")
    os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
    node = Participant(own.ledger_url)
    ensure_package(node, Path(own.dar))
    parties = ensure_parties(node, CHAIN_PARTIES + (DEMO_PARTIES if own.demo else ()), prefix)
    ensure_users(node, {**USERS, **(DEMO_USERS if own.demo else {})}, parties)
    write_parties(parties, Path(os.environ.get("CZE_STATE_DIR", ROOT / "state")))
    if chain_args is not None:
        print(json.dumps(ensure_chain(chain_args, parties, own.ledger_url)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
