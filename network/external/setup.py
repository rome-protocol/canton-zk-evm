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

  setup.py --ledger-url <URL> --dar <built DAR> --package-step check|upload|vet [--dry-run]

    The package alone, for an upgrade of a chain that runs (a new version of the same package), in three steps that are run one at a time; nothing
    else is done (no parties, users or chain, and only the ADMIN token is needed). Each prints one JSON line.
      check   POST /v2/dars/validate: the participant checks the DAR (its packages, its dependencies, whether it is a valid upgrade of the one that
              is there) on each synchronizer it is connected to, and keeps nothing.
      upload  POST /v2/packages?vetAllPackages=false: the participant keeps the packages and vets none of them, so no submitter that picks a version
              by package name can come to use the new one. Does nothing if the package is listed already. Stops, naming the package, if the
              participant lists the package as vetted afterwards (a participant that ignores the query parameter): the DAR is on it, vetted.
      vet     POST /v2/package-vetting/update: vets, on each synchronizer, every package of the DAR that this participant has not vetted there yet (the
              main package and the dependencies the DAR carries, read from its .dalf files: the upload vetted none of them, and the participant refuses
              a package whose dependencies are not vetted), in one change, with --dry-run first (the participant prepares the change and answers what
              the vetting would be, and applies nothing). Does nothing where all of them are vetted by this participant.
    Without --package-step the setup above is unchanged: it uploads with vetting on, as before.

  setup.py --ledger-url <URL> --gas-cap-step propose|accept --new-gas-cap <N> [--dry-run]

    Raises the gas cap of a chain that runs (the cap is a field of the chain contract), in two steps, each by one user and each printing one JSON line.
    No DAR, parties or users are touched: the parties are read from $CZE_STATE_DIR/canton/parties.env, as propose.py reads them.
      propose  the operator's token: exercises ProposeGasCap on the chain's one contract (which makes the GasCapProposal). Nothing is done if the same proposal is there already.
      accept   the confirmer's token: exercises AcceptGasCap on the proposal for exactly --new-gas-cap, given the chain's current contract.
    Both refuse, before anything is sent, a value that the Daml would refuse: not above the chain's current cap, more than double it, or over
    300,000,000. With --dry-run nothing is submitted: the step prints what it would do ("dryRun": true). Stop the block producer before the
    accept and start it again after (a block replaces the chain contract, and an accept given a replaced contract is refused: nothing changes,
    and the accept is safe to run again). A re-run of the accept after it went through prints "alreadyAccepted": true. A proposal for a value
    that is not wanted is archived by the operator (the Archive choice, with the operator's token) before another is proposed.

  setup.py --ledger-url <URL> --program-step propose|accept --program-vk <hex> --root-c <hex> --rules-hash <hex> [--dry-run]

    Replaces the program key, the ZisK root and the rules hash of a chain that runs (they are fields of the chain contract), in two steps, each by
    one user and each printing one JSON line. Nothing else is touched. The chain's Advance accepts only a block proven under the pair of keys the
    chain contract holds, so the change takes effect at the first block after the accept; the same two steps with the old values put them back.
    Each value is lowercase hex of 64 digits, without 0x.
      propose  the operator's token (which acts for the operator and the gateway party): exercises ProposeProgram on the chain's one contract. Nothing is done if the same proposal is there already.
      accept   the confirmer's token: exercises AcceptProgram on the proposal for exactly these three values, given the chain's current contract.
    propose refuses a chain that holds these values already; accept on such a chain prints "alreadyAccepted": true. With --dry-run nothing is submitted. Stop the block producer before the accept and start it
    again after, as for the gas cap. A re-run of the accept after it went through prints "alreadyAccepted": true. A proposal for other values is
    archived by the operator (the Archive choice, with the operator's token) before another is proposed. The chain check of a later plain setup run
    compares the chain with the values it is given, so give it the values the chain holds now.

Names: the hints and the Ledger API user ids start with CZE_PARTY_PREFIX and CZE_USER_PREFIX (default "ostia-"; propose.py and the
builder use the same prefix, CZE_LEDGER_USER for the builder). Tokens: CZE_TOKEN_FILE_<ROLE> names a file, mode 0600, with the bearer token of
that role's user (ADMIN for the steps above that need the participant's admin right, then OPERATOR, CONFIRMER). Run on its own, setup.py
applies the rules of check-env.sh itself, before it sends anything: the URL is https or on this machine (127.0.0.1), every token file is
mode 0600 with one token, and ADMIN, OPERATOR and CONFIRMER are all named, unless CZE_LEDGER_NO_AUTH=1 says the Ledger API has no login (then
no token is sent). A token is never printed.
"""
import argparse, json, os, re, subprocess, sys, urllib.error, urllib.parse, urllib.request, zipfile
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


def check_settings(url: str, needed: tuple = TOKEN_ROLES) -> None:
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
        elif role in needed and os.environ.get("CZE_LEDGER_NO_AUTH") != "1":
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

    def upload(self, dar: Path, vet: bool = True) -> None:
        # POST /v2/packages is the upload; a participant that has moved it to /v2/dars (404 here) takes the DAR there. The participant vets what it uploads
        # unless vetAllPackages=false (Canton 3.6.3's OpenAPI: a query parameter of both).
        query = "" if vet else "?vetAllPackages=false"
        if self.call("/v2/packages" + query, dar.read_bytes(), content_type="application/octet-stream")[0] == 404:
            self.call("/v2/dars" + query, dar.read_bytes(), content_type="application/octet-stream")

    def validate(self, dar: Path, synchronizer: str) -> None:
        """POST /v2/dars/validate: the participant checks the DAR on the synchronizer and keeps nothing. A DAR that fails stops with the participant's reason."""
        if self.call("/v2/dars/validate?synchronizerId=" + urllib.parse.quote(synchronizer, safe=""), dar.read_bytes(), content_type="application/octet-stream")[0] == 404:
            raise SystemExit("the participant has no POST /v2/dars/validate, so it cannot check a DAR without uploading it")

    def vet(self, package_ids: list, synchronizer: str, dry_run: bool) -> dict:
        """POST /v2/package-vetting/update: vet the packages (one change) on the synchronizer (this participant's vetting); with dry_run the participant
        prepares the change and applies nothing. Returns the vetting it would hold after the change (a dry run) or holds now."""
        status, answer = self.call("/v2/package-vetting/update", {"changes": [{"operation": {"Vet": {"value": {"packages": [{"packageId": p} for p in package_ids]}}}}],
                                                                  "dryRun": dry_run, "synchronizerId": synchronizer})
        if status == 404:
            raise SystemExit("the participant has no POST /v2/package-vetting/update, so the package cannot be vetted through the Ledger API")
        new = answer.get("newVettedPackages") or {}
        listed = {p.get("packageId") for p in new.get("packages", [])}
        for package_id in package_ids:
            if package_id not in listed:
                raise SystemExit(f"the participant did not answer that the package {package_id} is vetted on {synchronizer} after the change")
        return new

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


def dar_package_ids(dar: Path) -> list:
    """Every package of the DAR: the main package first, then the others (the dependencies the DAR carries), each read from the name of its .dalf
    (the 64 hex digits before .dalf, as dar-id.sh reads the main one)."""
    main = package_id_of(dar)
    try:
        with zipfile.ZipFile(dar) as z:
            names = z.namelist()
    except (zipfile.BadZipFile, OSError):
        return [main]
    found = [m[1] for m in (re.search(r"-([0-9a-f]{64})\.dalf$", n) for n in names) if m]
    return [main] + sorted(set(found) - {main})


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


def connected(node: Participant) -> list:
    synchronizers = node.synchronizers()
    if not synchronizers:
        raise SystemExit("the participant is not connected to a synchronizer")
    return synchronizers


def package_step(node: Participant, dar: Path, step: str, dry_run: bool) -> dict:
    """One of the three steps of putting a new version of the package on a participant (see the top of this file). Returns what it printed."""
    package_id = package_id_of(dar)
    if step == "check":
        for synchronizer in connected(node):
            node.validate(dar, synchronizer)
        log(f"the participant accepts the DAR with the package {package_id}; nothing was uploaded")
        return {"step": "check", "packageId": package_id, "valid": True}
    if step == "upload":
        uploaded = package_id not in node.package_ids()
        if uploaded:
            node.upload(dar, vet=False)
            if package_id not in node.package_ids():
                raise SystemExit(f"the participant took the DAR but does not list the package {package_id}")
            log(f"uploaded the DAR without vetting; the package is {package_id}")
        else:
            log(f"the package {package_id} is on the participant already; nothing was uploaded")
        synchronizers = connected(node)
        vetted = node.vetted(package_id, synchronizers)
        if uploaded and vetted:
            raise SystemExit(f"the participant lists the package {package_id} as vetted on {' and '.join(synchronizers)} although it was uploaded with vetAllPackages=false: "
                             "it ignores that parameter, so the DAR is on it and vetted (nothing else was changed)")
        return {"step": "upload", "packageId": package_id, "uploaded": uploaded, "vetted": vetted}
    if package_id not in node.package_ids():
        raise SystemExit(f"the package {package_id} is not on the participant: upload it first (--package-step upload)")
    wanted, done = dar_package_ids(dar), {}
    for synchronizer in connected(node):
        unvetted = [p for p in wanted if not node.vetted(p, [synchronizer])]
        if not unvetted:
            log(f"the package {package_id} and the {len(wanted) - 1} it depends on in the DAR are vetted on {synchronizer} already")
            done[synchronizer] = "already"
            continue
        node.vet(unvetted, synchronizer, dry_run)
        log(f"{'dry run: would vet' if dry_run else 'vetted'} the package {package_id} and {len(unvetted) - (package_id in unvetted)} of its dependencies on {synchronizer}")
        done[synchronizer] = "dry-run" if dry_run else "vetted"
    return {"step": "vet", "packageId": package_id, "dryRun": dry_run, "synchronizers": done}


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


MAX_GAS_CAP = 300_000_000   # the Daml's maxGasCap


def check_gas_cap(current: int, new: int) -> None:
    """The refusals of the chain's SetGasCap, made before anything is submitted: a cap only goes up, by at most double, and never over MAX_GAS_CAP."""
    if new <= current:
        raise SystemExit(f"the new gas cap {new} must be above the chain's current one ({current}): a cap only goes up")
    if new > 2 * current:
        raise SystemExit(f"the new gas cap {new} is more than double the chain's current one ({current}): a cap may at most double in one change")
    if new > MAX_GAS_CAP:
        raise SystemExit(f"the new gas cap {new} is over the highest a chain may have ({MAX_GAS_CAP})")


def submit_step(ledger, command: dict, step: str) -> None:
    """Submits one command; a refusal stops with the participant's message (an accept is refused when a block replaced the chain contract since it was read)."""
    try:
        ledger.submit(command)
    except urllib.error.HTTPError as err:
        hint = ": the chain may have advanced since it was read, run the accept again" if step == "accept" else ""
        reason = err.read().decode(errors="replace")[:300]
        err.close()
        raise SystemExit(f"the {step} was refused: HTTP {err.code} {reason}{hint}") from None
    except urllib.error.URLError as err:
        raise SystemExit(f"the {step} could not be sent: {err.reason}") from None


def step_chain(url: str, step: str, with_gateway: bool = False) -> tuple:
    """The ledger of the step's user (the operator for a proposal, the confirmer for an acceptance), the chain's one contract and the parties.
    With `with_gateway` the proposal is made as the operator's user acts in the chain's own proposal: for the operator and the gateway party."""
    parties = propose.read_env_file(Path(os.environ.get("CZE_STATE_DIR", ROOT / "state")) / "canton" / "parties.env")
    missing = [k for k in ("OPERATOR_PARTY", "CONFIRMER_PARTY") + (("GATEWAY_PARTY",) if with_gateway and step == "propose" else ()) if not parties.get(k)]
    if missing:
        raise SystemExit(f"parties.env in the state directory does not name {missing}: run setup.py first")
    if step == "propose" and with_gateway:
        ledger = propose.operator_ledger(url, parties)
    elif step == "propose":
        # A gas cap proposal is the operator's alone, so this acts for the operator only (not for the gateway party that the chain's own user also acts for).
        ledger = propose.Ledger(url, propose.user_id("operator"), parties["OPERATOR_PARTY"], token=propose.role_token("operator"))
    else:
        ledger = propose.confirmer_ledger(url, parties)
    chains = ledger.active("ZkChain")
    if len(chains) != 1:
        raise SystemExit(f"expected one chain on this participant, found {len(chains)}")
    [chain] = chains
    if chain.get("operator") != parties["OPERATOR_PARTY"] or chain.get("confirmer") != parties["CONFIRMER_PARTY"]:
        raise SystemExit("the chain on this participant is not between these operator and confirmer parties")
    return ledger, chain


def gas_cap_step(url: str, step: str, new_cap: int, dry_run: bool) -> dict:
    ledger, chain = step_chain(url, step)
    current = int(chain["gasCap"])
    proposals = [p for p in ledger.active("GasCapProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
                 and p.get("confirmer") == chain["confirmer"]]
    result = {"step": step, "chainId": chain["chainId"], "currentGasCap": str(current), "newGasCap": str(new_cap), "dryRun": dry_run}
    if step == "propose":
        check_gas_cap(current, new_cap)
        other = [p for p in proposals if p.get("newCap") != str(new_cap)]
        if other:
            raise SystemExit(f"a proposal for the gas cap {other[0].get('newCap')} is on this participant already. Accept it only if that value is wanted (a raise cannot be undone); "
                             "otherwise the operator archives it (the Archive choice of the GasCapProposal, with the operator's token) and proposes again")
        done = bool(proposals)
        if not done and not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeGasCap",
                                                        "choiceArgument": {"newCap": str(new_cap)}}}, "propose")
        return {**result, "submitted": not done and not dry_run, "alreadyProposed": done}
    mine = [p for p in proposals if p.get("newCap") == str(new_cap)]
    if not mine:
        if current == new_cap:   # a re-run after the accept went through (or committed after a timeout): done
            return {**result, "submitted": False, "alreadyAccepted": True}
        raise SystemExit(f"no proposal for the gas cap {new_cap} is on this participant")
    check_gas_cap(current, new_cap)
    if not dry_run:
        submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "GasCapProposal", "contractId": mine[0]["contractId"], "choice": "AcceptGasCap",
                                                    "choiceArgument": {"chain": chain["contractId"]}}}, "accept")
    return {**result, "submitted": not dry_run}


HEX64 = re.compile(r"[0-9a-f]{64}")
PROGRAM_FIELDS = (("programVK", "--program-vk"), ("rootC", "--root-c"), ("rulesHash", "--rules-hash"))


def check_program(values: dict) -> None:
    """Each key is lowercase hex of 64 digits, as the chain stores it (setup.py checks the length; propose.py takes hex of any length)."""
    for field, flag in PROGRAM_FIELDS:
        if not HEX64.fullmatch(values[field]):
            raise SystemExit(f"{flag} must be 64 lowercase hex digits without 0x")


def program_step(url: str, step: str, new: dict, dry_run: bool) -> dict:
    """ProgramProposal by the operator and the gateway (the operator's user acts for both), AcceptProgram by the confirmer: the chain's program key, ZisK root and rules hash become `new`."""
    check_program(new)
    ledger, chain = step_chain(url, step, with_gateway=True)
    current = {field: chain[field] for field, _ in PROGRAM_FIELDS}
    proposals = [p for p in ledger.active("ProgramProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
                 and p.get("confirmer") == chain["confirmer"] and p.get("gateway") == chain["gateway"]]
    mine = [p for p in proposals if all(p.get("new" + f[0].upper() + f[1:]) == new[f] for f, _ in PROGRAM_FIELDS)]
    result = {"step": step, "chainId": chain["chainId"], "current": current, "new": new, "dryRun": dry_run}
    if step == "propose":
        if current == new:
            raise SystemExit("the chain holds these values already")
        if proposals and not mine:
            raise SystemExit("a proposal for other values is on this participant already. Accept it only if those values are wanted; "
                             "otherwise the operator archives it (the Archive choice of the ProgramProposal, with the operator's token) and proposes again")
        if not mine and not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeProgram",
                                                        "choiceArgument": {"new" + f[0].upper() + f[1:]: new[f] for f, _ in PROGRAM_FIELDS}}}, "propose")
        return {**result, "submitted": not mine and not dry_run, "alreadyProposed": bool(mine)}
    if not mine:
        if current == new:   # a re-run after the accept went through (or committed after a timeout): done
            return {**result, "submitted": False, "alreadyAccepted": True}
        raise SystemExit("no proposal for these values is on this participant")
    if not dry_run:
        submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ProgramProposal", "contractId": mine[0]["contractId"], "choice": "AcceptProgram",
                                                    "choiceArgument": {"chain": chain["contractId"]}}}, "accept")
    return {**result, "submitted": not dry_run}


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
        # The chain is there. It must be this one: the same chain id, program, root key, rules, gateway and a gas cap that is not below the pinned one. ZkChain does not keep the genesis
        # (only the head), so a chain still at block 0 is checked by its head, which is the genesis; later blocks cannot be compared with it.
        want = {"chainId": str(args.chain_id), "programVK": args.program_vk, "rootC": args.root_c, "rulesHash": args.rules_hash,
                "gatewayAddress": args.gateway_address,
                **({"headHash": args.genesis_hash, "headStateRoot": args.genesis_state_root} if chain.get("headNumber") == "0" else {})}
        wrong = [k for k, v in want.items() if chain.get(k) != v]
        # The gas cap may have been raised on a live chain (it only goes up), so the cap in PINS is the lowest this chain may have.
        if not str(chain.get("gasCap")).isdigit() or int(chain["gasCap"]) < int(args.gas_cap):
            wrong.append("gasCap")
        if wrong:
            raise SystemExit(f"a chain is on this participant already and differs in {wrong}: this setup only finds the chain it made")
        log(f"the chain is there already, at block {chain['headNumber']}")
    return {"contractId": chain["contractId"], "chainId": chain["chainId"], "headNumber": chain["headNumber"], "headHash": chain["headHash"], "created": created}


def main(argv: list) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ledger-url", default=os.environ.get("CZE_LEDGER_URL"))
    ap.add_argument("--dar", default=os.environ.get("CZE_DAR"))
    ap.add_argument("--demo", action="store_true", help="also the demo's parties and users (u, v, registry, demo)")
    ap.add_argument("--package-step", choices=("check", "upload", "vet"), help="only this step of putting the DAR's package on the participant (see the top of this file)")
    ap.add_argument("--dry-run", action="store_true", help="with --package-step vet: the participant prepares the vetting and applies nothing; with --gas-cap-step or --program-step: nothing is submitted")
    ap.add_argument("--gas-cap-step", choices=("propose", "accept"), help="raise the chain's gas cap: the operator proposes, the confirmer accepts (see the top of this file)")
    ap.add_argument("--new-gas-cap", type=int, help="with --gas-cap-step: the new gas cap")
    ap.add_argument("--program-step", choices=("propose", "accept"), help="replace the chain's program key, ZisK root and rules hash: the operator proposes, the confirmer accepts (see the top of this file)")
    ap.add_argument("--program-vk", help="with --program-step: the new program key (64 lowercase hex digits)")
    ap.add_argument("--root-c", help="with --program-step: the new ZisK root (64 lowercase hex digits)")
    ap.add_argument("--rules-hash", help="with --program-step: the new rules hash (64 lowercase hex digits)")
    own, rest = ap.parse_known_args(argv)
    rest = [a for a in rest if a != "--"]
    if own.gas_cap_step:
        if not own.ledger_url:
            ap.error("--ledger-url (CZE_LEDGER_URL) is required")
        if own.new_gas_cap is None:
            ap.error("--gas-cap-step needs --new-gas-cap")
        if rest or own.demo or own.package_step or own.program_step or own.program_vk or own.root_c or own.rules_hash:
            ap.error("--gas-cap-step does only the gas cap: no --demo, no --package-step and no chain arguments")
        check_settings(own.ledger_url, ("operator",) if own.gas_cap_step == "propose" else ("confirmer",))
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        print(json.dumps(gas_cap_step(own.ledger_url, own.gas_cap_step, own.new_gas_cap, own.dry_run)))
        return 0
    if own.program_step:
        if not own.ledger_url:
            ap.error("--ledger-url (CZE_LEDGER_URL) is required")
        if None in (own.program_vk, own.root_c, own.rules_hash):
            ap.error("--program-step needs --program-vk, --root-c and --rules-hash")
        if rest or own.demo or own.package_step or own.gas_cap_step or own.new_gas_cap is not None:
            ap.error("--program-step does only the program: no --demo, no --package-step, no --gas-cap-step and no chain arguments")
        new = {"programVK": own.program_vk, "rootC": own.root_c, "rulesHash": own.rules_hash}
        check_program(new)
        check_settings(own.ledger_url, ("operator",) if own.program_step == "propose" else ("confirmer",))
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        print(json.dumps(program_step(own.ledger_url, own.program_step, new, own.dry_run)))
        return 0
    if own.new_gas_cap is not None:
        ap.error("--new-gas-cap goes with --gas-cap-step")
    if own.program_vk or own.root_c or own.rules_hash:
        ap.error("--program-vk, --root-c and --rules-hash go with --program-step")
    if not own.ledger_url or not own.dar:
        ap.error("--ledger-url (CZE_LEDGER_URL) and --dar (CZE_DAR) are required")
    if own.dry_run and own.package_step != "vet":
        ap.error("--dry-run goes with --package-step vet, --gas-cap-step or --program-step")
    if own.package_step and (rest or own.demo):
        ap.error("--package-step does only the package: no --demo and no chain arguments")
    check_settings(own.ledger_url, ("admin",) if own.package_step else TOKEN_ROLES)
    if own.package_step:
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        print(json.dumps(package_step(Participant(own.ledger_url), Path(own.dar), own.package_step, own.dry_run)))
        return 0
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
