#!/usr/bin/env python3
"""The accounts service: Canton accounts that a person holds with a key of their own, made and used through the participant's JSON Ledger API.
See README.md.

  accounts.py --ledger-url <url> --user-id <ledger user> --state-file <path> [--listen 127.0.0.1:8081]

The service holds a Ledger API token and no key of any party. An account is an external party: its key is made by its owner, and only that key can
sign for it. The service generates the topology and the transactions to be signed, hands them out, and submits what comes back signed.
"""
import argparse, base64, binascii, calendar, collections, contextlib, hashlib, hmac, http.client, ipaddress, json, os, re, secrets, socket, stat, sys, threading, time, urllib.error, urllib.parse, urllib.request, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ed25519

# What the service lets an account sign: a create of a template ("#package:Module:Entity") or an exercise of one choice ("#package:Module:Entity#Choice").
ALLOCATION_WITHDRAW = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation#Allocation_Withdraw"   # the two ways an account takes back a deposit that cannot settle (see `check_take_back`)
TRANSFER_WITHDRAW = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction#TransferInstruction_Withdraw"   # an account takes back a transfer it sent that nobody accepted (see `check_take_back`)
TRANSFER_ACCEPT = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction#TransferInstruction_Accept"
DEPOSIT_ARCHIVE = "#canton-zk-evm:Zk.Chain:DepositRequest#Archive"
REDEEM_ARCHIVE = "#canton-zk-evm:Zk.Chain:RedeemRequest#Archive"   # an account removes its own open redeem request (see `check_take_back`)
DEFAULT_ALLOW = (
    "#canton-zk-evm:Zk.Chain:WithdrawalAcceptance",
    "#canton-zk-evm:Zk.Chain:DepositRequest",
    "#splice-api-token-allocation-instruction-v1:Splice.Api.Token.AllocationInstructionV1:AllocationFactory#AllocationFactory_Allocate",
    "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory#TransferFactory_Transfer",
    TRANSFER_ACCEPT,
    TRANSFER_WITHDRAW,
    ALLOCATION_WITHDRAW,
    DEPOSIT_ARCHIVE,
    REDEEM_ARCHIVE,
)
# These free state or finish a move that is under way: a person who has them refused cannot get a deposit back or take a transfer in. They are counted against a ceiling of their own, not the
# shared executes and traffic ceilings that anyone's creates can fill (`Accounts.spend`); the per-account, per-client and per-network budgets still count them.
SHARED_EXEMPT = (ALLOCATION_WITHDRAW, TRANSFER_WITHDRAW, DEPOSIT_ARCHIVE, REDEEM_ARCHIVE, TRANSFER_ACCEPT)
CHAIN_CREATES = DEFAULT_ALLOW[:2]   # these creates name the chain's parties as observers: they are checked against the configured ones
CHAIN_FIELDS = ("operator", "confirmer", "gateway", "builder")
ACCEPTANCE, DEPOSIT = CHAIN_CREATES
TWIN_ACCEPTANCE = "#ostia-twin:Twin.Twin:TwinAcceptance"   # not on the built-in list: a deployment that serves twins allows it (--allow, with --open-limit TEMPLATE=1)
ALLOW_ENTRY = re.compile(r"#[a-z0-9][a-z0-9-]*:[A-Za-z0-9_.]+:[A-Za-z0-9_]+(#[A-Za-z0-9_]+)?\Z")
HOLDING = "#splice-api-token-holding-v1:Splice.Api.Token.HoldingV1:Holding"
ALLOCATION = "#splice-api-token-allocation-v1:Splice.Api.Token.AllocationV1:Allocation"
TRANSFER_INSTRUCTION = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction"
TRANSFERS_MAX = 100      # transfers `GET /accounts/v1/transfers/{party}` lists: anyone can offer an account a transfer, so the list is bounded
REDEEM = "#canton-zk-evm:Zk.Chain:RedeemRequest"
PARTY = re.compile(r"[A-Za-z0-9_-]{1,64}::1220[0-9a-f]{64}\Z")   # hint::fingerprint; a hash fingerprint is "1220" and 64 lowercase hex digits
HINT = re.compile(r"[A-Za-z0-9_-]{1,32}\Z")
SPKI_ED25519 = bytes.fromhex("302a300506032b6570032100")   # the DER prefix of an Ed25519 public key; 32 raw key bytes follow
MAX_BODY = 512 * 1024
MAX_TEXT = 128           # the longest `label` or `ref` in a create (contract ids and party ids are longer and are not capped)
TEXT_FIELDS = ("label", "ref")
MAX_ARGUMENTS = 2048     # bytes of a create's arguments, as JSON
IN_FLIGHT_TTL = 120      # seconds an execute that got no answer counts as open when its transaction has no end time of its own
PENDING_PER_ACCOUNT = 5  # prepared transactions one account may have waiting for its signature
PENDING_TTL = 600        # seconds a topology or a prepared transaction can be signed and sent back
RECORD_MARGIN = 30       # seconds added to PENDING_TTL for the latest time the participant may record a prepared transaction (`maxRecordTime`)
ACCOUNT_RATE = 30        # prepare, execute, holdings, allocations, transfers and open requests per account in a minute
NETWORK_RATE = 300       # requests per client network (an IPv4 address, an IPv6 /48) in a minute
HOLDINGS_PAGE, HOLDINGS_PAGES = 100, 50
DAY = 86400
AUTH_WINDOW = 60         # seconds of clock difference an account signature may have
FAILED_VERIFIES = 10     # signatures that fail to verify, per client in a minute, before the service stops verifying for that client
HEALTH_TTL = 5           # seconds /healthz is answered from the last check
TRUSTED_ADDRESSES = (ipaddress.ip_network("127.0.0.1"), ipaddress.ip_network("::1"))
RELAY_SUFFIX = r"([^/]+)/(allocation-factory|transfer-factory|transfer-instruction/(00[0-9a-f]{20,252})/(accept|withdraw)-context|allocation/(00[0-9a-f]{20,252})/withdraw-context)\Z"
RELAY_PATH = re.compile(r"/accounts/v1/registry/" + RELAY_SUFFIX)
PUBLIC_RELAY_PATH = re.compile(r"/accounts/v1/public-registry/" + RELAY_SUFFIX)   # the same registry calls, for wallets this service did not make: no account signature
PUBLIC_RELAY_RATE = 30   # public registry relay requests per client in a minute
PUBLIC_RELAY_TOTAL = 600   # and in a minute from all clients together
PUBLIC_RELAY_NETWORK = 120   # and in a minute from one client network (an IPv4 address, an IPv6 /48)
NEW_ACCOUNTS_PER_NETWORK = 6   # new accounts a day for one client network (an IPv4 address, an IPv6 /48)
EXECUTES_PER_NETWORK = 400     # executes and allocations a day for one client network
TAKE_BACKS_PER_DAY = 5000      # take-backs and accepts a day, all clients together (their own ceiling)
TAKE_BACK_TRAFFIC_PER_DAY = 50_000_000   # and the traffic of those, as the participant estimates it (bytes): a share of their own, apart from the traffic of creates
ACCOUNT_CAP = 1000             # the accounts the participant allows this service's user: its `max-self-allocated-parties` (the service cannot read it; the operator says it)
TAKE_BACK_MARGIN = 60    # seconds past an allocation's settle-before time before it may be taken back: Canton's default record-time tolerance (ledger time may differ from record time by up to this much); the builder stops using the allocation 5 minutes before the time (its SETTLE_MARGIN)
TIME = re.compile(r"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z\Z")
CONTRACT_ID = re.compile(r"00[0-9a-f]{20,252}\Z")
RELAY_MAX_ANSWER = 1024 * 1024   # bytes of a registry's or the wallet's answer that are read
RELAY_FAILED = 424              # the status of a relayed call the registry could not answer (not a 5xx, which a proxy may replace with a page of its own)
RELAY_MAX_BODY = 64 * 1024       # bytes of a relayed request, as JSON
OUTSIDE_DEADLINE = 15            # seconds a call to a registry or the wallet may take in all
USER_AGENT = "Rome Protocol rome@romeprotocol.com"
FAUCET_AMOUNT = re.compile(r"[0-9]{1,15}(\.[0-9]{1,10})?\Z")   # Canton Coin has 10 decimals
SIGNATURE_FORMAT = "SIGNATURE_FORMAT_RAW"   # the pinned Canton's OpenAPI spec (3.7.2, unchanged from 3.7.1) leaves the format a free string and names no value; RAW is what the pinned Canton accepts


SLOW_VERIFY_WARNING = ("WARNING: the cryptography package is not installed: signatures are checked in pure Python (about 5 ms each), so a flood of requests costs "
                       "the service CPU. A deployment must install it.")


class HttpError(Exception):
    """An answer that is not a success. With `stable` (a 409 always has one) the body is {"error": stable, "message": message}: a client acts on the code, a person reads the
    message. Without it the body is {"error": message}. `extra` fields are added to the body either way."""
    def __init__(self, status: int, message: str, stable: str = None, **extra):
        super().__init__(message)
        self.status, self.message, self.stable, self.extra = status, message, stable, extra


class NotSent(HttpError):
    """A call to an outside server that failed before one byte of the request was written: it cannot have done anything there."""


def conflict(code: str, message: str) -> HttpError:
    """A 409. `code` is stable (the README lists them): a client may switch on it."""
    return HttpError(409, message, code)


def b64(value, name: str, sizes: tuple) -> bytes:
    """Strict base64 text of one of the allowed byte lengths."""
    try:
        raw = base64.b64decode(value, validate=True) if isinstance(value, str) else None
    except (binascii.Error, ValueError):
        raw = None
    if raw is None or len(raw) not in sizes:
        raise HttpError(400, f"{name} must be base64 of {' or '.join(map(str, sizes))} bytes")
    return raw


def text(body, name: str, limit: int = 4096) -> str:
    value = body.get(name) if isinstance(body, dict) else None
    if not isinstance(value, str) or not 0 < len(value) <= limit:
        raise HttpError(400, f"{name} must be non-empty text")
    return value


def norm(address: str):
    """An IP address; an IPv4 address inside an IPv6 one (::ffff:a.b.c.d) is the IPv4 address. ValueError when it is not an address."""
    a = ipaddress.ip_address(address.strip())
    return a.ipv4_mapped or a if a.version == 6 else a


def client_key(address: str) -> str:
    """What limits count a client by: an IPv4 address as it is, an IPv6 address as its /64 (one subscriber holds a whole /64)."""
    try:
        a = norm(address)
    except ValueError:
        return address
    return str(ipaddress.ip_network((a, 64), strict=False)) if a.version == 6 else str(a)


def pending_owner(key: str) -> str:
    """What the caps on waiting entries count a client by: an IPv4 address as it is, an IPv6 address as its /48 (the rate limits stay per /64)."""
    try:
        return str(ipaddress.ip_network(key).supernet(new_prefix=48)) if "/" in key else key
    except ValueError:
        return key


def client_address(peer: str, header: str, n: int, trusted) -> str:
    """The client's address: the n-th entry from the right of the proxy header, but only when the TCP peer is a trusted proxy; otherwise the peer itself."""
    try:
        if header and any(norm(peer) in net for net in trusted):
            entries = [e.strip() for e in header.split(",")]
            if 1 <= n <= len(entries):
                return str(norm(entries[-n]))
    except ValueError:
        pass
    return peer


def is_loopback_address(address: str) -> bool:
    """Whether an IP address (a zone after % is ignored) is loopback, an IPv4 loopback in its IPv6-mapped form included."""
    ip = ipaddress.ip_address(address.split("%")[0])
    return ip.is_loopback or (ip.version == 6 and ip.ipv4_mapped is not None and ip.ipv4_mapped.is_loopback)


def on_this_machine(url) -> bool:
    """Whether a parsed URL's host is this machine: localhost, 127.0.0.1 or ::1, or a name under .localhost (RFC 6761) whose every address is loopback."""
    host = url.hostname
    if host in ("localhost", "127.0.0.1", "::1"):
        return True
    if not host or not host.endswith(".localhost"):
        return False
    try:
        found = {a[4][0] for a in socket.getaddrinfo(host, url.port or 80)}
        return bool(found) and all(is_loopback_address(a) for a in found)
    except (OSError, ValueError):
        return False


def outside_url(url: str, what: str) -> str:
    """A URL that this service sends requests to: http or https, no query, fragment or user; https, or on this machine (checked again on each connection). SystemExit otherwise."""
    parts = urllib.parse.urlsplit(url)
    try:
        parts.port
    except ValueError:
        sys.exit(f"{what}: the port is not a port")
    if parts.scheme not in ("http", "https") or not parts.hostname or parts.query or parts.fragment or parts.username is not None or parts.password is not None:
        sys.exit(f"{what}: an http or https URL with no query and no user or password")
    if parts.scheme != "https" and not on_this_machine(parts):
        sys.exit(f"{what}: https, or a server on this machine (a token is not sent in the clear)")
    return url.rstrip("/")


def read_token(path: str) -> str:
    """The one token in the file, read now. Never printed."""
    try:
        with open(path) as f:
            bearer = f.read().strip()
    except OSError:
        raise HttpError(502, "a token file could not be read") from None
    if not bearer or any(c in bearer for c in "\r\n\0 "):
        raise HttpError(502, "a token file does not hold one token")
    return bearer


def refuse_constant(name: str):
    raise ValueError(f"{name} is not JSON")


def outside_post(base: str, path: str, payload: dict, bearer_file, what: str) -> dict:
    """One POST of JSON to a server this service does not trust (a token registry, the validator's wallet), with the bearer token in `bearer_file` when given. Over http the
    connected peer must be this machine, checked before anything is sent; a redirect is not followed (any status but 200 is a 502); the answer is read to at most
    RELAY_MAX_ANSWER bytes, the whole call within OUTSIDE_DEADLINE seconds (a timer shuts the connection), and must be a JSON object. The token and the answer's text are never logged."""
    started, sent = time.monotonic(), False   # the deadline runs from here: it covers the connect and the read
    url = urllib.parse.urlsplit(base)
    try:
        bearer = read_token(bearer_file) if bearer_file else None
    except HttpError as e:
        raise NotSent(e.status, e.message) from None
    hold = watchdog = r = None
    conn = (http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection)(url.hostname, url.port, timeout=OUTSIDE_DEADLINE)
    try:
        conn.connect()
        sock = conn.sock   # the connection closes it once the response is under way
        left = OUTSIDE_DEADLINE - (time.monotonic() - started)   # what the connect left of the deadline
        if left <= 0:
            raise OSError("the deadline passed")
        hold = socket.socket(fileno=os.dup(sock.fileno()))   # a second handle on the connection: at the deadline it ends whatever read is waiting

        def cut():
            with contextlib.suppress(OSError):
                hold.shutdown(socket.SHUT_RDWR)
        watchdog = threading.Timer(left, cut)
        watchdog.daemon = True
        watchdog.start()
        if url.scheme != "https" and not is_loopback_address(sock.getpeername()[0]):
            raise OSError("not on this machine")
        headers = {"content-type": "application/json", "accept": "application/json", "user-agent": USER_AGENT, **({"authorization": f"Bearer {bearer}"} if bearer else {})}
        sent = True   # from here the server may have acted on it, whatever comes of the call
        conn.request("POST", url.path.rstrip("/") + path, json.dumps(payload).encode(), headers)
        r = conn.getresponse()
        if r.status != 200:
            raise HttpError(502, f"{what} answered HTTP {r.status}", registryStatus=r.status)
        chunks, size = [], 0
        while True:
            chunk = r.read1(8192)
            if not chunk:
                break
            size += len(chunk)
            if size > RELAY_MAX_ANSWER:
                raise ValueError("the answer is too long")
            chunks.append(chunk)
        answer = json.loads(b"".join(chunks), parse_constant=refuse_constant)
        if not isinstance(answer, dict):
            raise ValueError("the answer is not an object")
        return answer
    except HttpError:
        raise
    except (OSError, http.client.HTTPException, ValueError, RecursionError) as e:
        print(f"{what}: {path}: {type(e).__name__}" + (f": {e}"[:100] if isinstance(e, OSError) else ""), file=sys.stderr)   # a socket's message only, never the answer's text
        raise (HttpError if sent else NotSent)(502, f"{what} could not be used") from None
    finally:
        if watchdog:
            watchdog.cancel()
        if hold:
            hold.close()
        if r:
            r.close()
        conn.close()


def private_file(path: str, option: str, what: str) -> None:
    """SystemExit unless `path` is a regular file that only its owner can read (mode 0600 or stricter) and holds one token."""
    try:
        mode = os.stat(path).st_mode
        if not stat.S_ISREG(mode):
            sys.exit(f"{option} {path} is not a file")
        if mode & 0o077:
            sys.exit(f"{option} {path} must be readable by its owner only (mode 0600): it is {what}")
        read_token(path)
    except (OSError, HttpError) as e:
        sys.exit(f"{option} {path}: {getattr(e, 'message', 'cannot be read')}")


def parse_registries(items, token_items) -> dict:
    """{instrument admin: (URL, token file or None)} from `ADMIN=URL` and `ADMIN=FILE` items. The URL is the root of the registry's token standard API
    (`<URL>/registry/...`); for Canton Coin the validator's scan proxy. SystemExit when one is not right."""
    found = {}
    for item in items or []:
        admin, _, url = item.partition("=")
        if not PARTY.match(admin) or admin in found:
            sys.exit(f"--registry {item!r}: ADMIN=URL, ADMIN a party id, one registry for each")
        found[admin] = (outside_url(url, f"--registry {item!r}"), None)
    for item in token_items or []:
        admin, _, path = item.partition("=")
        if admin not in found:
            sys.exit(f"--registry-token-file for {admin!r}, which has no --registry")
        private_file(path, "--registry-token-file", "the registry's token")
        found[admin] = (found[admin][0], path)
    return found


class Faucet:
    """DevNet only: the validator's own party sends `amount` Canton Coin to an account, through the validator's wallet API (`POST <url>/v0/wallet/token-standard/transfers`, with
    the validator's token, which is admin-level). An account has one a day, so has a client (an IPv4 address, an IPv6 /48), and `per_day` is the total of the day. A grant is
    counted when it is asked for: one that fails still counts, except one that failed before anything was sent to the wallet (the token could not be read, the connection could
    not be made): that cannot have made a transfer, so it is given back. A failure after the request was written, a timeout, or any answer at all is not: the transfer may exist."""
    def __init__(self, amount: str, url: str, bearer_file: str, per_day: int = 200):
        self.amount, self.url, self.bearer_file, self.lock = amount, url, bearer_file, threading.Lock()
        self.per_account = day_limit(1, ("faucet_account_full", "This account has had its Canton Coin from the faucet today; try again after {time}."))
        self.per_client = day_limit(1, ("faucet_network_full", "This network has had Canton Coin from the faucet today; try again after {time} or from another network."))
        self.total = day_limit(per_day, ("faucet_all_full", "The faucet has given out all of today's Canton Coin; try again after {time}."))

    def limiters(self) -> tuple:
        return self.per_account, self.per_client, self.total

    def grant(self, party: str, client: str) -> dict:
        items = [(self.per_account, party), (self.per_client, client), (self.total, "all")]
        with self.lock:   # checked and charged as one step, so that two requests at once cannot both pass
            for limiter, key in items:
                limiter.check(key)
            for limiter, key in items:
                limiter.hit(key)
        request = {"receiver_party_id": party, "amount": self.amount, "description": "DevNet faucet", "expires_at": int((time.time() + 3600) * 1_000_000),
                   "tracking_id": "faucet-" + str(uuid.uuid4())}
        try:
            output = outside_post(self.url, "/v0/wallet/token-standard/transfers", request, self.bearer_file, "the validator's wallet").get("output")
        except NotSent:
            with self.lock:
                for limiter, key in items:
                    limiter.refund(key)
            raise
        # The answer is Splice 0.10.0's `TransferInstructionResultResponse` (wallet-internal.yaml, createTokenStandardTransfer): `output` is a oneOf with no discriminator field,
        # {transfer_instruction_cid} when pending, {receiver_holding_cids: [...]} when completed, {dummy} when failed.
        output = output if isinstance(output, dict) else {}
        cid = output.get("transfer_instruction_cid")
        if isinstance(cid, str) and CONTRACT_ID.match(cid):
            return {"transferInstructionCid": cid}
        if isinstance(output.get("receiver_holding_cids"), list):
            return {"completed": True}
        raise HttpError(502, "the validator's wallet did not make the transfer")


def keep_relay_token_apart(registries: dict, faucet_token_file) -> None:
    """SystemExit when a registry's token is the faucet's. The registry relay answers any client with its token (the public relay needs no account), so that token must be a
    user's own that the registry accepts and that can do no more, never the faucet's admin-level one: a file with the faucet's token, the same file or another, is refused."""
    if not faucet_token_file:
        return
    faucet_token = read_token(faucet_token_file).encode()
    for admin, (_, path) in registries.items():
        if path and hmac.compare_digest(read_token(path).encode(), faucet_token):
            sys.exit(f"--registry-token-file for {admin!r} holds the faucet's token ({faucet_token_file}): the registry relay is open to anyone, so give it a token of its own, of a user with no admin right")


def faucet_from(amount, url, bearer_file, per_day: int):
    """The faucet the options ask for, or None when --faucet-amount is not given. SystemExit when it is not right, or the token file can be read by others."""
    if amount is None:
        return None
    if not FAUCET_AMOUNT.match(amount) or not float(amount) > 0 or per_day < 1:
        sys.exit("--faucet-amount is more than zero with at most 10 decimals; --faucet-per-day is at least 1")
    if not url or not bearer_file:
        sys.exit("--faucet-amount needs --faucet-url (the validator's API root) and --faucet-token-file")
    private_file(bearer_file, "--faucet-token-file", "the validator's admin token")
    return Faucet(amount if "." in amount else amount + ".0", outside_url(url, "--faucet-url"), bearer_file, per_day)


class HumanCheck:
    """An optional human check on a new account's `topology` request (off unless the service is started with it). The page sends the token its widget gave in `captcha`; the service posts
    `{"secret", "response", "remoteip"}` as JSON to the check's verify URL and wants `{"success": true}` back, which is how Cloudflare Turnstile answers (a check that wants a form post instead of JSON, such as reCAPTCHA, does not work with it).
    The secret is read from a file for each check and never logged. A check that cannot be reached refuses the request (fail closed), and a failed check counts as a failed signature does
    (`Accounts.failures`): a client network that fails FAILED_VERIFIES times in a minute is refused before another call is made. `allocate` needs the topology's blob, which only a checked
    `topology` request makes, so the pair is covered. A token works once, which is why one check covers the pair and not each of them."""
    def __init__(self, verify_url: str, secret_file: str):
        self.verify_url, self.secret_file = outside_url(verify_url, "--human-check-url"), secret_file
        private_file(secret_file, "--human-check-secret-file", "the human check's secret")
        parts = urllib.parse.urlsplit(self.verify_url)
        self.base, self.path = f"{parts.scheme}://{parts.netloc}", parts.path or "/"

    def verify(self, token, ip: str) -> bool:
        """Whether the token is a person's. HttpError 502 when the check cannot be used."""
        if not isinstance(token, str) or not 0 < len(token) <= 2048:
            return False
        request = {"secret": read_token(self.secret_file), "response": token, **({"remoteip": ip} if ip else {})}
        return outside_post(self.base, self.path, request, None, "the human check").get("success") is True


class Ledger:
    """The JSON Ledger API (v2). The token is read from its file for each call (a rotated token is picked up) or is the fixed one given at start."""
    def __init__(self, url: str, token_file: str = None, token: str = ""):
        self.url, self.token_file, self.fixed = url.rstrip("/"), token_file, token

    def call(self, method: str, path: str, body=None):
        try:
            token = open(self.token_file).read().strip() if self.token_file else self.fixed
            if not token:
                raise OSError("the token file is empty")
            request = urllib.request.Request(self.url + path, None if body is None else json.dumps(body).encode(), method=method,
                                             headers={"content-type": "application/json", "authorization": f"Bearer {token}"})
            with urllib.request.urlopen(request, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            with e:
                raw = e.read().decode(errors="replace")
            try:
                answer = json.loads(raw)
            except ValueError:
                answer = {}
            if e.code in (401, 403) or e.code >= 500:   # the service's own login or the participant: not the caller's fault
                print(f"{method} {path}: {e.code} {raw[:300]}", file=sys.stderr)
                raise HttpError(502, "the ledger could not do that now") from None
            raise HttpError(422, "the ledger refused the request", code=answer.get("code"), detail=str(answer.get("cause") or raw)[:300]) from None
        except (OSError, ValueError) as e:
            print(f"{method} {path}: {type(e).__name__}: {e}", file=sys.stderr)
            raise HttpError(502, "the ledger could not be reached") from None


class Pending:
    """What was handed out and may come back signed, for `ttl` seconds: key -> value. At most `limit` entries, `per_owner` for one owner (a client) and, when
    a group (an account) is given, `per_group` for one group. In memory: a restart voids it, and the page asks again."""
    def __init__(self, ttl: float = PENDING_TTL, limit: int = 5000, per_owner: int = 10, clock=time.monotonic, per_group: int = None):
        self.ttl, self.limit, self.per_owner, self.per_group, self.clock = ttl, limit, per_owner, per_group, clock
        self.items, self.lock = {}, threading.Lock()

    def _room(self, now: float, key, owner: str, group: str) -> None:
        if key is None or key not in self.items or self.items[key][0] <= now:   # an entry that is replaced takes no new room
            live = [v for v in self.items.values() if v[0] > now]
            if (len(live) >= self.limit or sum(v[2] == owner for v in live) >= self.per_owner
                    or (group is not None and self.per_group is not None and sum(v[3] == group for v in live) >= self.per_group)):
                raise HttpError(503, "too many requests are waiting for a signature")

    def room(self, owner: str = "", group: str = None) -> None:
        """Refuse (503) as `put` of a new entry would, and add nothing: asked before any call to the participant."""
        with self.lock:
            self._room(self.clock(), None, owner, group)

    def put(self, key: str, value, owner: str = "", group: str = None) -> None:
        with self.lock:
            now = self.clock()
            self._room(now, key, owner, group)
            self.items[key] = (now + self.ttl, value, owner, group)

    def count(self) -> int:
        """How many entries wait now."""
        with self.lock:
            now = self.clock()
            return sum(v[0] > now for v in self.items.values())

    def values(self, group: str) -> list:
        """What waits for one group (an account)."""
        with self.lock:
            now = self.clock()
            return [v[1] for v in self.items.values() if v[0] > now and v[3] == group]

    def prune(self) -> None:
        with self.lock:
            now = self.clock()
            self.items = {k: v for k, v in self.items.items() if v[0] > now}

    def get(self, key: str):
        with self.lock:
            hit = self.items.get(key)
            return hit[1] if hit and hit[0] > self.clock() else None

    def take(self, key: str):
        """The value, removed in the same step: of two callers for one key, one gets it."""
        with self.lock:
            hit = self.items.pop(key, None)
            return hit[1] if hit and hit[0] > self.clock() else None

    def drop(self, key: str) -> None:
        with self.lock:
            self.items.pop(key, None)


def utc_time(at: float) -> str:
    """A moment as the words of a message: 14:32 UTC."""
    return time.strftime("%H:%M UTC", time.gmtime(at))


class Limiter:
    """At most `count` in total weight per key in `window` seconds. A refusal is a 429 with `retryAfter`; when the limiter has a `code`, the answer carries it as `code`, and a `message`
    (with `{time}` where the moment the key can try again goes, as 14:32 UTC) says in plain words which limit was reached: a limit that a network or everyone shares says so."""
    def __init__(self, count: int, window: float, clock=time.monotonic, code: str = None, message: str = None, wall=time.time):
        self.count, self.window, self.clock, self.hits, self.lock = count, window, clock, {}, threading.Lock()
        self.code, self.message, self.wall = code, message, wall

    def refusal(self, wait: int) -> HttpError:
        extra = {"retryAfter": wait, **({"code": self.code} if self.code else {})}
        return HttpError(429, self.message.format(time=utc_time(self.wall() + wait)) if self.message else "too many requests: try again later", **extra)

    def _room(self, key: str, weight: int, create: bool):
        now = self.clock()
        q = self.hits.setdefault(key, collections.deque()) if create else self.hits.get(key, collections.deque())
        while q and q[0][0] <= now - self.window:
            q.popleft()
        if sum(w for _, w in q) + weight > self.count:
            raise self.refusal(int(q[0][0] + self.window - now) + 1 if q else int(self.window))
        return q, now

    def check(self, key: str, weight: int = 1) -> None:
        """Refuse as `hit` would, and count nothing."""
        with self.lock:
            self._room(key, weight, False)

    def hit(self, key: str, weight: int = 1) -> None:
        with self.lock:
            q, now = self._room(key, weight, True)
            q.append((now, weight))

    def used(self, key: str) -> int:
        """The weight counted for this key inside the window now."""
        with self.lock:
            now = self.clock()
            return sum(w for t, w in self.hits.get(key, ()) if t > now - self.window)

    def refund(self, key: str, weight: int = 1) -> None:
        """Take back the latest `hit` of this weight on this key (the hit of a request that is known to have done nothing)."""
        with self.lock:
            q = self.hits.get(key) or ()
            for i in range(len(q) - 1, -1, -1):
                if q[i][1] == weight:
                    del q[i]
                    break

    def prune(self) -> None:
        with self.lock:
            now = self.clock()
            self.hits = {k: q for k, q in self.hits.items() if q and q[-1][0] > now - self.window}


# What a person is told when a daily budget is spent: the code (a client acts on it) and the words. `{time}` is when the key may try again. A budget that a network or everyone shares says so.
NETWORK_ACCOUNTS = ("accounts_network_full", "This network has opened today's share of new accounts; try again after {time} or from another network.")
ALL_ACCOUNTS = ("accounts_all_full", "Today's new accounts are all taken; try again after {time}.")
NETWORK_SENDS = ("send_network_full", "This network has used today's share of Bridge transactions; try again after {time} or from another network.")
ACCOUNT_SENDS = ("send_account_full", "This account has used today's Bridge transactions; try again after {time}.")
ALL_SENDS = ("send_all_full", "The Bridge has used all of today's transactions for everyone; try again after {time}. Taking back a deposit and accepting a transfer still work.")
TAKE_BACKS_ALL = ("take_backs_all_full", "Today's take-backs and accepts are all used for everyone; try again after {time}.")


def day_limit(count: int, words: tuple) -> Limiter:
    """A daily budget whose refusal carries `words` (a code and a sentence)."""
    return Limiter(count, DAY, code=words[0], message=words[1])


class InFlight:
    """Executes of a limited template that got no answer (a timeout, a 5xx) and may still commit: (account, template) is counted as open until the transaction's
    `maxRecordTime` has passed (`ttl` seconds when it is not given)."""
    def __init__(self, ttl: float = IN_FLIGHT_TTL, clock=time.monotonic):
        self.ttl, self.clock, self.marks, self.lock = ttl, clock, {}, threading.Lock()

    def add(self, key, ttl: float = None) -> None:
        with self.lock:
            self.marks.setdefault(key, []).append(self.clock() + (self.ttl if ttl is None else ttl))

    def count(self, key) -> int:
        with self.lock:
            now = self.clock()
            return sum(t > now for t in self.marks.get(key, ()))

    def prune(self) -> None:
        with self.lock:
            now = self.clock()
            self.marks = {k: live for k, v in self.marks.items() if (live := [t for t in v if t > now])}


class Replays:
    """The account signatures seen inside the time window: (party, seconds, signature) is accepted once."""
    def __init__(self, wall=time.time):
        self.wall, self.seen, self.lock = wall, {}, threading.Lock()

    def used(self, party: str, seconds: int, signature: bytes) -> bool:
        with self.lock:
            return (party, seconds, signature) in self.seen

    def add(self, party: str, seconds: int, signature: bytes) -> bool:
        with self.lock:
            key = (party, seconds, signature)
            if key in self.seen:
                return False
            self.seen[key] = seconds + AUTH_WINDOW
            return True

    def prune(self) -> None:
        with self.lock:
            now = self.wall()
            self.seen = {k: until for k, until in self.seen.items() if until >= now}


class Parties:
    """The parties this service allocated, each with the Ed25519 key it was made with: kept in memory and appended to `path` (one JSON line each), so that it
    answers for them after a restart."""
    def __init__(self, path: str):
        self.path, self.parties, self.lock, self.torn = path, {}, threading.Lock(), False
        if os.path.exists(path):
            with open(path, "rb") as f:
                lines = f.read().split(b"\n")
            # The last piece is empty when the file ends in a newline; else a write did not finish: that line is ignored, and the next append starts a new one.
            self.torn = bool(lines.pop())
            if self.torn:
                print(f"state file {path}: the last line is torn and ignored", file=sys.stderr)
            for line in lines:
                try:
                    entry = json.loads(line)
                    self.parties[entry["party"]] = base64.b64decode(entry["key"], validate=True)
                except (ValueError, KeyError, TypeError):
                    print(f"state file {path}: a line is dropped", file=sys.stderr)

    def __contains__(self, party: str) -> bool:
        return party in self.parties

    def key(self, party: str) -> bytes:
        return self.parties[party]

    def add(self, party: str, key: bytes) -> None:
        with self.lock:
            if party not in self.parties:
                with open(self.path, "a") as f:
                    f.write("\n" * self.torn + json.dumps({"party": party, "key": base64.b64encode(key).decode(), "at": int(time.time())}) + "\n")
                    f.flush(); os.fsync(f.fileno())
                self.torn = False
                self.parties[party] = key


class Accounts:
    def __init__(self, ledger: Ledger, user: str, parties: Parties, allow, hint: str = "rome", synchronizer: str = None, topology_version: int = None,
                 creates: Limiter = None, rate: Limiter = None, topologies: Pending = None, prepared: Pending = None, chain: dict = None,
                 open_limits: dict = None, per_account: Limiter = None, per_client: Limiter = None, overall: Limiter = None, traffic: Limiter = None,
                 max_traffic: int = 200000, new_total: Limiter = None, rights_gap: float = 5.0, failures: Limiter = None, account_rate: Limiter = None,
                 network_rate: Limiter = None, registries: dict = None, faucet: Faucet = None, public_relay_rate: Limiter = None, public_relay_total: Limiter = None,
                 creates_net: Limiter = None, per_net: Limiter = None, take_backs: Limiter = None, public_relay_net: Limiter = None, account_cap: int = ACCOUNT_CAP,
                 human_check: "HumanCheck" = None, take_back_traffic: Limiter = None):
        self.ledger, self.user, self.parties, self.allow, self.hint = ledger, user, parties, set(allow), hint
        self.synchronizer, self.topology_version = synchronizer, topology_version
        self.creates, self.rate = creates or day_limit(3, NETWORK_ACCOUNTS), rate or Limiter(60, 60)
        self.creates_net = creates_net or day_limit(NEW_ACCOUNTS_PER_NETWORK, NETWORK_ACCOUNTS)   # new accounts a day for a client network (an IPv4 address, an IPv6 /48): a /48 holds 65,536 /64s, each with a count of its own
        self.account_rate, self.network_rate = account_rate or Limiter(ACCOUNT_RATE, 60), network_rate or Limiter(NETWORK_RATE, 60)
        self.public_relay_rate = public_relay_rate or Limiter(PUBLIC_RELAY_RATE, 60)
        self.public_relay_total = public_relay_total or Limiter(PUBLIC_RELAY_TOTAL, 60)   # one key, "all": a ceiling over every client
        self.public_relay_net = public_relay_net or Limiter(PUBLIC_RELAY_NETWORK, 60)
        self.topologies, self.prepared = topologies or Pending(limit=2000), prepared or Pending(per_group=PENDING_PER_ACCOUNT)   # the caps of the two are apart
        self.chain = chain or {}   # the chain's parties by field name: what a create's observers must be
        self.open_limits = {ACCEPTANCE: 1, DEPOSIT: 3} if open_limits is None else open_limits   # most open contracts of a template an account may have
        # What executes and allocations may spend in a day: per account, per client, overall, and the overall traffic that the participant estimates.
        self.per_account, self.per_client, self.overall = per_account or day_limit(50, ACCOUNT_SENDS), per_client or day_limit(200, NETWORK_SENDS), overall or day_limit(2000, ALL_SENDS)
        self.per_net = per_net or day_limit(EXECUTES_PER_NETWORK, NETWORK_SENDS)   # the same, for a client network (an IPv6 /48 holds many /64s)
        self.traffic, self.max_traffic = traffic or day_limit(50_000_000, ALL_SENDS), max_traffic
        self.take_backs = take_backs or day_limit(TAKE_BACKS_PER_DAY, TAKE_BACKS_ALL)   # the take-backs and accepts of `SHARED_EXEMPT`: a ceiling of their own, which creates cannot fill
        self.take_back_traffic = take_back_traffic or day_limit(TAKE_BACK_TRAFFIC_PER_DAY, TAKE_BACKS_ALL)   # and a traffic share of their own, so they are bounded too
        self.new_total = new_total or day_limit(200, ALL_ACCOUNTS)   # new accounts a day, all clients: the participant's party and rights quotas are finite
        self.account_cap, self.human_check = account_cap, human_check
        self.budget_lock = threading.Lock()   # the budgets are checked and charged as one step
        self.failures = failures or Limiter(FAILED_VERIFIES, 60)   # signatures that failed, per client
        self.registries, self.faucet = registries or {}, faucet   # token registries by instrument admin: (URL, token file); the DevNet faucet, or None
        self.in_flight = InFlight()
        self.account_locks, self.account_locks_guard = {}, threading.Lock()
        self.secret = secrets.token_bytes(32)
        self.clock, self.wall, self.replays = time.monotonic, time.time, Replays()
        # The ledger user's own rights are the truth of which parties this service holds; read at start and again on a miss, at most every `rights_gap` seconds.
        self.rights, self.rights_at, self.rights_gap, self.rights_lock = set(), None, rights_gap, threading.Lock()
        self.health_at, self.health_error, self.health_lock, self.health_busy = None, None, threading.Lock(), False

    def sync_id(self) -> str:
        if not self.synchronizer:
            found = self.ledger.call("GET", "/v2/state/connected-synchronizers").get("connectedSynchronizers") or []
            if len(found) != 1:
                raise HttpError(502, f"the participant is connected to {len(found)} synchronizers: name one with --synchronizer-id")
            self.synchronizer = found[0]["synchronizerId"]
        return self.synchronizer

    @staticmethod
    def signature(raw_b64: str, fingerprint: str) -> dict:
        return {"format": SIGNATURE_FORMAT, "signature": raw_b64, "signedBy": fingerprint, "signingAlgorithmSpec": "SIGNING_ALGORITHM_SPEC_ED25519"}

    def spend(self, ip: str, party: str = None, traffic: int = 0, extra=(), take=None, exempt: bool = False):
        """Count one execute or allocation against the day's budgets: the account's, the client's (an IPv4 address or an IPv6 /64), the client network's (an IPv6 /48), and the two
        that everyone shares, the executes and the traffic. An `exempt` one (a take-back or an accept, `SHARED_EXEMPT`) counts against a shared ceiling of its own, and a traffic share of its own, in their place, so
        creates cannot use up what people need to get a deposit back, and take-backs cannot use up the traffic that creates need. Every budget is checked first and they are charged together, so a refusal (429) charges none of them.
        `take`, when given, runs between the check and the charge and is what removes the prepared entry: it survives a refusal."""
        shared = [(self.take_backs, "all", 1), *([(self.take_back_traffic, "all", traffic)] if traffic else [])] if exempt else [(self.overall, "all", 1), *([(self.traffic, "all", traffic)] if traffic else [])]
        items = [*extra, *([(self.per_account, party, 1)] if party else []), (self.per_client, ip, 1), (self.per_net, pending_owner(ip), 1), *shared]
        with self.budget_lock:
            for limiter, key, weight in items:
                limiter.check(key, weight)
            taken = take() if take else None
            for limiter, key, weight in items:
                limiter.hit(key, weight)
        return taken

    def account_lock(self, party: str):
        with self.account_locks_guard:
            return self.account_locks.setdefault(party, threading.Lock())

    def proves(self, key: bytes, message: bytes, signature: bytes, ip: str) -> bool:
        """Whether the signature verifies. Verifying costs the service CPU whichever party is named, so a client (an IPv6 /48) with FAILED_VERIFIES failures in a
        minute is refused (429) before anything is verified. Failures are not counted per party: anyone can name a party, and that would lock its owner out."""
        name = pending_owner(ip)
        self.failures.check(name)
        if ed25519.verify(key, message, signature):
            return True
        self.failures.hit(name)
        return False

    def known(self, party) -> str:
        if not isinstance(party, str) or party not in self.parties:
            raise HttpError(404, "this service did not make that account")
        return party

    # ---- which parties are held, and proof of the key

    def load_rights(self, force: bool = False) -> None:
        """Read the ledger user's CanActAs rights (the parties this service holds), at most every `rights_gap` seconds unless forced."""
        if not self.rights_lock.acquire(blocking=False):
            return
        try:
            now = self.clock()
            if not force and self.rights_at is not None and now - self.rights_at < self.rights_gap:
                return
            self.rights_at = now
            out = self.ledger.call("GET", "/v2/users/" + urllib.parse.quote(self.user, safe="") + "/rights")
            kinds = [(r.get("kind") or {}) for r in out.get("rights") or [] if isinstance(r, dict)]
            self.rights = {((k.get("CanActAs") or {}).get("value") or {}).get("party") for k in kinds} - {None}
        finally:
            self.rights_lock.release()

    def holds(self, party: str) -> bool:
        if party not in self.rights and isinstance(party, str) and PARTY.match(party):   # only an id that could be a party is worth a read of the rights
            self.load_rights()
        return party in self.rights

    def key_of(self, party) -> bytes:
        if isinstance(party, str):
            if party in self.parties:
                return self.parties.key(party)
            if self.holds(party):   # the user can act as it, the state file has no line for it: the Ledger API does not give a party's key
                raise conflict("account_key_unknown", "this service holds that account but not its key: register it again (topology, then allocate, with the same key)")
        raise HttpError(404, "this service did not make that account")

    def authenticate(self, party, method: str, path: str, raw: bytes, header, ip: str = "") -> None:
        """Proof of the account's key on a request about it: header `<unix seconds>.<base64 signature>`, the signature over
        `accounts-v1\\n<METHOD>\\n<PATH>\\n<hex sha256 of the body>\\n<unix seconds>`, within AUTH_WINDOW of the server's time. A request that changes something
        (anything but GET) must also not have been seen before; a GET only reads, so repeating it is harmless (two reads in the same second carry the same signature)."""
        key = self.key_of(party)
        m = re.fullmatch(r"(\d{1,12})\.([A-Za-z0-9+/=]{1,100})", header or "")
        try:
            signature = base64.b64decode(m[2], validate=True) if m else b""
        except (binascii.Error, ValueError):
            signature = b""
        if len(signature) != 64:
            raise HttpError(401, "this request needs the account's signature in X-Account-Signature: <unix seconds>.<base64 signature>")
        seconds = int(m[1])
        message = f"accounts-v1\n{method}\n{path}\n{hashlib.sha256(raw).hexdigest()}\n{seconds}".encode()
        if abs(self.wall() - seconds) > AUTH_WINDOW:
            raise HttpError(401, "the account's signature is not valid for this request, or is too old")
        changes = method != "GET"   # the replay memory guards what changes something; a read repeated is idempotent and stays under the account's rate
        if changes and self.replays.used(party, seconds, signature):
            raise HttpError(401, "this signature was used already")
        if not self.proves(key, message, signature, ip):
            raise HttpError(401, "the account's signature is not valid for this request, or is too old")
        if changes and not self.replays.add(party, seconds, signature):
            raise HttpError(401, "this signature was used already")

    def health(self) -> dict:
        """The participant's answer to /v2/version, asked at most every HEALTH_TTL seconds however many ask. The lock is not held during the call: while one
        request refreshes the answer, the others get the last one."""
        with self.health_lock:
            refresh = not self.health_busy and (self.health_at is None or self.clock() - self.health_at >= HEALTH_TTL)
            self.health_busy = self.health_busy or refresh
            asked, error = self.health_at is not None, self.health_error
        if refresh:
            try:
                self.ledger.call("GET", "/v2/version")
                error = None
            except HttpError as e:
                error = e.message
            finally:
                with self.health_lock:
                    self.health_error, self.health_at, self.health_busy = error, self.clock(), False
        elif not asked:
            error = "not checked yet"
        return {"ok": True, **self.usage()} if error is None else {"ok": False, "error": error, **self.usage()}

    def usage(self) -> dict:
        """How full each limit that many clients share is, for the explorer's health check and the operator: the accounts held against the participant's cap (`--account-cap`), and, for each shared
        ceiling, what is counted now and what it allows. A ceiling is a whole-service one: a per-client or per-account budget is not listed. Counts only; no address, no account."""
        held = len(set(self.parties.parties) | self.rights)   # the participant counts the user's rights; the state file may miss a line
        ceilings = {
            "newAccountsDay": (self.new_total.used("all"), self.new_total.count),
            "executesDay": (self.overall.used("all"), self.overall.count),
            "trafficDay": (self.traffic.used("all"), self.traffic.count),
            "takeBacksDay": (self.take_backs.used("all"), self.take_backs.count),
            "takeBackTrafficDay": (self.take_back_traffic.used("all"), self.take_back_traffic.count),
            "publicRelayMinute": (self.public_relay_total.used("all"), self.public_relay_total.count),
            "waitingTopologies": (self.topologies.count(), self.topologies.limit),
            "waitingTransactions": (self.prepared.count(), self.prepared.limit),
            **({"faucetDay": (self.faucet.total.used("all"), self.faucet.total.count)} if self.faucet else {}),
        }
        return {"accounts": held, "accountCap": self.account_cap, "ceilings": {k: {"used": used, "limit": limit} for k, (used, limit) in ceilings.items()}}

    def sweep(self) -> None:
        """Drop what has expired from the limiters, the pending maps and the replay memory (a timer thread calls this)."""
        for part in (self.creates, self.creates_net, self.rate, self.per_account, self.per_client, self.per_net, self.overall, self.traffic, self.take_backs, self.take_back_traffic, self.new_total, self.failures, self.account_rate, self.network_rate,
                     self.public_relay_rate, self.public_relay_net, self.public_relay_total, self.in_flight, self.topologies, self.prepared, self.replays,
                     *(self.faucet.limiters() if self.faucet else ())):
            part.prune()

    def start_sweeper(self, every: float = 30) -> threading.Thread:
        def loop():
            while True:
                time.sleep(every)
                try:
                    self.sweep()
                except Exception as e:
                    print(f"sweep: {type(e).__name__}: {e}", file=sys.stderr)
        thread = threading.Thread(target=loop, daemon=True)
        thread.start()
        return thread

    # ---- the routes

    def handle(self, method: str, path: str, body, ip: str, raw: bytes = b"", auth: str = None):
        if path == "/healthz" and method == "GET":
            return self.health()
        ip = client_key(ip)
        self.rate.hit(ip)
        self.network_rate.hit(pending_owner(ip))   # a /48 holds many /64s, each with a rate of its own
        if method == "POST" and (public := PUBLIC_RELAY_PATH.fullmatch(path)):
            # Read-only and public: no account, no signature (so no replay memory and no account rate); the client's own rate is the limit.
            if body is None and not raw.strip():
                body = {}   # no body at all is an empty request
            if not isinstance(body, dict):
                raise HttpError(400, "the body must be a JSON object")
            net = pending_owner(ip)
            self.public_relay_rate.check(ip)
            self.public_relay_net.check(net)
            self.public_relay_total.check("all")
            self.public_relay_rate.hit(ip)
            self.public_relay_net.hit(net)
            self.public_relay_total.hit("all")
            return self.relay_public(urllib.parse.unquote(public[1]), public[3], body, public[5], public[2] == "transfer-factory", public[4])
        if method == "POST":
            routes = {"/accounts/v1/topology": self.topology, "/accounts/v1/allocate": self.allocate, "/accounts/v1/prepare": self.prepare,
                      "/accounts/v1/execute": self.execute, **({"/accounts/v1/faucet": self.grant} if self.faucet else {})}
            route, relay = routes.get(path), RELAY_PATH.fullmatch(path)
            if route or relay:
                body = body if isinstance(body, dict) else {}
                party = None
                if route in (self.prepare, self.execute):   # the party the request is about must have signed it
                    sigs = body.get("partySignatures")
                    first = sigs[0] if isinstance(sigs, list) and sigs else None
                    party = body.get("party") if route == self.prepare else first.get("party") if isinstance(first, dict) else None
                elif relay or route == self.grant:
                    party = body.get("party")
                if isinstance(party, str):
                    self.authenticate(party, method, path, raw, auth, ip)
                    self.account_rate.hit(party)   # counted once the key has proved the account: naming a party cannot use up its rate
                if relay:
                    return self.relay(urllib.parse.unquote(relay[1]), relay[3], body, relay[5], relay[2] == "transfer-factory", relay[4])
                return route(body, ip)
        elif method == "GET":
            m = re.fullmatch(r"/accounts/v1/(holdings|allocations|open|transfers)/([^/]+)", path)
            if m:
                party = urllib.parse.unquote(m.group(2))
                self.authenticate(party, method, path, raw, auth, ip)
                self.account_rate.hit(party)
                return getattr(self, m.group(1))(party)
        raise HttpError(404, "no such route")

    def relay(self, admin: str, instruction, body: dict, allocation=None, transfer_factory: bool = False, choice: str = "accept") -> dict:
        """Read-only relay to the token standard's off-chain API of the registry of `admin`: the allocation factory or the transfer factory, or (for a transfer instruction's contract id)
        the choice context of its acceptance or of its withdrawal (`choice`), or (for an allocation's contract id) the choice context of its withdrawal. The body goes on without `party`, the answer as it is."""
        self.known(body.get("party"))
        return self.forward(admin, instruction, {k: v for k, v in body.items() if k != "party"}, allocation, transfer_factory, choice)

    def relay_public(self, admin: str, instruction, body: dict, allocation=None, transfer_factory: bool = False, choice: str = "accept") -> dict:
        """The same read-only relay for a wallet this service did not make: nothing about an account is checked, and the body goes on exactly as it came."""
        return self.forward(admin, instruction, body, allocation, transfer_factory, choice)

    def forward(self, admin: str, instruction, payload: dict, allocation, transfer_factory: bool, choice: str) -> dict:
        if admin not in self.registries:
            raise HttpError(404, "this service has no registry for that instrument admin")
        if len(json.dumps(payload, separators=(",", ":"))) > RELAY_MAX_BODY:
            raise HttpError(400, f"the request is longer than {RELAY_MAX_BODY} bytes")
        url, bearer_file = self.registries[admin]
        path = (f"/registry/transfer-instruction/v1/{instruction}/choice-contexts/{choice}" if instruction else f"/registry/allocations/v1/{allocation}/choice-contexts/withdraw" if allocation
                else "/registry/transfer-instruction/v1/transfer-factory" if transfer_factory else "/registry/allocation-instruction/v1/allocation-factory")
        try:
            return outside_post(url, path, payload, bearer_file, "the token registry")
        except HttpError as e:
            if e.status != 502:
                raise
            # Not a 5xx: a proxy in front may replace an origin's 502 with a page of its own, and the page could not read the answer (which carries the registry's own status).
            raise HttpError(RELAY_FAILED, e.message, e.stable, **e.extra) from None

    def grant(self, body: dict, ip: str) -> dict:
        return self.faucet.grant(self.known(body.get("party")), pending_owner(ip))

    def topology(self, body: dict, ip: str) -> dict:
        raw = b64(body.get("publicKey"), "publicKey (an Ed25519 key)", (32, 44))
        if len(raw) == 44 and not raw.startswith(SPKI_ED25519):
            raise HttpError(400, "publicKey is not an Ed25519 key")
        if body.get("partyHint") not in (None, self.hint):
            raise HttpError(400, f"every account is named {self.hint}: partyHint is that or left out")
        raw = raw[-32:]
        # One blob for one key, and it is not minted again while it lives: asking again hands out the same one (it was checked then) and costs the participant nothing.
        blob = hmac.new(self.secret, raw, hashlib.sha256).hexdigest()[:48]
        again = self.topologies.get(blob)
        if again:
            if again[0] not in self.rights:   # a party the participant lists is restored by `allocate` with no budget spent, so it is not refused for one
                self.new_account_room(ip)   # the caps may have filled since it was handed out: say so now, before the person signs
            return {"party": again[0], "exists": False, "multiHash": again[3], "topologyTransactions": again[2], "blob": blob}
        self.topologies.room(pending_owner(ip))   # a client at its cap costs the participant nothing
        self.check_human(body, ip)
        if not ed25519.usable_key(raw):
            raise HttpError(400, "publicKey is not a usable Ed25519 key")
        key = {"format": "CRYPTO_KEY_FORMAT_DER_X509_SUBJECT_PUBLIC_KEY_INFO", "keySpec": "SIGNING_KEY_SPEC_EC_CURVE25519",
               "keyData": base64.b64encode(SPKI_ED25519 + raw).decode()}
        request = {"synchronizer": self.sync_id(), "partyHint": self.hint, "publicKey": key}
        if self.topology_version:
            request["protocolVersion"] = self.topology_version
        made = self.ledger.call("POST", "/v2/parties/external/generate-topology", request)
        party = made["partyId"]
        if party in self.parties:
            return {"party": party, "exists": True}
        if party not in self.rights:   # a party the participant lists and the state file lost is not a new account (the rights are as last read: no ledger call is made for this)
            self.new_account_room(ip)
        self.topologies.put(blob, (party, made["publicKeyFingerprint"], made["topologyTransactions"], made["multiHash"], raw), pending_owner(ip))
        return {"party": party, "exists": False, "multiHash": made["multiHash"], "topologyTransactions": made["topologyTransactions"], "blob": blob}

    def new_account_room(self, ip: str) -> None:
        """Refuse (429, in words that say which limit) when a new account could not be made now: the client's, its network's or everyone's budget of the day is spent. Nothing is counted: the
        count is `allocate`'s. Asked at `topology`, so a person hears it before the second, confirming wallet signature and not after."""
        self.creates.check(ip)
        self.creates_net.check(pending_owner(ip))
        self.new_total.check("all")

    def check_human(self, body: dict, ip: str) -> None:
        """The human check of `topology`, when the service has one: 403 `human_check_needed` without a token that passes. A client network with FAILED_VERIFIES failures in a minute is refused first."""
        if self.human_check is None:
            return
        name = pending_owner(ip)
        self.failures.check(name)
        if not self.human_check.verify(body.get("captcha"), "" if "/" in ip else ip):   # an IPv6 client is only its /64 here: the check is told no address for it
            self.failures.hit(name)
            raise HttpError(403, "complete the human check first", "human_check_needed")

    def allocate(self, body: dict, ip: str) -> dict:
        blob = text(body, "blob", 100)
        signature = text(body, "signature", 200)
        b64(signature, "signature", (64,))
        found = self.topologies.get(blob)
        if found is None:
            raise HttpError(404, "no such topology, or it has expired: ask for it again")
        party, fingerprint, transactions, multi_hash, raw = found
        if party in self.parties:
            return {"party": party, "created": False}
        if not self.proves(raw, base64.b64decode(multi_hash), base64.b64decode(signature), ip):
            raise HttpError(401, "the signature is not the key's signature of the multi-hash")
        if self.holds(party):   # the participant has this party for the service's user, the state file lost its line: the key is proved, so the line is written again
            self.parties.add(party, raw)
            self.topologies.drop(blob)
            return {"party": party, "created": False, "restored": True}
        self.spend(ip, extra=[(self.creates, ip, 1), (self.creates_net, pending_owner(ip), 1), (self.new_total, "all", 1)])
        # The user gets the right to act as the new party in the same call, so the service's user needs no admin right of its own.
        self.ledger.call("POST", "/v2/parties/external/allocate", {
            "synchronizer": self.sync_id(), "onboardingTransactions": [{"transaction": t} for t in transactions],
            "multiHashSignatures": [self.signature(signature, fingerprint)], "userId": self.user, "waitForAllocation": True})
        self.parties.add(party, raw)
        self.rights = self.rights | {party}
        self.topologies.drop(blob)
        return {"party": party, "created": True}

    def check_commands(self, party: str, commands) -> list:
        if not isinstance(commands, list) or len(commands) != 1:
            raise HttpError(400, "commands must hold exactly one command")
        command = commands[0]
        kind, args = next(iter(command.items())) if isinstance(command, dict) and len(command) == 1 else (None, None)
        if kind not in ("CreateCommand", "ExerciseCommand") or not isinstance(args, dict) or not isinstance(args.get("templateId"), str):
            raise HttpError(400, "the command is a CreateCommand or an ExerciseCommand with a templateId")
        if kind == "ExerciseCommand" and not isinstance(args.get("choice"), str):
            raise HttpError(400, "an ExerciseCommand names its choice")
        wanted = args["templateId"] + ("#" + args["choice"] if kind == "ExerciseCommand" else "")
        if wanted not in self.allow:
            raise HttpError(403, f"{wanted} is not on this service's list of allowed commands (name the package, not its id)")
        if kind == "CreateCommand":
            self.check_create(party, wanted, args.get("createArguments"))
        elif wanted in (ALLOCATION_WITHDRAW, TRANSFER_WITHDRAW, DEPOSIT_ARCHIVE, REDEEM_ARCHIVE):
            self.check_take_back(party, wanted, args.get("contractId"))
        return commands

    def passed(self, allocation: dict) -> bool:
        """Whether an allocation's settle-before time is past by the margin: from then the builder can no longer settle it (it leaves such a deposit out), so taking it back cannot make a block's advance fail."""
        m = TIME.fullmatch(str((((allocation.get("allocation") or {}).get("settlement")) or {}).get("settleBefore")))
        if not m:
            return False   # a time that cannot be read is not past
        at = calendar.timegm(time.strptime(m[1], "%Y-%m-%dT%H:%M:%S")) + float("0." + (m[2] or "0"))
        return self.wall() >= at + TAKE_BACK_MARGIN

    def check_take_back(self, party: str, wanted: str, contract) -> None:
        """An account takes back a deposit that cannot settle. It may withdraw its own allocation once the settle-before time is past (the token standard lets only the sender withdraw it, and
        the builder leaves it out from then). It may archive its own open DepositRequest once the allocation it names is gone or past that time. Neither can touch a deposit the builder can still settle."""
        if not isinstance(contract, str):
            raise HttpError(400, "an ExerciseCommand names its contract id")
        if wanted == TRANSFER_WITHDRAW:
            # The standard lets only the sender withdraw a transfer instruction, and a transfer waits for its receiver, not for the builder: so the account may withdraw any waiting transfer it sent, at any time
            # (a lapsed one included: that is the one it has to take back). It cannot withdraw an offer made to it (there it is the receiver), and the read is not capped (a flood of offers cannot hide its own).
            if not any(cid == contract and isinstance(v, dict) and (v.get("transfer") or {}).get("sender") == party for cid, v, _ in self.views(party, TRANSFER_INSTRUCTION, "transfers")):
                raise HttpError(404, "this account has no such transfer that it sent")
            return
        if wanted == REDEEM_ARCHIVE:
            # A redeem request locks nothing and its holder is its only signatory: the holder can already make its release fail by spending the holdings it names, and the builder reads only active requests.
            # So the account may remove any open request of its own, and nothing else.
            if not any(r["contractId"] == contract and (r["arguments"] or {}).get("holder") == party for r in self.open(party)["redeemRequests"]):
                raise HttpError(404, "this account has no such open redeem request")
            return
        allocations = {a["contractId"]: a for a in self.allocations(party)["allocations"]}
        if wanted == ALLOCATION_WITHDRAW:
            found = allocations.get(contract)
            if found is None:
                raise HttpError(404, "this account has no such allocation")
            if not self.passed(found):
                raise conflict("not_yet", "this allocation can be taken back once its settle-before time has passed")
            return
        request = next((r for r in self.open(party)["depositRequests"] if r["contractId"] == contract), None)
        if request is None:
            raise HttpError(404, "this account has no such open deposit request")
        named_id = (request["arguments"] or {}).get("allocation")
        named = allocations.get(named_id)
        if named is not None and not self.passed(named):
            raise conflict("not_yet", "this deposit request can be taken back once its allocation is gone or its settle-before time has passed")
        if named is None and isinstance(named_id, str) and not self.archived(party, named_id):
            # Missing from the account's list is not yet gone: the participant may not be able to compute that allocation's view while the builder can still settle it.
            raise conflict("not_yet", "this deposit request can be taken back once its allocation is gone or its settle-before time has passed")

    def archived(self, party: str, contract: str) -> bool:
        """Whether a contract is archived or unknown to the participant, by a look at its own events (not the account's view list). Anything else, an active contract included, is false."""
        flt = {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}
        try:
            found = self.ledger.call("POST", "/v2/events/events-by-contract-id", {"contractId": contract, "eventFormat": {"filtersByParty": {party: flt}, "verbose": False}})
        except HttpError as e:
            if e.status == 422 and "NOT_FOUND" in str(e.extra.get("code") or ""):
                return True
            raise
        return bool(found.get("archived"))

    def check_create(self, party: str, template: str, arguments) -> None:
        """A create names other parties as observers, and they see it and are sent it: so only the chain's own parties may be named, and the account itself (for a
        create with no open limit, the account alone). `label` and `ref` are short, and the whole of the arguments is small; contract ids and party ids are not capped."""
        if not isinstance(arguments, dict):
            raise HttpError(400, "a CreateCommand has createArguments")
        if len(json.dumps(arguments, separators=(",", ":"))) > MAX_ARGUMENTS:
            raise HttpError(400, f"the createArguments are longer than {MAX_ARGUMENTS} bytes")
        for field in CHAIN_FIELDS:
            if (template in CHAIN_CREATES or field in arguments) and (not self.chain.get(field) or arguments.get(field) != self.chain[field]):
                raise HttpError(403, f"{field} is not the chain's {field}")
        unlimited = self.open_limits.get(template, 1) is None   # a template that was set to `none` is one with no limit; one that was not set is not
        stack, allowed = [(arguments, False)], {party} if unlimited else {party, *self.chain.values()}
        while stack:
            value, free = stack.pop()
            if isinstance(value, dict):
                stack.extend((v, free or k in TEXT_FIELDS) for k, v in value.items())
            elif isinstance(value, list):
                stack.extend((v, free) for v in value)
            elif isinstance(value, str):
                if free and len(value) > MAX_TEXT:
                    raise HttpError(400, f"a label or ref in this create is longer than {MAX_TEXT} characters")
                if "::" in value and value not in allowed:
                    raise HttpError(403, "a party that is neither the account nor the chain's is named")

    def open_contracts(self, party: str, template: str) -> None:
        """An account holds few open contracts of a template that is limited: the account's own active contracts say how many."""
        limit = self.open_limits.get(template)
        if limit is None:
            return
        flt = {"cumulative": [{"identifierFilter": {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": False}}}}]}
        page = self.ledger.call("POST", "/v2/state/active-contracts-page", {"eventFormat": {"filtersByParty": {party: flt}, "verbose": False}, "maxPageSize": limit})
        if len(page.get("activeContracts") or []) + self.in_flight.count((party, template)) >= limit:   # an execute that got no answer may still commit
            if template.rpartition(":")[2].endswith("Acceptance"):   # a standing acceptance: the account has it already
                raise conflict("already_accepted", "this account already has this acceptance")
            raise conflict("too_many_open", f"this account has {limit} open already: only {limit} at a time")

    def prepare(self, body: dict, ip: str) -> dict:
        party = self.known(body.get("party"))
        commands = self.check_commands(party, body.get("commands"))
        self.prepared.room(pending_owner(ip), party)   # a client or an account at its cap costs the participant no prepare (a take-back's own check reads the account's contracts first, at the account's rate)
        request = {"commandId": str(uuid.uuid4()), "userId": self.user, "actAs": [party], "synchronizerId": self.sync_id(),
                   "commands": commands, "readAs": [], "packageIdSelectionPreference": [], "prefetchContractKeys": [],
                   "verboseHashing": False, "disclosedContracts": body.get("disclosedContracts", [])}   # the JSON API wants every list, though they are optional
        record_by = int(self.wall()) + PENDING_TTL + RECORD_MARGIN   # the participant records it by then or never: the wait for its signature plus a margin
        request["maxRecordTime"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(record_by))
        if not isinstance(request["disclosedContracts"], list):
            raise HttpError(400, "disclosedContracts is a list")
        template = commands[0]["CreateCommand"]["templateId"] if "CreateCommand" in commands[0] else None
        exercise = commands[0].get("ExerciseCommand")
        exempt = exercise is not None and exercise["templateId"] + "#" + exercise["choice"] in SHARED_EXEMPT   # a take-back or an accept: see `spend`
        limited = template is not None and self.open_limits.get(template) is not None
        # For a limited template the check, the prepare and the entry are one step per account: two prepares do not both see "none open".
        with self.account_lock(party) if limited else contextlib.nullcontext():
            if limited:
                if any(v["template"] == template for v in self.prepared.values(party)):
                    raise conflict("waiting_for_signature", "this account has a transaction of that kind waiting for its signature: execute it first (or wait for it to expire)")
                self.open_contracts(party, template)
            made = self.ledger.call("POST", "/v2/interactive-submission/prepare", request)
            tx, version = made["preparedTransaction"], made["hashingSchemeVersion"]
            cost = (made.get("costEstimation") or {}).get("totalTrafficCostEstimation")
            if not isinstance(cost, int) or isinstance(cost, bool):
                raise HttpError(502, "the ledger gave no estimate of the cost of this transaction")
            if cost > self.max_traffic:
                raise HttpError(403, f"this transaction would cost more than the {self.max_traffic} that this service allows one")
            self.prepared.put(hashlib.sha256(tx.encode()).hexdigest(), {"party": party, "version": version, "hash": base64.b64decode(made["preparedTransactionHash"]),
                                                                       "cost": cost, "template": template, "record_by": record_by, "exempt": exempt}, pending_owner(ip), party)
        return {"party": party, "preparedTransaction": tx, "preparedTransactionHash": made["preparedTransactionHash"], "hashingSchemeVersion": version, "maxRecordTime": request["maxRecordTime"]}

    def execute(self, body: dict, ip: str) -> dict:
        tx = text(body, "preparedTransaction", MAX_BODY)
        sigs = body.get("partySignatures")
        if not isinstance(sigs, list) or len(sigs) != 1 or not isinstance(sigs[0], dict):
            raise HttpError(400, "partySignatures holds one entry: the party and its signature")
        party, signature = self.known(sigs[0].get("party")), sigs[0].get("signature")
        raw_signature = b64(signature, "signature", (64,))
        key = hashlib.sha256(tx.encode()).hexdigest()
        found = self.prepared.get(key)   # only what this service prepared, for this party, is executed: the list of allowed commands holds
        if found is None or found["party"] != party:
            raise HttpError(404, "no such prepared transaction for this account, or it has expired: prepare it again")
        if not self.proves(self.parties.key(party), found["hash"], raw_signature, ip):   # a wrong signature costs the participant nothing
            raise HttpError(401, "the signature is not this account's signature of the transaction's hash")

        def take():   # the one attempt: the entry is gone before anything is sent, whatever comes of it
            taken = self.prepared.take(key)
            if taken is None:
                raise HttpError(404, "no such prepared transaction for this account, or it has expired: prepare it again")
            return taken

        limited = found["template"] is not None and self.open_limits.get(found["template"]) is not None
        # For a limited template the count of open contracts and the send are one step per account: it holds the lock until the ledger has committed.
        with self.account_lock(party) if limited else contextlib.nullcontext():
            if limited:
                self.open_contracts(party, found["template"])
            found = self.spend(ip, party, found["cost"], take=take, exempt=found.get("exempt", False))   # an over-budget execute leaves the entry in place and charges nothing
            try:
                done = self.ledger.call("POST", "/v2/interactive-submission/executeAndWait", {
                    "preparedTransaction": tx, "submissionId": str(uuid.uuid4()), "userId": self.user, "hashingSchemeVersion": found["version"],
                    "deduplicationPeriod": {"Empty": {}},
                    "partySignatures": {"signatures": [{"party": party, "signatures": [self.signature(signature, party.split("::")[1])]}]}})
            except HttpError as e:
                if limited and e.status == 502:   # no answer (a timeout, a 5xx): the transaction may commit later, so the next count includes it
                    self.in_flight.add((party, found["template"]), max(found["record_by"] - self.wall(), 0))   # open until it cannot be recorded any more
                raise
        return {"updateId": done["updateId"]}

    def active(self, party: str, identifier_filter: dict, what: str) -> list:
        """The created events of the party's active contracts that match the filter, all pages of one snapshot."""
        self.known(party)
        flt = {"cumulative": [{"identifierFilter": identifier_filter}]}
        request, out = {"eventFormat": {"filtersByParty": {party: flt}, "verbose": False}, "maxPageSize": HOLDINGS_PAGE}, []
        for _ in range(HOLDINGS_PAGES):
            page = self.ledger.call("POST", "/v2/state/active-contracts-page", request)
            out += [(entry.get("contractEntry") or {}).get("JsActiveContract", {}).get("createdEvent") or {} for entry in page.get("activeContracts") or []]
            if not page.get("nextPageToken"):
                return out
            request = {**request, "activeAtOffset": page["activeAtOffset"], "pageToken": page["nextPageToken"]}
        raise HttpError(500, f"the account has more {what} than this service lists")

    def views(self, party: str, interface: str, what: str) -> list:
        """(contract id, view, package name of the implementing template) of the party's contracts of an interface."""
        found = self.active(party, {"InterfaceFilter": {"value": {"interfaceId": interface, "includeInterfaceView": True, "includeCreatedEventBlob": False}}}, what)
        return [(e["contractId"], v.get("viewValue"), e.get("packageName")) for e in found for v in e.get("interfaceViews") or []]

    def holdings(self, party: str) -> dict:
        """The party's own CIP-0056 holdings (the Holding interface's view, owner = the party), all pages of one snapshot."""
        return {"party": party, "holdings": [{"contractId": cid, "instrumentId": v["instrumentId"], "amount": v["amount"], "locked": bool(v.get("lock"))}
                                             for cid, v, _ in self.views(party, HOLDING, "holdings") if isinstance(v, dict) and v.get("owner") == party]}   # a holding the party only observes is not its own

    def allocations(self, party: str) -> dict:
        """The party's own allocations (the Allocation interface's view, the party the sender of the leg): the contract id the participant committed, the specification and the holdings."""
        return {"party": party, "allocations": [{"contractId": cid, "allocation": v["allocation"], "holdingCids": v.get("holdingCids", [])} for cid, v, _ in self.views(party, ALLOCATION, "allocations")
                                                if isinstance(v, dict) and ((v.get("allocation") or {}).get("transferLeg") or {}).get("sender") == party]}

    def transfers(self, party: str) -> dict:
        """The transfers the party sends or is offered that are still waiting (the TransferInstruction interface's view, the party the sender or the receiver): the contract id and the transfer's
        sender, receiver, amount, instrument and deadline, with the registry's status as it is, and the package name of the template that implements the contract (the ledger's, not the view's: the view is computed by that template's code, so
        it cannot say what the contract is). The account's own sends come first, then the offers made to it, each newest first. At most `TRANSFERS_MAX`, so an account that strangers offer transfers to has a bounded list."""
        keep = ("sender", "receiver", "amount", "instrumentId", "requestedAt", "executeBefore")
        found = [{"contractId": cid, "transfer": {k: v["transfer"].get(k) for k in keep}, "status": v.get("status"), "packageName": package} for cid, v, package in self.views(party, TRANSFER_INSTRUCTION, "transfers")
                 if isinstance(v, dict) and isinstance(v.get("transfer"), dict) and party in (v["transfer"].get("sender"), v["transfer"].get("receiver"))]
        # The account's own sends come first, then the offers made to it, each newest first (a stable sort: ties keep the ledger's order), so a flood of offers cannot push its own sends out of the bounded list.
        found.sort(key=lambda t: str(t["transfer"].get("requestedAt") or ""), reverse=True)
        found.sort(key=lambda t: t["transfer"].get("sender") != party)
        return {"party": party, "transfers": found[:TRANSFERS_MAX], "more": len(found) > TRANSFERS_MAX}

    def open(self, party: str) -> dict:
        """The party's open DepositRequests and RedeemRequests (those the service allows it to create), by contract id, with their arguments; and its two standing acceptances,
        `twinAcceptance` and `withdrawalAcceptance`: {"contractId", "arguments"}, or null when it has none (or the service does not allow it to make one). Each template is read
        in pages of one snapshot (one offset for all its pages), bounded as every read is."""
        out = {"party": party, "depositRequests": [], "redeemRequests": [], "twinAcceptance": None, "withdrawalAcceptance": None}
        for template, key, owner, many in ((DEPOSIT, "depositRequests", "depositor", True), (REDEEM, "redeemRequests", "holder", True),
                                           (TWIN_ACCEPTANCE, "twinAcceptance", "party", False), (ACCEPTANCE, "withdrawalAcceptance", "party", False)):
            if template in self.allow:
                found = self.active(party, {"TemplateFilter": {"value": {"templateId": template, "includeCreatedEventBlob": False}}}, "open requests")
                mine = [{"contractId": e["contractId"], "arguments": e["createArgument"]} for e in found if (e.get("createArgument") or {}).get(owner) == party]
                out[key] = mine if many else mine[0] if mine else None
        return out


def open_limits_from(allow, deposit_requests: int, given) -> dict:
    """The open limits: the built-in two, and `--open-limit Template=N` (N is a number, or `none` for a create that names no one). SystemExit when an allowed create
    has none: a create names observers, and an account must not be able to make them without end."""
    limits = {ACCEPTANCE: 1, DEPOSIT: deposit_requests}
    for entry in given or []:
        template, _, n = entry.rpartition("=")
        if template not in allow or template.count("#") != 1 or not (n == "none" or n.isdigit() and int(n) >= 1):
            sys.exit(f"--open-limit {entry!r}: Template=N (N from 1, or none) for a template that is an allowed create")
        limits[template] = None if n == "none" else int(n)
    unlimited = [e for e in allow if e.count("#") == 1 and e not in limits]
    if unlimited:
        sys.exit("an allowed create has no open limit: " + ", ".join(unlimited) + " (give --open-limit Template=N, or Template=none for one that names no other party)")
    return limits


def make_server(service: Accounts, host: str, port: int, ip_header: str = None, proxies: int = 1, trusted=TRUSTED_ADDRESSES) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        timeout = 20

        def serve(self, method: str):
            headers = {}
            try:
                body, raw = None, b""
                if method == "POST":
                    try:
                        length = int(self.headers.get("content-length") or 0)
                    except ValueError:
                        length = -1
                    if not 0 <= length <= MAX_BODY:
                        raise HttpError(400, f"the body must be at most {MAX_BODY} bytes")
                    raw = self.rfile.read(length)
                    try:
                        body = json.loads(raw or b"null")
                    except ValueError:
                        raise HttpError(400, "the body is not JSON")
                # Behind reverse proxies the client is the entry that the nearest trusted proxy wrote: the `proxies`-th from the right, and only from a trusted peer.
                ip = client_address(self.client_address[0], ",".join(self.headers.get_all(ip_header, [])) if ip_header else "", proxies, trusted)
                status, out = 200, service.handle(method, urllib.parse.urlsplit(self.path).path, body, ip, raw, self.headers.get("X-Account-Signature"))
            except HttpError as e:
                status, out = e.status, {**({"error": e.stable, "message": e.message} if e.stable else {"error": e.message}), **{k: v for k, v in e.extra.items() if v is not None and k != "retryAfter"}}
                if "retryAfter" in e.extra:
                    headers["retry-after"] = str(e.extra["retryAfter"])
            except Exception as e:
                print(f"{method} {self.path}: {type(e).__name__}: {e}", file=sys.stderr)
                status, out = 500, {"error": "the service could not do that"}
            data = json.dumps(out).encode()
            self.send_response(status)
            for k, v in {"content-type": "application/json", "content-length": str(len(data)), **headers}.items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self): self.serve("GET")
        def do_POST(self): self.serve("POST")
        def log_message(self, *args): pass

    return ThreadingHTTPServer((host, port), Handler)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    p.add_argument("--ledger-url", required=True)
    p.add_argument("--user-id", required=True, help="the Ledger API user of the token: it gets the right to act as each account it makes")
    p.add_argument("--state-file", required=True, help="where the accounts made are kept across restarts")
    p.add_argument("--token-file", help="a file with the token, read again for each call; the environment variable LEDGER_TOKEN is used when it is not given")
    p.add_argument("--listen", default="127.0.0.1:8081")
    p.add_argument("--synchronizer-id", help="the synchronizer to make accounts on; by default the one the participant is connected to")
    p.add_argument("--topology-protocol-version", type=int, help="ask for topology transactions of this protocol version; by default the synchronizer's own")
    p.add_argument("--party-hint", default="rome", help="the name every account is given before its key's fingerprint (the page's VITE_PARTY_HINT must be the same)")
    p.add_argument("--allow", action="append", help="an allowed command: #package:Module:Entity (a create) or #package:Module:Entity#Choice (an exercise); repeat; replaces the built-in list")
    p.add_argument("--open-limit", action="append", metavar="TEMPLATE=N", help="open contracts one account may have of an allowed create (#package:Module:Entity=N, or =none for one "
                   "that names no other party); every allowed create needs one; repeat")
    p.add_argument("--accounts-per-day", type=int, default=3, help="accounts made per client address (an IPv4 address or an IPv6 /64) in 24 hours")
    p.add_argument("--accounts-per-network-day", type=int, default=NEW_ACCOUNTS_PER_NETWORK, help="accounts made per client network (an IPv4 address or an IPv6 /48) in 24 hours")
    p.add_argument("--requests-per-minute", type=int, default=60, help="requests per client address in a minute")
    p.add_argument("--requests-per-account-minute", type=int, default=ACCOUNT_RATE, help="prepare, execute, holdings, allocations, transfers and open requests per account in a minute")
    p.add_argument("--public-registry-requests-per-minute", type=int, default=PUBLIC_RELAY_RATE, help="public registry relay requests (for wallets this service did not make) per client in a minute")
    p.add_argument("--public-registry-requests-per-minute-total", type=int, default=PUBLIC_RELAY_TOTAL, help="public registry relay requests from all clients together in a minute")
    p.add_argument("--public-registry-requests-per-minute-network", type=int, default=PUBLIC_RELAY_NETWORK, help="public registry relay requests per client network (an IPv4 address or an IPv6 /48) in a minute")
    p.add_argument("--requests-per-network-minute", type=int, default=NETWORK_RATE, help="requests per client network (an IPv4 address, an IPv6 /48) in a minute")
    p.add_argument("--chain-parties", help="a JSON file {\"operator\": ..., \"confirmer\": ..., \"gateway\": ..., \"builder\": ...}: the chain's parties, the only observers a create may name")
    for field in CHAIN_FIELDS:
        p.add_argument(f"--chain-{field}", help=f"the chain's {field} party (overrides the file)")
    p.add_argument("--open-deposit-requests", type=int, default=3, help="open DepositRequests one account may have (it may have one WithdrawalAcceptance)")
    p.add_argument("--executes-per-account-day", type=int, default=50, help="executes per account in 24 hours")
    p.add_argument("--executes-per-client-day", type=int, default=200, help="executes and allocations per client address (an IPv4 address or an IPv6 /64) in 24 hours")
    p.add_argument("--executes-per-network-day", type=int, default=EXECUTES_PER_NETWORK, help="executes and allocations per client network (an IPv4 address or an IPv6 /48) in 24 hours")
    p.add_argument("--take-backs-per-day", type=int, default=TAKE_BACKS_PER_DAY, help="take-backs and accepts (they are not counted in --executes-per-day or --traffic-per-day) in 24 hours, all clients together")
    p.add_argument("--take-back-traffic-per-day", type=int, default=TAKE_BACK_TRAFFIC_PER_DAY, help="the traffic of the take-backs and accepts in 24 hours, all clients together (bytes, as estimated; apart from --traffic-per-day)")
    p.add_argument("--executes-per-day", type=int, default=2000, help="executes and allocations in 24 hours, all clients together")
    p.add_argument("--max-transaction-traffic", type=int, default=200000, help="the most traffic the participant may estimate for one transaction (bytes)")
    p.add_argument("--traffic-per-day", type=int, default=50_000_000, help="the traffic of the executes in 24 hours, all clients together (bytes, as estimated)")
    p.add_argument("--max-pending-topologies", type=int, default=2000, help="topologies waiting for a signature")
    p.add_argument("--max-pending-prepared", type=int, default=5000, help="prepared transactions waiting for a signature")
    p.add_argument("--max-pending-per-client", type=int, default=10, help="topologies, and prepared transactions, waiting for a signature for one client address (an IPv6 /48) (each)")
    p.add_argument("--max-pending-per-account", type=int, default=PENDING_PER_ACCOUNT, help="prepared transactions waiting for a signature for one account")
    p.add_argument("--accounts-per-day-total", type=int, default=200, help="new accounts in 24 hours, all clients together (set it to what real use needs: the participant's cap on accounts is finite)")
    p.add_argument("--account-cap", type=int, default=ACCOUNT_CAP, help="the participant's cap on the accounts of this service's user (its max-self-allocated-parties): /healthz reports the accounts held against it")
    p.add_argument("--human-check-url", help="the verify URL of a human check (Cloudflare Turnstile: https://challenges.cloudflare.com/turnstile/v0/siteverify); with --human-check-secret-file it turns on the check of `topology`; off when not given")
    p.add_argument("--human-check-secret-file", help="the human check's secret: a file with mode 0600, read again for each check")
    p.add_argument("--registry", action="append", metavar="ADMIN=URL", help="the token registry of an instrument admin (https, or a server on this machine): its allocation factory and accept choice contexts "
                   "are relayed to the accounts; the root of its token standard API, for Canton Coin the validator's scan proxy; repeat")
    p.add_argument("--registry-token-file", action="append", metavar="ADMIN=FILE", help="the file with the bearer token that registry wants, read again for each request; repeat. The relay is open to anyone, so this is a token of a user with no admin right, never the one of --faucet-token-file (the service refuses to start when they are the same)")
    p.add_argument("--faucet-amount", help="DevNet ONLY: Canton Coin that the validator's party sends an account when it asks (once a day each); off when not given")
    p.add_argument("--faucet-url", help="the validator's API root for the faucet (https, or a server on this machine), such as https://validator/api/validator")
    p.add_argument("--faucet-token-file", help="the validator's admin-level token for the faucet: a file with mode 0600, read again for each grant")
    p.add_argument("--faucet-per-day", type=int, default=200, help="faucet grants in 24 hours, all accounts together")
    p.add_argument("--client-ip-header", help="the header in which the reverse proxy puts the client's address, such as X-Forwarded-For")
    p.add_argument("--trusted-proxies", type=int, default=1, help="proxies in front of the service: the client's address is this many entries from the right of --client-ip-header")
    p.add_argument("--trusted-proxy-addresses", default="127.0.0.1,::1", help="comma-separated addresses or networks of the proxies; the header is read only from a peer among them")
    a = p.parse_args(argv)
    token = "" if a.token_file else os.environ.get("LEDGER_TOKEN", "")
    if not (token or a.token_file):
        sys.exit("a token is required: LEDGER_TOKEN or --token-file")
    allow = a.allow or list(DEFAULT_ALLOW)
    if not HINT.match(a.party_hint) or not all(ALLOW_ENTRY.match(e) for e in allow):
        sys.exit("a party hint is letters, digits, - and _; an allowed command is #package:Module:Entity or #package:Module:Entity#Choice")
    open_limits = open_limits_from(allow, a.open_deposit_requests, a.open_limit)
    chain = {}
    if a.chain_parties:
        with open(a.chain_parties) as f:
            chain = json.load(f)
    chain = {f: getattr(a, f"chain_{f}") or chain.get(f) for f in CHAIN_FIELDS}
    if not all(PARTY.match(v or "") for v in chain.values()):
        print("the chain's parties are not all set: creates that name them are refused", file=sys.stderr)
        chain = {}
    try:
        trusted = [ipaddress.ip_network(x.strip(), strict=False) for x in a.trusted_proxy_addresses.split(",") if x.strip()]
    except ValueError as e:
        sys.exit(f"--trusted-proxy-addresses: {e}")
    if a.trusted_proxies < 1:
        sys.exit("--trusted-proxies is at least 1")
    registries = parse_registries(a.registry, a.registry_token_file)
    faucet = faucet_from(a.faucet_amount, a.faucet_url, a.faucet_token_file, a.faucet_per_day)
    keep_relay_token_apart(registries, faucet.bearer_file if faucet else None)
    if bool(a.human_check_url) != bool(a.human_check_secret_file):
        sys.exit("--human-check-url and --human-check-secret-file go together")
    if a.account_cap < 1:
        sys.exit("--account-cap is at least 1")
    human_check = HumanCheck(a.human_check_url, a.human_check_secret_file) if a.human_check_url else None
    host, _, port = a.listen.rpartition(":")
    service = Accounts(Ledger(a.ledger_url, a.token_file, token), a.user_id, Parties(a.state_file), allow, a.party_hint, a.synchronizer_id, a.topology_protocol_version,
                       day_limit(a.accounts_per_day, NETWORK_ACCOUNTS), Limiter(a.requests_per_minute, 60), Pending(limit=a.max_pending_topologies, per_owner=a.max_pending_per_client),
                       Pending(limit=a.max_pending_prepared, per_owner=a.max_pending_per_client, per_group=a.max_pending_per_account), chain, open_limits,
                       day_limit(a.executes_per_account_day, ACCOUNT_SENDS), day_limit(a.executes_per_client_day, NETWORK_SENDS), day_limit(a.executes_per_day, ALL_SENDS),
                       day_limit(a.traffic_per_day, ALL_SENDS), a.max_transaction_traffic, day_limit(a.accounts_per_day_total, ALL_ACCOUNTS),
                       account_rate=Limiter(a.requests_per_account_minute, 60), network_rate=Limiter(a.requests_per_network_minute, 60), public_relay_rate=Limiter(a.public_registry_requests_per_minute, 60), public_relay_total=Limiter(a.public_registry_requests_per_minute_total, 60), registries=registries, faucet=faucet,
                       creates_net=day_limit(a.accounts_per_network_day, NETWORK_ACCOUNTS), per_net=day_limit(a.executes_per_network_day, NETWORK_SENDS), take_backs=day_limit(a.take_backs_per_day, TAKE_BACKS_ALL), take_back_traffic=day_limit(a.take_back_traffic_per_day, TAKE_BACKS_ALL),
                       public_relay_net=Limiter(a.public_registry_requests_per_minute_network, 60), account_cap=a.account_cap, human_check=human_check)
    try:
        service.load_rights(force=True)
    except HttpError as e:
        print(f"the ledger user's rights could not be read now ({e.message}); they are read again when an account is missed", file=sys.stderr)
    if ed25519.Ed25519PublicKey is None:
        print(SLOW_VERIFY_WARNING, file=sys.stderr)
    service.start_sweeper()
    make_server(service, host or "127.0.0.1", int(port), a.client_ip_header, a.trusted_proxies, trusted).serve_forever()


if __name__ == "__main__":
    main()
