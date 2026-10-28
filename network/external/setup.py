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
    that is not wanted is taken back by the operator (--withdraw-proposal gas-cap, the WithdrawGasCap choice, with the operator's token; the confirmer can also reject it) before another is proposed.

  setup.py --ledger-url <URL> --program-step propose|accept --program-vk <hex> --root-c <hex> --rules-hash <hex> [--dry-run]

    Replaces the program key, the ZisK root and the rules hash of a chain that runs (they are fields of the chain contract), in two steps, each by
    one user and each printing one JSON line. Nothing else is touched. The chain's Advance accepts only a block proven under the pair of keys the
    chain contract holds, so the change takes effect at the first block after the accept; the same two steps with the old values put them back.
    Each value is lowercase hex of 64 digits, without 0x.
      propose  the operator's token (which acts for the operator and the gateway party): exercises ProposeProgram on the chain's one contract. Nothing is done if the same proposal is there already.
      accept   the confirmer's token: exercises AcceptProgram on the proposal for exactly these three values, given the chain's current contract.
    propose refuses a chain that holds these values already; accept on such a chain prints "alreadyAccepted": true. With --dry-run nothing is submitted. Stop the block producer before the accept and start it
    again after, as for the gas cap. A re-run of the accept after it went through prints "alreadyAccepted": true. A proposal for other values is
    taken back by the operator (--withdraw-proposal program, the WithdrawProgram choice, with the operator's token; the confirmer can also reject it) before another is proposed. The chain check of a later plain setup run
    compares the chain with the values it is given, so give it the values the chain holds now.

  setup.py --ledger-url <URL> --change-delay-step propose|accept --delay-seconds <N> [--dry-run]

    Sets the wait that a gas-cap or program change sits out between its proposal and its accept (the chain's changeDelay; a chain made without it
    has no wait, and 0 takes it away again; at most 30 days), in two steps, each by one user and each printing one JSON line.
      propose  the operator's token (which acts for the operator and the gateway party): exercises ProposeChangeDelay on the chain's one contract. Nothing is done if the same proposal is there already.
      accept   the confirmer's token: exercises AcceptChangeDelay on the proposal for exactly --delay-seconds, given the chain's current contract.
    The change of the delay waits out the delay the chain has when it is accepted, like any other change, so a wait cannot be cut short by one step.
    There is no emergency bypass in this version; the wait binds the propose/accept path (see network/README.md, "The wait before a change").
    The gas-cap and program steps print the wait too: "changeDelaySeconds", and for a proposal that is there "proposedAt" (the ledger time it was made at)
    and "acceptableAt" (proposedAt plus the wait). An accept before that time is refused, by this script first and by the chain in any case.
    A dry run of the accept prints the times and sends nothing, so it is the way to ask when a proposal can be accepted.

  setup.py --ledger-url <URL> --pause-step pause|unpause|renew-propose|renew-accept [--pause-seconds <N>] [--dry-run]

    The pause of the Canton legs (deposits, withdrawals and payments; the chain's Advance refuses a block that carries a leg while the pause is in force). Each step prints
    one JSON line with "paused", "pausedUntil", "pauseCooldownUntil" and "pauseLimitSeconds" (the longest a pause may run from the moment it is made: the chain's
    pauseMax, or 3 days). A pause always ends by itself at its "pausedUntil"; legs work again then, and nothing has to be done.
      pause           the confirmer's token, alone, the emergency brake: exercises PauseLegs on the chain's one contract. The pause runs for the longest a pause may run.
                      The confirmer alone may start a new one only from "pauseCooldownUntil" on (a pause that ended or was lifted early, then as long again as it ran); the
                      step refuses before that (CZE_SKIP_WAIT_CHECK=1 sends it anyway, for the ledger to refuse). Does nothing, "alreadyPaused", if the legs are paused. The pause consumes the chain's
                      contract, so a block committed at the same moment makes the ledger refuse it: the step is safe to run again. The printed state is read again after it.
      unpause         the confirmer's token: exercises UnpauseLegs, which lifts the pause early. Does nothing, "alreadyUnpaused", if the legs are not paused.
      renew-propose   the operator's token: exercises ProposeRenewPause for --pause-seconds (1 up to the longest a pause may run). Nothing is done if the same proposal is there already.
      renew-accept    the confirmer's token: exercises AcceptRenewPause on the proposal for exactly --pause-seconds. The legs are then paused until that long from the
                      moment of the accept, which also starts a pause from nothing and is not held to the cooldown. This is how a pause is renewed: only the operator and the
                      confirmer together can keep it going, and each renewal ends within the longest a pause may run from its own accept. There is no wait before it, but the accept is refused
                      for a proposal more than an hour old: the operator takes it back (--withdraw-proposal renew-pause) and proposes it again for the incident at hand (renew-propose refuses while the old one is there). The line prints the proposal's "proposedAt" and
                      "acceptableUntil" (an hour later) and the step refuses, before sending, once that time has passed. A re-run after an accept that went through, when no
                      proposal is there and the legs are paused, prints the pause state with "noProposal": true and succeeds.
    A proposal that is not wanted is taken back by the operator (--withdraw-proposal renew-pause). With --dry-run nothing is submitted.

  setup.py --ledger-url <URL> --leg-limits-step propose|accept (--quota <units> --quota-window-seconds <N> | --no-quota) [--pause-max-seconds <N>] [--dry-run]

    Sets the withdrawal quota of the chain's legs and the longest a pause may run, in two steps, each by one user and each printing one JSON line.
    The quota is at most --quota units of each Canton instrument withdrawn in any --quota-window-seconds (1 up to 30 days); --no-quota takes it away (no quota is the
    behaviour of a chain made before it). Without --pause-max-seconds the longest pause is the default of 3 days; it may be set from 1 second to 14 days.
    All three values are replaced together, so name all that are wanted: the line prints "current" and "new" for a check before the accept.
      propose  the operator's token: exercises ProposeLegLimits on the chain's one contract. Nothing is done if the same proposal is there already.
      accept   the confirmer's token: exercises AcceptLegLimits on the proposal for exactly these values, given the chain's current contract.
    The accept waits out the chain's change delay like a gas cap (the line prints "proposedAt" and "acceptableAt"; a dry run of the accept sends nothing). The
    change may loosen a limit or tighten it. A proposal not wanted is taken back by the operator (--withdraw-proposal leg-limits).

  setup.py --ledger-url <URL> --contract-step propose|accept|withdraw|reject|add --contract-address <hex> [--contract-kind gateway|vault] [--reth-url <URL>] [--dry-run]

    The chain's registry of EVM contracts (Daml 0.5.0, ZkChain.contracts), in the steps of a program change, each printing one JSON line. The entry is
    the address, the kind and the code hash, which is the keccak-256 of the code that reth holds at the address (eth_getCode at the finalized block).
    propose, accept and add refuse unless that hash is the keccak-256 of the reviewed build in this repo: gateway/Gateway.bin-runtime for --contract-kind
    gateway, gateway/Vault.bin-runtime for vault. A vault's code is no gateway's and the other way round, so each is refused as the other kind.
      propose   the operator's token (which acts for the operator and the gateway party): exercises ProposeContract on the chain's one contract. Nothing is done if the same proposal is there already.
      accept    the confirmer's token: exercises AcceptContract on the proposal for exactly this entry, once the chain's change delay has passed (the line prints "proposedAt" and "acceptableAt").
      withdraw  the operator's token (WithdrawContract) on every pending proposal for the address. reject is the confirmer's RejectContract on them.
      add       AddContract at once, signed by the operator, the confirmer and the gateway together: for a participant that hosts all three and whose operator user holds the confirmer's right too. It skips the change delay.
    There is no removal: a Gateway entry stops every block of the chain until the builder sends its proofs (builder 0.5.0 does), so look with --dry-run first.
    Accept no Gateway entry before the builder sends its proofs (pinned to 0.5.0) and the explorer reads the legs of registered gateways.
    With --dry-run nothing is submitted.

  setup.py --ledger-url <URL> --twin-step propose|accept|withdraw|reject|add --twin-token <hex> [--twin-decimals <0-36> --twin-rules <contract id>] [--twin-rules-disclosed <FILE>] [--reth-url <URL>] [--dry-run]

    The chain's pinned twins (Daml 0.5.0, ZkChain.twins): an ERC-20's address, its decimals and the TwinRules contract of its Canton twin, in the steps of
    the registry, each printing one JSON line. The twin legs of the builder name exactly the pinned rules; an unpinned token has no twin leg.
      propose   the operator's token (which acts for the operator and the gateway party): exercises ProposeTwin on the chain's one contract. Nothing is done if the same proposal is there already.
      accept    the confirmer's token: exercises AcceptTwin on the proposal for exactly this entry, once the chain's change delay has passed. The confirmer cannot see the rules
                (the gateway is their admin), so --twin-rules-disclosed names a file with the rules as a disclosed contract: a JSON object with templateId, contractId (the
                --twin-rules), createdEventBlob and synchronizerId, as the gateway's participant gives it from the active contracts with the blob. The accept is refused without it.
      withdraw  the operator's token (WithdrawTwin) on every pending proposal for the token. reject is the confirmer's RejectTwin on them.
      add       AddTwin at once, signed by the operator, the confirmer and the gateway together, as --contract-step add does. It skips the change delay.
    This version has no removal of a pin, so propose, accept and add first read the ERC-20 from reth (--reth-url, https or http on this machine; the finalized block): there must be code
    at the token's address and its decimals() must be --twin-decimals, or the step is refused. The JSON line has the decimals read (tokenDecimals).
    With --dry-run nothing is submitted.

  setup.py --ledger-url <URL> --withdraw-proposal gas-cap|program|change-delay|leg-limits|renew-pause [--dry-run]

    The operator's token: withdraws every pending proposal of that kind for the chain (the Withdraw choice). The confirmer rejects one with
    the Reject choice instead. It takes no values: naming a gas cap, keys or a delay with it is refused.

Names: the hints and the Ledger API user ids start with CZE_PARTY_PREFIX and CZE_USER_PREFIX (default "ostia-"; propose.py and the
builder use the same prefix, CZE_LEDGER_USER for the builder). Tokens: CZE_TOKEN_FILE_<ROLE> names a file, mode 0600, with the bearer token of
that role's user (ADMIN for the steps above that need the participant's admin right, then OPERATOR, CONFIRMER). Run on its own, setup.py
applies the rules of check-env.sh itself, before it sends anything: the URL is https or on this machine (127.0.0.1), every token file is
mode 0600 with one token, and ADMIN, OPERATOR and CONFIRMER are all named, unless CZE_LEDGER_NO_AUTH=1 says the Ledger API has no login (then
no token is sent). A token is never printed.
"""
import argparse, functools, json, os, re, subprocess, sys, urllib.error, urllib.parse, urllib.request, zipfile
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "network" / "canton"))
sys.path.insert(0, str(ROOT / "builder"))
import propose
from keccak import keccak256

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


def submit_step(ledger, command: dict, step: str, disclosed: list = ()) -> None:
    """Submits one command (with disclosed contracts, when it needs them); a refusal stops with the participant's message (an accept is refused when a block
    replaced the chain contract since it was read)."""
    try:
        ledger.submit(command, *([disclosed] if disclosed else []))
    except urllib.error.HTTPError as err:
        hint = f": the chain may have advanced since it was read, run the {step} again" if step in ("propose", "accept") else ""
        reason = err.read().decode(errors="replace")[:1500]
        err.close()
        raise SystemExit(f"the {step} was refused: HTTP {err.code} {reason}{hint}") from None
    except urllib.error.URLError as err:
        raise SystemExit(f"the {step} could not be sent: {err.reason}") from None


def step_chain(url: str, step: str, with_gateway: bool = False) -> tuple:
    """The ledger of the step's user (the operator for a proposal, the confirmer for an acceptance), the chain's one contract and the parties.
    With `with_gateway` the proposal is made as the operator's user acts in the chain's own proposal: for the operator and the gateway party."""
    parties = propose.read_env_file(Path(os.environ.get("CZE_STATE_DIR", ROOT / "state")) / "canton" / "parties.env")
    missing = [k for k in ("OPERATOR_PARTY", "CONFIRMER_PARTY") + (("GATEWAY_PARTY",) if (with_gateway and step == "propose") or step == "add" else ()) if not parties.get(k)]
    if missing:
        raise SystemExit(f"parties.env in the state directory does not name {missing}: run setup.py first")
    if step == "add":
        # AddContract is signed by the operator, the confirmer and the gateway together, so one user acts for all three: a participant that hosts them
        # all, whose operator user has also been given the confirmer's right. The participant refuses the command otherwise.
        ledger = propose.Ledger(url, propose.user_id("operator"), parties["OPERATOR_PARTY"], (parties["GATEWAY_PARTY"], parties["CONFIRMER_PARTY"]),
                                propose.role_token("operator"))
    elif step == "propose" and with_gateway:
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


CHOICE_SUFFIX = {"gas-cap": "GasCap", "program": "Program", "change-delay": "ChangeDelay", "leg-limits": "LegLimits", "renew-pause": "RenewPause"}
PROPOSAL_KINDS = {"gas-cap": "GasCapProposal", "program": "ProgramProposal", "change-delay": "ChangeDelayProposal", "leg-limits": "LegLimitsProposal", "renew-pause": "RenewPauseProposal"}


def withdraw_step(url: str, kind: str, dry_run: bool) -> dict:
    """The operator takes back its pending proposals of one kind for this chain (the WithdrawGasCap, WithdrawProgram, WithdrawChangeDelay, WithdrawLegLimits or WithdrawRenewPause choice; the operator alone controls it, and the confirmer can reject instead)."""
    ledger, chain = step_chain(url, "propose")
    template = PROPOSAL_KINDS[kind]
    found = [p for p in ledger.active(template) if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"] and p.get("confirmer") == chain["confirmer"]]
    if not dry_run:
        for p in found:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + template, "contractId": p["contractId"], "choice": "Withdraw" + CHOICE_SUFFIX[kind], "choiceArgument": {}}}, "withdraw")
    return {"step": "withdraw", "kind": kind, "chainId": chain["chainId"], "pending": len(found), "withdrawn": 0 if dry_run else len(found), "dryRun": dry_run}


MAX_CHANGE_DELAY = 30 * 24 * 3600   # the Daml's maxChangeDelay (30 days), in seconds


def delay_us(value) -> int:
    """A change delay as the ledger gives it (an Optional RelTime: null, or {"microseconds": "<n>"}), in microseconds; no delay is 0."""
    if value is None:
        return 0
    return int(value["microseconds"] if isinstance(value, dict) else value)


def seconds_of(us: int):
    return us // 1_000_000 if us % 1_000_000 == 0 else us / 1_000_000


def parse_time(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def show_time(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def timing(proposal, chain: dict) -> dict:
    """What a step prints about the wait: the chain's change delay and, for a proposal that is there, when it was made and from when it may be accepted
    (its ledger time plus the chain's delay now; the delay that counts is the one in force at the accept)."""
    delay = delay_us(chain.get("changeDelay"))
    out = {"changeDelaySeconds": seconds_of(delay)}
    if proposal and proposal.get("proposedAt"):
        out["proposedAt"] = show_time(parse_time(proposal["proposedAt"]))   # the ledger trims the fraction; print both times in one form
        out["acceptableAt"] = show_time(parse_time(proposal["proposedAt"]) + timedelta(microseconds=delay))
    return out


def check_waited(result: dict, what: str) -> None:
    """Before an accept is sent: the proposal's wait is not over by this machine's clock. The ledger decides (it uses its own time), so this only saves a refused command."""
    ready = result.get("acceptableAt")
    if os.environ.get("CZE_SKIP_WAIT_CHECK"):   # for the package-upgrade scenario: send the accept anyway, so the ledger's own refusal is seen
        return
    if ready and datetime.now(timezone.utc) < parse_time(ready):
        raise SystemExit(f"the change of {what} may be accepted from {ready} (proposed at {result['proposedAt']}, change delay {result['changeDelaySeconds']} s): run the accept again then")


def gas_cap_step(url: str, step: str, new_cap: int, dry_run: bool) -> dict:
    ledger, chain = step_chain(url, step)
    current = int(chain["gasCap"])
    def pending():
        return [p for p in ledger.active("GasCapProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
                and p.get("confirmer") == chain["confirmer"]]
    proposals = pending()
    result = {"step": step, "chainId": chain["chainId"], "currentGasCap": str(current), "newGasCap": str(new_cap), "dryRun": dry_run}
    if step == "propose":
        check_gas_cap(current, new_cap)
        other = [p for p in proposals if p.get("newCap") != str(new_cap)]
        if other:
            raise SystemExit(f"a proposal for the gas cap {other[0].get('newCap')} is on this participant already. Accept it only if that value is wanted (a raise cannot be undone); "
                             "otherwise the operator takes it back (--withdraw-proposal gas-cap: the Withdraw choice of the GasCapProposal, with the operator's token) and proposes again")
        done = bool(proposals)
        if not done and not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeGasCap",
                                                        "choiceArgument": {"newCap": str(new_cap)}}}, "propose")
        if not done and not dry_run:
            proposals = pending()   # read again, for the time the ledger gave it
        return {**result, "submitted": not done and not dry_run, "alreadyProposed": done, **timing((proposals or [None])[0], chain)}
    mine = [p for p in proposals if p.get("newCap") == str(new_cap)]
    if not mine:
        if current == new_cap:   # a re-run after the accept went through (or committed after a timeout): done
            return {**result, "submitted": False, "alreadyAccepted": True}
        raise SystemExit(f"no proposal for the gas cap {new_cap} is on this participant")
    check_gas_cap(current, new_cap)
    result.update(timing(mine[0], chain))
    if not dry_run:
        check_waited(result, "the gas cap")
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
    def pending():
        found = [p for p in ledger.active("ProgramProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
                 and p.get("confirmer") == chain["confirmer"] and p.get("gateway") == chain["gateway"]]
        return found, [p for p in found if all(p.get("new" + f[0].upper() + f[1:]) == new[f] for f, _ in PROGRAM_FIELDS)]
    proposals, mine = pending()
    result = {"step": step, "chainId": chain["chainId"], "current": current, "new": new, "dryRun": dry_run}
    if step == "propose":
        if current == new:
            raise SystemExit("the chain holds these values already")
        if proposals and not mine:
            raise SystemExit("a proposal for other values is on this participant already. Accept it only if those values are wanted; "
                             "otherwise the operator takes it back (--withdraw-proposal program: the Withdraw choice of the ProgramProposal, with the operator's token) and proposes again")
        if not mine and not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeProgram",
                                                        "choiceArgument": {"new" + f[0].upper() + f[1:]: new[f] for f, _ in PROGRAM_FIELDS}}}, "propose")
        was_there = bool(mine)
        if not mine and not dry_run:
            mine = pending()[1]   # read again, for the time the ledger gave it
        return {**result, "submitted": not was_there and not dry_run, "alreadyProposed": was_there, **timing((mine or [None])[0], chain)}
    if not mine:
        if current == new:   # a re-run after the accept went through (or committed after a timeout): done
            return {**result, "submitted": False, "alreadyAccepted": True}
        raise SystemExit("no proposal for these values is on this participant")
    result.update(timing(mine[0], chain))
    if not dry_run:
        check_waited(result, "the program")
        submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ProgramProposal", "contractId": mine[0]["contractId"], "choice": "AcceptProgram",
                                                    "choiceArgument": {"chain": chain["contractId"]}}}, "accept")
    return {**result, "submitted": not dry_run}


# ---- the registry of EVM contracts (Daml 0.5.0: ZkChain.contracts) --------------------------------------------------------------------------

CONTRACT_BUILDS = {"gateway": "Gateway.bin-runtime", "vault": "Vault.bin-runtime"}   # the reviewed builds in the repo
CONTRACT_KINDS = {"gateway": "Gateway", "vault": "Vault"}
ADDRESS40 = re.compile(r"[0-9a-f]{40}")
MAX_CONTRACTS = 16   # the Daml's maxContracts


@functools.lru_cache(maxsize=None)
def reviewed_hash(kind: str) -> str:
    """The keccak-256 (64 hex digits) of the runtime code of the reviewed build of that kind, which is gateway/<Kind>.bin-runtime in this repo."""
    path = ROOT / "gateway" / CONTRACT_BUILDS[kind]
    try:
        return keccak256(bytes.fromhex(path.read_text().strip())).hex()
    except (OSError, ValueError) as e:
        raise SystemExit(f"cannot read the reviewed build {path}: {e}") from None


def deployed_hash(reth_url: str, address: str) -> str:
    """The keccak-256 of the code that reth holds at the address (at the finalized block, the one Canton has committed)."""
    try:
        answer = propose.post(reth_url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getCode", "params": ["0x" + address, "finalized"]})
    except (OSError, ValueError) as e:
        raise SystemExit(f"cannot ask reth for the code at {address}: {e}") from None
    code = answer.get("result") if isinstance(answer, dict) else None
    if not isinstance(code, str) or not re.fullmatch(r"0x([0-9a-f]{2})*", code):
        raise SystemExit(f"reth gave no code for {address}: {answer!r}")
    if code == "0x":
        raise SystemExit(f"there is no code at {address} (at reth's finalized block)")
    return keccak256(bytes.fromhex(code[2:])).hex()


def check_contract(reth_url: str, address: str, kind: str) -> str:
    """The code hash of the entry, after checking that the code at the address is exactly the reviewed build of that kind: a gateway entry only for
    a gateway build, a vault entry only for a vault build. Anything else is refused."""
    code_hash = deployed_hash(reth_url, address)
    for other, name in CONTRACT_BUILDS.items():
        if other != kind and code_hash == reviewed_hash(other):
            raise SystemExit(f"the code at {address} is the {other} build ({name}), not a {kind}: it cannot be a {kind} entry")
    if code_hash != reviewed_hash(kind):
        raise SystemExit(f"the code at {address} (keccak-256 {code_hash}) is not the reviewed {kind} build, gateway/{CONTRACT_BUILDS[kind]} "
                         f"(keccak-256 {reviewed_hash(kind)})")
    return code_hash


def twin_token_decimals(reth_url: str, token: str, decimals: int) -> int:
    """The ERC-20's own decimals, read from reth at the finalized block (`decimals()` at the address), after checking that there is code at the address
    and that they are the decimals asked for. A pin cannot be removed and every lock and release is scaled by its decimals, so a pin with the wrong ones
    would inflate or deflate the twin against the vault for good: anything else is refused."""
    def ask(method: str, params: list):
        try:
            answer = propose.post(reth_url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        except (OSError, ValueError) as e:
            raise SystemExit(f"cannot ask reth about the token {token}: {e}") from None
        return answer.get("result") if isinstance(answer, dict) else None
    code = ask("eth_getCode", ["0x" + token, "finalized"])
    if not isinstance(code, str) or not re.fullmatch(r"0x([0-9a-f]{2})*", code):
        raise SystemExit(f"reth gave no code for {token}")
    if code == "0x":
        raise SystemExit(f"there is no code at {token} (at reth's finalized block): it is not an ERC-20")
    word = ask("eth_call", [{"to": "0x" + token, "data": "0x313ce567"}, "finalized"])   # decimals()
    if not isinstance(word, str) or not re.fullmatch(r"0x[0-9a-f]{64}", word) or int(word, 16) > 255:
        raise SystemExit(f"the token {token} gave no decimals (decimals() answered {word!r})")
    if int(word, 16) != decimals:
        raise SystemExit(f"the token {token} has {int(word, 16)} decimals, not {decimals}: a pin with other decimals scales every lock and release wrongly, for good")
    return int(word, 16)


def entry_of(address: str, code_hash: str, kind: str) -> dict:
    return {"contractAddress": address, "contractCodeHash": code_hash, "contractKind": CONTRACT_KINDS[kind]}


def contract_step(url: str, step: str, address: str, kind, reth_url: str, dry_run: bool) -> dict:
    """The registry's steps, each by the party that controls it: `propose` (ProposeContract, the operator and the gateway), `accept` (AcceptContract, the
    confirmer, after the change delay), `withdraw` (WithdrawContract, the operator) and `reject` (RejectContract, the confirmer) take the entry for
    the address (withdraw and reject: every pending proposal for the address), and `add` (AddContract) puts it in at once for a submission that acts for
    all three parties. propose, accept and add first check that reth holds, at the address, exactly the reviewed build of the kind."""
    if not ADDRESS40.fullmatch(address or ""):
        raise SystemExit("--contract-address must be 40 lowercase hex digits without 0x")
    if step in ("propose", "accept", "add") and kind not in CONTRACT_KINDS:
        raise SystemExit("--contract-kind gateway or vault is needed")
    ledger, chain = step_chain(url, "propose" if step == "withdraw" else step, with_gateway=step == "propose")
    known = [c for c in chain.get("contracts") or [] if c.get("contractAddress") == address]
    pending = [p for p in ledger.active("ContractProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
               and p.get("confirmer") == chain["confirmer"] and p.get("gateway") == chain["gateway"] and (p.get("entry") or {}).get("contractAddress") == address]
    result = {"step": step, "chainId": chain["chainId"], "address": address, "dryRun": dry_run}
    if step in ("withdraw", "reject"):
        if not dry_run:
            for p in pending:
                submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ContractProposal", "contractId": p["contractId"],
                                                          "choice": "WithdrawContract" if step == "withdraw" else "RejectContract", "choiceArgument": {}}}, step)
        return {**result, "pending": len(pending), "done": 0 if dry_run else len(pending)}
    code_hash = check_contract(reth_url, address, kind)
    entry = entry_of(address, code_hash, kind)
    result["entry"] = entry
    registered = [c for c in known if {k: c.get(k) for k in entry} == entry]
    if known and not registered:
        raise SystemExit(f"{address} is registered already, with another code hash or kind: {known[0]}")
    if address == chain.get("gatewayAddress"):
        raise SystemExit("the address is the chain's first gateway, which is not in the registry")
    mine = [p for p in pending if p.get("entry") == entry]
    if step == "propose":
        if registered:
            raise SystemExit("the contract is registered already")
        if len(chain.get("contracts") or []) >= MAX_CONTRACTS:
            raise SystemExit(f"the registry holds {MAX_CONTRACTS} contracts, the most it may")
        if pending and not mine:
            raise SystemExit("a proposal for this address with another code hash or kind is on this participant already: the operator takes it back "
                             "(--contract-step withdraw) before another is proposed")
        if not mine and not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeContract",
                                                       "choiceArgument": {"entry": entry}}}, "propose")
            mine = [p for p in ledger.active("ContractProposal") if p.get("entry") == entry and p.get("chainId") == chain["chainId"]]   # read again, for the time the ledger gave it
        return {**result, "submitted": not pending and not dry_run, "alreadyProposed": bool(pending), **timing((mine or [None])[0], chain)}
    if step == "add":
        if registered:
            return {**result, "submitted": False, "alreadyAccepted": True}
        if not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "AddContract",
                                                       "choiceArgument": {"entry": entry}}}, "add")
        return {**result, "submitted": not dry_run}
    if not mine:   # accept
        if registered:   # a re-run after the accept went through (or committed after a timeout): done
            return {**result, "submitted": False, "alreadyAccepted": True}
        raise SystemExit("no proposal for this contract, with this code hash and kind, is on this participant")
    result.update(timing(mine[0], chain))
    if not dry_run:
        check_waited(result, "the registry")
        submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ContractProposal", "contractId": mine[0]["contractId"], "choice": "AcceptContract",
                                                   "choiceArgument": {"chain": chain["contractId"]}}}, "accept")
    return {**result, "submitted": not dry_run}


MAX_TWINS = 16   # the Daml's maxTwins


def twin_key(entry: dict) -> tuple:
    """A pinned twin as the ledger shows it (an Int comes as text), in a form that two entries can be compared in."""
    return entry.get("twinToken"), int(entry.get("twinDecimals", -1)), entry.get("twinRules")


def read_rules_disclosed(path: str, rules: str) -> dict:
    """The TwinRules contract as a disclosed contract, from a JSON file: an object (or a list of one) with templateId, contractId, createdEventBlob
    and synchronizerId, for exactly the rules named."""
    try:
        found = json.loads(Path(path).read_text())
    except (OSError, ValueError) as e:
        raise SystemExit(f"cannot read --twin-rules-disclosed {path}: {e}") from None
    if isinstance(found, list) and len(found) == 1:
        found = found[0]
    keys = ("templateId", "contractId", "createdEventBlob", "synchronizerId")
    if not isinstance(found, dict) or not all(isinstance(found.get(k), str) and found[k] for k in keys):
        raise SystemExit(f"--twin-rules-disclosed must hold one disclosed contract: an object with {', '.join(keys)}")
    if found["contractId"] != rules:
        raise SystemExit(f"--twin-rules-disclosed is the contract {found['contractId']}, not the rules {rules}")
    if "TwinRules" not in found["templateId"]:
        raise SystemExit(f"--twin-rules-disclosed is a {found['templateId']}, not the twin's TwinRules")
    return {k: found[k] for k in keys}


def twin_step(url: str, step: str, token: str, decimals, rules, disclosed_path, reth_url: str, dry_run: bool) -> dict:
    """The pinned twins' steps, each by the party that controls it: `propose` (ProposeTwin, the operator and the gateway), `accept` (AcceptTwin, the
    confirmer, after the change delay, with the rules disclosed to it), `withdraw` (WithdrawTwin, the operator) and `reject` (RejectTwin, the confirmer)
    take the pin for the token (withdraw and reject: every pending proposal for the token), and `add` (AddTwin) pins it at once for a submission that
    acts for all three parties. propose, accept and add first check that the ERC-20 at the token's address has the decimals asked for (reth's
    finalized block), as the registry's steps check the code."""
    if not ADDRESS40.fullmatch(token or ""):
        raise SystemExit("--twin-token must be 40 lowercase hex digits without 0x")
    if step in ("withdraw", "reject"):
        entry = None
    else:
        if decimals is None or not 0 <= decimals <= 36:
            raise SystemExit("--twin-decimals (0 to 36) is needed")
        if not rules:
            raise SystemExit("--twin-rules (the TwinRules contract id) is needed")
        entry = {"twinToken": token, "twinDecimals": str(decimals), "twinRules": rules}
    ledger, chain = step_chain(url, "propose" if step == "withdraw" else step, with_gateway=step == "propose")
    known = [t for t in chain.get("twins") or [] if t.get("twinToken") == token]
    pending = [p for p in ledger.active("TwinProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
               and p.get("confirmer") == chain["confirmer"] and p.get("gateway") == chain["gateway"] and (p.get("entry") or {}).get("twinToken") == token]
    result = {"step": step, "chainId": chain["chainId"], "token": token, "dryRun": dry_run}
    if entry is None:
        if not dry_run:
            for p in pending:
                submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "TwinProposal", "contractId": p["contractId"],
                                                          "choice": "WithdrawTwin" if step == "withdraw" else "RejectTwin", "choiceArgument": {}}}, step)
        return {**result, "pending": len(pending), "done": 0 if dry_run else len(pending)}
    result["entry"] = entry
    result["tokenDecimals"] = twin_token_decimals(reth_url, token, decimals)
    registered = [t for t in known if twin_key(t) == twin_key(entry)]
    if known and not registered:
        raise SystemExit(f"{token} is pinned already, with other decimals or other rules: {known[0]}")
    mine = [p for p in pending if twin_key(p["entry"]) == twin_key(entry)]
    if step == "propose":
        if registered:
            raise SystemExit("the twin is pinned already")
        if len(chain.get("twins") or []) >= MAX_TWINS:
            raise SystemExit(f"the chain pins {MAX_TWINS} twins, the most it may")
        if pending and not mine:
            raise SystemExit("a proposal for this token with other decimals or other rules is on this participant already: the operator takes it back "
                             "(--twin-step withdraw) before another is proposed")
        if not mine and not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeTwin",
                                                       "choiceArgument": {"entry": entry}}}, "propose")
            mine = [p for p in ledger.active("TwinProposal") if twin_key(p["entry"]) == twin_key(entry) and p.get("chainId") == chain["chainId"]]
        return {**result, "submitted": not pending and not dry_run, "alreadyProposed": bool(pending), **timing((mine or [None])[0], chain)}
    if step == "add":
        if registered:
            return {**result, "submitted": False, "alreadyAccepted": True}
        if len(chain.get("twins") or []) >= MAX_TWINS:
            raise SystemExit(f"the chain pins {MAX_TWINS} twins, the most it may")
        if not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "AddTwin",
                                                       "choiceArgument": {"entry": entry}}}, "add")
        return {**result, "submitted": not dry_run}
    if not mine:   # accept
        if registered:   # a re-run after the accept went through (or committed after a timeout): done
            return {**result, "submitted": False, "alreadyAccepted": True}
        raise SystemExit("no proposal for this twin, with these decimals and these rules, is on this participant")
    disclosed = read_rules_disclosed(disclosed_path, rules) if disclosed_path else None
    if disclosed is None and not dry_run:
        raise SystemExit("--twin-rules-disclosed is needed: the confirmer cannot see the twin's rules, and the accept fetches them")
    result.update(timing(mine[0], chain))
    if not dry_run:
        check_waited(result, "the pinned twins")
        submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "TwinProposal", "contractId": mine[0]["contractId"], "choice": "AcceptTwin",
                                                   "choiceArgument": {"chain": chain["contractId"]}}}, "accept", [disclosed])
    return {**result, "submitted": not dry_run}


def delay_value(seconds: int):
    """The choice argument for a change delay in seconds: 0 is no delay (None), as the chain holds it."""
    return {"microseconds": str(seconds * 1_000_000)} if seconds else None


def change_delay_step(url: str, step: str, seconds: int, dry_run: bool) -> dict:
    """ChangeDelayProposal by the operator and the gateway (the operator's user acts for both), AcceptChangeDelay by the confirmer: the chain's change delay becomes `seconds`.
    The proposal itself waits out the delay the chain has when it is accepted, so a delay is not cut short by one step. There is no emergency bypass in this version; the wait binds the propose/accept path (see network/README.md, "The wait before a change")."""
    if not 0 <= seconds <= MAX_CHANGE_DELAY:
        raise SystemExit(f"--delay-seconds must be between 0 and {MAX_CHANGE_DELAY} (30 days); 0 takes the delay away")
    ledger, chain = step_chain(url, step, with_gateway=True)
    current = delay_us(chain.get("changeDelay"))

    def pending():
        found = [p for p in ledger.active("ChangeDelayProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
                 and p.get("confirmer") == chain["confirmer"] and p.get("gateway") == chain["gateway"]]
        return found, [p for p in found if delay_us(p.get("newDelay")) == seconds * 1_000_000]
    proposals, mine = pending()
    result = {"step": step, "chainId": chain["chainId"], "newChangeDelaySeconds": seconds, "dryRun": dry_run}
    if step == "propose":
        if current == seconds * 1_000_000:
            raise SystemExit("the chain has this change delay already")
        if proposals and not mine:
            raise SystemExit("a proposal for another change delay is on this participant already. Accept it only if that value is wanted; "
                             "otherwise the operator takes it back (--withdraw-proposal change-delay: the Withdraw choice of the ChangeDelayProposal, with the operator's token) and proposes again")
        was_there = bool(mine)
        if not mine and not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeChangeDelay",
                                                        "choiceArgument": {"newDelay": delay_value(seconds)}}}, "propose")
            mine = pending()[1]   # read again, for the time the ledger gave it
        return {**result, "submitted": not was_there and not dry_run, "alreadyProposed": was_there, **timing((mine or [None])[0], chain)}
    if not mine:
        if current == seconds * 1_000_000:   # a re-run after the accept went through (or committed after a timeout): done
            return {**result, "submitted": False, "alreadyAccepted": True, **timing(None, chain)}
        raise SystemExit("no proposal for this change delay is on this participant")
    result.update(timing(mine[0], chain))
    if not dry_run:
        check_waited(result, "the change delay")
        submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ChangeDelayProposal", "contractId": mine[0]["contractId"], "choice": "AcceptChangeDelay",
                                                    "choiceArgument": {"chain": chain["contractId"]}}}, "accept")
    return {**result, "submitted": not dry_run}


MAX_QUOTA_WINDOW = 30 * 24 * 3600   # the Daml's maxQuotaWindow (30 days), in seconds
MAX_PAUSE_MAX = 14 * 24 * 3600      # the Daml's maxPauseMax (14 days), in seconds
DEFAULT_PAUSE_MAX = 3 * 24 * 3600   # the Daml's defaultPauseMax (3 days), in seconds, for a chain that has no pauseMax
RENEW_PROPOSAL_LIFE = timedelta(hours=1)   # the Daml's renewProposalLife: a renewal proposal may be accepted for an hour only


def opt_us(value):
    """An Optional RelTime as the ledger gives it, in microseconds; None stays None (a quota window and a longest pause have a meaning for None)."""
    return None if value is None else delay_us(value)


def rel_value(seconds):
    return None if seconds is None else {"microseconds": str(seconds * 1_000_000)}


def parse_quota(text: str) -> Decimal:
    """A quota as the Daml holds it: a Decimal above zero with at most 10 decimals."""
    try:
        value = Decimal(text)
    except InvalidOperation:
        raise SystemExit(f"--quota must be a decimal number, not {text!r}") from None
    if not value.is_finite() or value <= 0:
        raise SystemExit("--quota must be above zero")
    if value.as_tuple().exponent < -10:
        raise SystemExit("--quota may have at most 10 decimals")
    return value


def check_leg_limits(quota, window, pause_max) -> None:
    """What SetLegLimits refuses, before anything is sent."""
    if (quota is None) != (window is None):
        raise SystemExit("the quota and its window are set together (--quota with --quota-window-seconds), or neither (--no-quota)")
    if window is not None and not 1 <= window <= MAX_QUOTA_WINDOW:
        raise SystemExit(f"--quota-window-seconds must be between 1 and {MAX_QUOTA_WINDOW} (30 days)")
    if pause_max is not None and not 1 <= pause_max <= MAX_PAUSE_MAX:
        raise SystemExit(f"--pause-max-seconds must be between 1 and {MAX_PAUSE_MAX} (14 days)")


def limits_of(chain: dict) -> dict:
    """The chain's leg limits in the form this script prints and compares: quota as a string (None for no quota), the window and the longest pause in seconds."""
    quota = chain.get("withdrawalQuota")
    window, longest = opt_us(chain.get("quotaWindow")), opt_us(chain.get("pauseMax"))
    return {"quota": None if quota is None else str(Decimal(quota)), "quotaWindowSeconds": None if window is None else seconds_of(window),
            "pauseMaxSeconds": None if longest is None else seconds_of(longest)}


def leg_limits_step(url: str, step: str, quota, window, pause_max, dry_run: bool) -> dict:
    """LegLimitsProposal by the operator, AcceptLegLimits by the confirmer: the chain's withdrawal quota, its window and its longest pause become these
    (quota None with window None: no quota; pause_max None: the default, 3 days). The proposal waits out the chain's change delay like a gas cap."""
    check_leg_limits(quota, window, pause_max)
    ledger, chain = step_chain(url, step)
    current = limits_of(chain)
    new = {"quota": None if quota is None else str(quota), "quotaWindowSeconds": window, "pauseMaxSeconds": pause_max}

    def same(values: dict) -> bool:
        return (values["quota"] is None) == (new["quota"] is None) and (values["quota"] is None or Decimal(values["quota"]) == Decimal(new["quota"])) \
            and values["quotaWindowSeconds"] == new["quotaWindowSeconds"] and values["pauseMaxSeconds"] == new["pauseMaxSeconds"]

    def pending():
        found = [p for p in ledger.active("LegLimitsProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
                 and p.get("confirmer") == chain["confirmer"]]
        return found, [p for p in found if same(limits_of({"withdrawalQuota": p.get("newQuota"), "quotaWindow": p.get("newWindow"), "pauseMax": p.get("newPauseMax")}))]
    proposals, mine = pending()
    result = {"step": step, "chainId": chain["chainId"], "current": current, "new": new, "dryRun": dry_run}
    if step == "propose":
        if same(current):
            raise SystemExit("the chain has these leg limits already")
        if proposals and not mine:
            raise SystemExit("a proposal for other leg limits is on this participant already. Accept it only if those values are wanted; "
                             "otherwise the operator takes it back (--withdraw-proposal leg-limits: the Withdraw choice of the LegLimitsProposal, with the operator's token) and proposes again")
        was_there = bool(mine)
        if not mine and not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeLegLimits",
                                                        "choiceArgument": {"newQuota": new["quota"], "newWindow": rel_value(window), "newPauseMax": rel_value(pause_max)}}}, "propose")
            mine = pending()[1]   # read again, for the time the ledger gave it
        return {**result, "submitted": not was_there and not dry_run, "alreadyProposed": was_there, **timing((mine or [None])[0], chain)}
    if not mine:
        if same(current):   # a re-run after the accept went through (or committed after a timeout): done
            return {**result, "submitted": False, "alreadyAccepted": True}
        raise SystemExit("no proposal for these leg limits is on this participant")
    result.update(timing(mine[0], chain))
    if not dry_run:
        check_waited(result, "the leg limits")
        submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "LegLimitsProposal", "contractId": mine[0]["contractId"], "choice": "AcceptLegLimits",
                                                    "choiceArgument": {"chain": chain["contractId"]}}}, "accept")
    return {**result, "submitted": not dry_run}


def pause_state(chain: dict, now: datetime) -> dict:
    """What a pause step prints about the chain's pause: until when the legs are paused (None: not paused), from when the confirmer alone may start the next pause
    and how long a pause may last. The paused flag is this machine's clock against pausedUntil; the ledger decides with its own time."""
    until, cooldown = chain.get("pausedUntil"), chain.get("pauseCooldownUntil")
    longest = opt_us(chain.get("pauseMax"))
    limit = DEFAULT_PAUSE_MAX if longest is None else seconds_of(longest)
    shown = lambda t: show_time(parse_time(t)) if t else None   # one form for every printed time (the ledger trims the fraction)
    return {"paused": bool(until) and now < parse_time(until), "pausedUntil": shown(until), "pauseCooldownUntil": shown(cooldown), "pauseLimitSeconds": limit}


def chain_after(ledger, before: dict) -> dict:
    """The pause state of the chain as it is after a step, read again: a step that went through consumed the chain contract, so what was read before it is stale.
    The step has already been accepted by the ledger; if the chain cannot be read again, the stale state is not printed as if it were new."""
    found = [c for c in ledger.active("ZkChain") if c.get("chainId") == before["chainId"]]
    if len(found) != 1:
        return {"note": "the step went through, but the chain could not be read again; read it with --pause-step unpause --dry-run, which prints the state in every case"}
    return pause_state(found[0], datetime.now(timezone.utc))


def pause_step(url: str, step: str, seconds, dry_run: bool) -> dict:
    """The pause of the legs. pause and unpause are the confirmer's alone (PauseLegs, UnpauseLegs: the emergency brake, which ends on its own and cannot be
    started again before its cooldown); renew-propose (the operator, ProposeRenewPause) and renew-accept (the confirmer, AcceptRenewPause) are the two together
    pausing for `seconds` from the moment of the accept, or renewing a pause that runs, for at most the chain's longest pause."""
    renew = step.startswith("renew")
    if renew and seconds is None:
        raise SystemExit(f"--pause-step {step} needs --pause-seconds")
    if not renew and seconds is not None:
        raise SystemExit("--pause-seconds goes with --pause-step renew-propose or renew-accept")
    ledger, chain = step_chain(url, "propose" if step == "renew-propose" else "accept")
    now = datetime.now(timezone.utc)
    state = pause_state(chain, now)
    result = {"step": "pause-" + step, "chainId": chain["chainId"], **state, "dryRun": dry_run}
    if renew:
        if not 1 <= seconds <= state["pauseLimitSeconds"]:
            raise SystemExit(f"--pause-seconds must be between 1 and the chain's longest pause, {state['pauseLimitSeconds']} s")
        result["pauseSeconds"] = seconds

        def pending():
            found = [p for p in ledger.active("RenewPauseProposal") if p.get("chainId") == chain["chainId"] and p.get("operator") == chain["operator"]
                     and p.get("confirmer") == chain["confirmer"]]
            return found, [p for p in found if opt_us(p.get("forHowLong")) == seconds * 1_000_000]
        proposals, mine = pending()
        if step == "renew-propose":
            if proposals and not mine:
                raise SystemExit("a proposal to pause for another time is on this participant already. Accept it only if that value is wanted; "
                                 "otherwise the operator takes it back (--withdraw-proposal renew-pause: the Withdraw choice of the RenewPauseProposal, with the operator's token) and proposes again")
            if mine and mine[0].get("proposedAt"):
                made = parse_time(mine[0]["proposedAt"])
                result["proposedAt"], result["acceptableUntil"] = show_time(made), show_time(made + RENEW_PROPOSAL_LIFE)
                if now > made + RENEW_PROPOSAL_LIFE:
                    raise SystemExit(f"a proposal past its hour is there (made at {result['proposedAt']}, acceptable until {result['acceptableUntil']}): "
                                     "--withdraw-proposal renew-pause first (the operator's token), then propose again")
            if not mine and not dry_run:
                submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "ProposeRenewPause",
                                                            "choiceArgument": {"forHowLong": rel_value(seconds)}}}, "propose")
            return {**result, "submitted": not mine and not dry_run, "alreadyProposed": bool(mine)}
        if not mine:
            if proposals:   # a proposal for another time is pending: never report success for a value nobody proposed
                others = sorted({opt_us(p.get("forHowLong")) // 1_000_000 for p in proposals})
                raise SystemExit(f"a proposal to pause for another time is on this participant ({', '.join(str(o) for o in others)} s), not {seconds} s: "
                                 "accept that value with --pause-seconds, or the operator takes it back (--withdraw-proposal renew-pause) and proposes again")
            if state["paused"]:   # an accept that went through consumed the proposal: say what is in force, as a re-run of pause does
                return {**result, "submitted": False, "noProposal": True}
            raise SystemExit(f"no proposal to pause for {seconds} s is on this participant")
        if mine[0].get("proposedAt"):
            made = parse_time(mine[0]["proposedAt"])
            result["proposedAt"], result["acceptableUntil"] = show_time(made), show_time(made + RENEW_PROPOSAL_LIFE)
            if now > made + RENEW_PROPOSAL_LIFE:
                raise SystemExit(f"the proposal was made at {result['proposedAt']} and could be accepted until {result['acceptableUntil']}: the chain refuses it now. "
                                 "The operator takes it back (--withdraw-proposal renew-pause) and proposes it again for the incident at hand")
        if not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "RenewPauseProposal", "contractId": mine[0]["contractId"], "choice": "AcceptRenewPause",
                                                        "choiceArgument": {"chain": chain["contractId"]}}}, "accept")
            return {**result, **chain_after(ledger, chain), "submitted": True}
        return {**result, "submitted": False}
    if step == "pause":
        if state["paused"]:
            return {**result, "submitted": False, "alreadyPaused": True}
        cooldown = state["pauseCooldownUntil"]
        if cooldown and now < parse_time(cooldown) and not os.environ.get("CZE_SKIP_WAIT_CHECK"):
            raise SystemExit(f"the confirmer alone may start a new pause from {cooldown}; the operator and the confirmer together may pause now (--pause-step renew-propose, then renew-accept)")
        if not dry_run:
            submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "PauseLegs", "choiceArgument": {}}}, "pause")
            return {**result, **chain_after(ledger, chain), "submitted": True}
        return {**result, "submitted": False}
    if not state["paused"]:
        return {**result, "submitted": False, "alreadyUnpaused": True}
    if not dry_run:
        submit_step(ledger, {"ExerciseCommand": {"templateId": propose.PKG + "ZkChain", "contractId": chain["contractId"], "choice": "UnpauseLegs", "choiceArgument": {}}}, "unpause")
        return {**result, **chain_after(ledger, chain), "submitted": True}
    return {**result, "submitted": False}


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
    ap.add_argument("--dry-run", action="store_true", help="with --package-step vet: the participant prepares the vetting and applies nothing; with --gas-cap-step, --program-step, --change-delay-step, --pause-step, --leg-limits-step --contract-step or --twin-step: nothing is submitted")
    ap.add_argument("--gas-cap-step", choices=("propose", "accept"), help="raise the chain's gas cap: the operator proposes, the confirmer accepts (see the top of this file)")
    ap.add_argument("--new-gas-cap", type=int, help="with --gas-cap-step: the new gas cap")
    ap.add_argument("--program-step", choices=("propose", "accept"), help="replace the chain's program key, ZisK root and rules hash: the operator proposes, the confirmer accepts (see the top of this file)")
    ap.add_argument("--program-vk", help="with --program-step: the new program key (64 lowercase hex digits)")
    ap.add_argument("--root-c", help="with --program-step: the new ZisK root (64 lowercase hex digits)")
    ap.add_argument("--rules-hash", help="with --program-step: the new rules hash (64 lowercase hex digits)")
    ap.add_argument("--change-delay-step", choices=("propose", "accept"), help="change the wait that a gas-cap or program change sits out: the operator and the gateway propose, the confirmer accepts (see the top of this file)")
    ap.add_argument("--delay-seconds", type=int, help="with --change-delay-step: the new wait in seconds (0 takes it away; at most 30 days)")
    ap.add_argument("--pause-step", choices=("pause", "unpause", "renew-propose", "renew-accept"), help="pause the Canton legs, lift the pause, or renew it by the operator and the confirmer together (see the top of this file)")
    ap.add_argument("--pause-seconds", type=int, help="with --pause-step renew-propose or renew-accept: how long the pause runs from the accept")
    ap.add_argument("--leg-limits-step", choices=("propose", "accept"), help="set the withdrawal quota and the longest pause: the operator proposes, the confirmer accepts after the change delay (see the top of this file)")
    ap.add_argument("--quota", help="with --leg-limits-step: the most units of each Canton instrument that may be withdrawn in one window")
    ap.add_argument("--quota-window-seconds", type=int, help="with --leg-limits-step: the window of the quota in seconds (1 up to 30 days)")
    ap.add_argument("--no-quota", action="store_true", help="with --leg-limits-step: no withdrawal quota")
    ap.add_argument("--pause-max-seconds", type=int, help="with --leg-limits-step: the longest a pause may run (1 second up to 14 days); without it, the default of 3 days")
    ap.add_argument("--contract-step", choices=("propose", "accept", "withdraw", "reject", "add"), help="the registry of EVM contracts: the operator proposes an entry, the confirmer accepts or rejects it, the operator withdraws it, or `add` puts it in at once for a submission that acts for all three parties (see the top of this file)")
    ap.add_argument("--contract-address", help="with --contract-step: the contract's address (40 lowercase hex digits without 0x)")
    ap.add_argument("--contract-kind", choices=("gateway", "vault"), help="with --contract-step propose, accept or add: what the contract is; its code must be the reviewed build of that kind")
    ap.add_argument("--reth-url", default=os.environ.get("CZE_RETH_URL") or f"http://127.0.0.1:{os.environ.get('RETH_HTTP_PORT', '8545')}", help="with --contract-step or --twin-step propose, accept or add: reth's HTTP RPC, which the code at the address, or the token's decimals, is read from")
    ap.add_argument("--twin-step", choices=("propose", "accept", "withdraw", "reject", "add"), help="the pinned twins: the operator proposes a twin of an ERC-20, the confirmer accepts or rejects it, the operator withdraws it, or all three add it at once (see the top of this file)")
    ap.add_argument("--twin-token", help="with --twin-step: the ERC-20's address (40 lowercase hex digits without 0x)")
    ap.add_argument("--twin-decimals", type=int, help="with --twin-step propose, accept or add: the ERC-20's decimals (0 to 36), which must be the rules' own")
    ap.add_argument("--twin-rules", help="with --twin-step propose, accept or add: the contract id of the twin's TwinRules")
    ap.add_argument("--twin-rules-disclosed", metavar="FILE", help="with --twin-step accept: the TwinRules contract as a disclosed contract (JSON: templateId, contractId, createdEventBlob, synchronizerId), for the confirmer, who cannot see it")
    ap.add_argument("--withdraw-proposal", choices=tuple(PROPOSAL_KINDS), help="the operator takes back its pending proposals of this kind (the Withdraw choice); use it for a proposal that is not wanted")
    own, rest = ap.parse_known_args(argv)
    rest = [a for a in rest if a != "--"]
    if own.twin_step:
        if not own.ledger_url:
            ap.error("--ledger-url (CZE_LEDGER_URL) is required")
        if not own.twin_token:
            ap.error("--twin-step needs --twin-token")
        if own.twin_step in ("withdraw", "reject") and (own.twin_decimals is not None or own.twin_rules or own.twin_rules_disclosed):
            ap.error("--twin-decimals, --twin-rules and --twin-rules-disclosed go with --twin-step propose, accept or add")
        if own.twin_rules_disclosed and own.twin_step != "accept":
            ap.error("--twin-rules-disclosed goes with --twin-step accept")
        if own.twin_step in ("propose", "accept", "add") and (own.twin_decimals is None or not own.twin_rules):
            ap.error(f"--twin-step {own.twin_step} needs --twin-decimals and --twin-rules")
        if (rest or own.demo or own.package_step or own.gas_cap_step or own.program_step or own.change_delay_step or own.contract_step or own.contract_address
                or own.contract_kind or own.withdraw_proposal or own.new_gas_cap is not None or own.program_vk or own.root_c or own.rules_hash
                or own.pause_step or own.leg_limits_step or own.delay_seconds is not None
                or own.pause_seconds is not None or own.quota is not None or own.quota_window_seconds is not None or own.no_quota or own.pause_max_seconds is not None):
            ap.error("--twin-step does only the twin's step: no other step, no --demo, no values and no chain arguments")
        if own.twin_step in ("propose", "accept", "add") and not LOOPBACK_OR_HTTPS.match(own.reth_url):
            raise SystemExit("the reth URL must be https, or http on this machine (127.0.0.1): its answer about the token's decimals is the only check before a pin that cannot be removed")
        check_settings(own.ledger_url, ("confirmer",) if own.twin_step in ("accept", "reject") else ("operator",))
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        print(json.dumps(twin_step(own.ledger_url, own.twin_step, own.twin_token, own.twin_decimals, own.twin_rules, own.twin_rules_disclosed, own.reth_url, own.dry_run)))
        return 0
    if own.twin_token or own.twin_decimals is not None or own.twin_rules or own.twin_rules_disclosed:
        ap.error("--twin-token, --twin-decimals, --twin-rules and --twin-rules-disclosed go with --twin-step")
    if own.contract_step:
        if not own.ledger_url:
            ap.error("--ledger-url (CZE_LEDGER_URL) is required")
        if not own.contract_address:
            ap.error("--contract-step needs --contract-address")
        if own.contract_step in ("propose", "accept", "add") and not own.contract_kind:
            ap.error(f"--contract-step {own.contract_step} needs --contract-kind gateway|vault")
        if own.contract_step in ("withdraw", "reject") and own.contract_kind:
            ap.error("--contract-kind goes with --contract-step propose, accept or add")
        if (rest or own.demo or own.package_step or own.gas_cap_step or own.program_step or own.change_delay_step or own.pause_step or own.leg_limits_step
                or own.withdraw_proposal or own.new_gas_cap is not None or own.program_vk or own.root_c or own.rules_hash or own.delay_seconds is not None
                or own.pause_seconds is not None or own.quota is not None or own.quota_window_seconds is not None or own.no_quota or own.pause_max_seconds is not None):
            ap.error("--contract-step does only the registry's step: no other step, no --demo, no values and no chain arguments")
        if own.contract_step in ("propose", "accept", "add") and not LOOPBACK_OR_HTTPS.match(own.reth_url):
            raise SystemExit("the reth URL must be https, or http on this machine (127.0.0.1): its answer about the code at the address is the only check before an entry that cannot be removed")
        check_settings(own.ledger_url, ("confirmer",) if own.contract_step in ("accept", "reject") else ("operator",))
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        print(json.dumps(contract_step(own.ledger_url, own.contract_step, own.contract_address, own.contract_kind, own.reth_url, own.dry_run)))
        return 0
    if own.contract_address or own.contract_kind:
        ap.error("--contract-address and --contract-kind go with --contract-step")
    limit_values = (own.quota is not None or own.quota_window_seconds is not None or own.no_quota or own.pause_max_seconds is not None)
    if own.pause_step or own.leg_limits_step:
        if not own.ledger_url:
            ap.error("--ledger-url (CZE_LEDGER_URL) is required")
        if (rest or own.demo or own.package_step or own.gas_cap_step or own.program_step or own.change_delay_step or own.withdraw_proposal
                or own.new_gas_cap is not None or own.program_vk or own.root_c or own.rules_hash or own.delay_seconds is not None or (own.pause_step and own.leg_limits_step)):
            ap.error("--pause-step and --leg-limits-step each do only their own step: no other step, no --demo and no chain arguments")
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        if own.pause_step:
            if limit_values:
                ap.error("--quota, --quota-window-seconds, --no-quota and --pause-max-seconds go with --leg-limits-step")
            check_settings(own.ledger_url, ("operator",) if own.pause_step == "renew-propose" else ("confirmer",))
            print(json.dumps(pause_step(own.ledger_url, own.pause_step, own.pause_seconds, own.dry_run)))
            return 0
        if own.pause_seconds is not None:
            ap.error("--pause-seconds goes with --pause-step")
        if own.no_quota == (own.quota is not None) or (own.no_quota and own.quota_window_seconds is not None):
            ap.error("--leg-limits-step needs --quota with --quota-window-seconds, or --no-quota (not both)")
        quota = parse_quota(own.quota) if own.quota is not None else None
        check_leg_limits(quota, own.quota_window_seconds, own.pause_max_seconds)
        check_settings(own.ledger_url, ("operator",) if own.leg_limits_step == "propose" else ("confirmer",))
        print(json.dumps(leg_limits_step(own.ledger_url, own.leg_limits_step, quota, own.quota_window_seconds, own.pause_max_seconds, own.dry_run)))
        return 0
    if limit_values or own.pause_seconds is not None:
        ap.error("--quota, --quota-window-seconds, --no-quota, --pause-max-seconds and --pause-seconds go with --pause-step or --leg-limits-step")
    if own.withdraw_proposal:
        if not own.ledger_url:
            ap.error("--ledger-url (CZE_LEDGER_URL) is required")
        if (rest or own.demo or own.package_step or own.gas_cap_step or own.program_step or own.change_delay_step
                or own.new_gas_cap is not None or own.program_vk or own.root_c or own.rules_hash or own.delay_seconds is not None):
            ap.error("--withdraw-proposal does only the withdrawal: no other step, no values and no chain arguments (it withdraws every pending proposal of that kind)")
        check_settings(own.ledger_url, ("operator",))
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        print(json.dumps(withdraw_step(own.ledger_url, own.withdraw_proposal, own.dry_run)))
        return 0
    if own.gas_cap_step:
        if not own.ledger_url:
            ap.error("--ledger-url (CZE_LEDGER_URL) is required")
        if own.new_gas_cap is None:
            ap.error("--gas-cap-step needs --new-gas-cap")
        if rest or own.demo or own.package_step or own.program_step or own.program_vk or own.root_c or own.rules_hash or own.change_delay_step or own.delay_seconds is not None:
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
        if rest or own.demo or own.package_step or own.gas_cap_step or own.new_gas_cap is not None or own.change_delay_step or own.delay_seconds is not None:
            ap.error("--program-step does only the program: no --demo, no --package-step, no --gas-cap-step and no chain arguments")
        new = {"programVK": own.program_vk, "rootC": own.root_c, "rulesHash": own.rules_hash}
        check_program(new)
        check_settings(own.ledger_url, ("operator",) if own.program_step == "propose" else ("confirmer",))
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        print(json.dumps(program_step(own.ledger_url, own.program_step, new, own.dry_run)))
        return 0
    if own.change_delay_step:
        if not own.ledger_url:
            ap.error("--ledger-url (CZE_LEDGER_URL) is required")
        if own.delay_seconds is None:
            ap.error("--change-delay-step needs --delay-seconds")
        if rest or own.demo or own.package_step or own.new_gas_cap is not None or own.program_vk or own.root_c or own.rules_hash:
            ap.error("--change-delay-step does only the change delay: no --demo, no --package-step and no chain arguments")
        check_settings(own.ledger_url, ("operator",) if own.change_delay_step == "propose" else ("confirmer",))
        os.environ.setdefault("CZE_USER_PREFIX", "ostia-")
        print(json.dumps(change_delay_step(own.ledger_url, own.change_delay_step, own.delay_seconds, own.dry_run)))
        return 0
    if own.delay_seconds is not None:
        ap.error("--delay-seconds goes with --change-delay-step")
    if own.new_gas_cap is not None:
        ap.error("--new-gas-cap goes with --gas-cap-step")
    if own.program_vk or own.root_c or own.rules_hash:
        ap.error("--program-vk, --root-c and --rules-hash go with --program-step")
    if not own.ledger_url or not own.dar:
        ap.error("--ledger-url (CZE_LEDGER_URL) and --dar (CZE_DAR) are required")
    if own.dry_run and own.package_step != "vet":
        ap.error("--dry-run goes with --package-step vet, --gas-cap-step, --program-step, --change-delay-step, --pause-step, --leg-limits-step, --contract-step, --twin-step or --withdraw-proposal")
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
