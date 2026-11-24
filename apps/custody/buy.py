"""The custody worker's buy mode: Canton Coin in, tROME out. Run by intake.py with --buy (off by default). See README.md ("The paid path").

Every poll it reads the pending Canton Coin transfers to Rome's validator party. A transfer that passes every check is accepted (`TransferInstruction_Accept`, with the
registry's choice context, as the intake accepts) and the buyer is sent floor(amount / price) tROME from the buy key, straight to reth. A transfer that fails a check is left
pending, never rejected: it goes back to its sender at its own deadline. The journal (buy.json in the work folder) keeps each accepted transfer with its signed send, so a restart
sends nothing twice and a send that reth does not hold is sent again, the same bytes. The status file (buy-status.json) says the price, the least buy, the party and whether the stock is open or sold out.
"""
import fcntl, hashlib, os, stat, sys, time
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import intake as it
import evm, limits, memo as memos, payout
b = it.b

JOURNAL, STATUS, LOCK = "buy.json", "buy-status.json", "buy.lock"
COIN = "Amulet"   # the instrument id of Canton Coin; the admin is the one whose registry is given with --registry
WEI = 10**18
ACCEPT = "TransferInstruction_Accept"
KEEP_DONE_SECONDS = 30 * 86400   # a settled buy stays in the journal this long
MAX_SEND_GAS = 100_000   # a send that needs more gas than this (a recipient whose code does real work) is left pending
GAS_HEADROOM = Fraction(6, 5)   # the gas limit is the estimate with this much room


class Journal(payout.Journal):
    """The payouts' journal, but a change reaches memory only once it is on disk: a write that fails leaves the entry as the disk has it, so nothing is ever sent from a state a restart cannot see."""

    def keep(self, key: str, **fields) -> dict:
        entry = self.entries.get(key, {})
        if key in self.entries and all(entry.get(k) == v for k, v in fields.items()):
            return entry
        new = {**entry, **fields}
        b.write_json_file(self.path, {**self.entries, key: new})
        self.entries[key] = new
        return new

    def drop(self, key: str) -> None:
        b.write_json_file(self.path, {k: v for k, v in self.entries.items() if k != key})
        del self.entries[key]

    def forget(self, kept: set) -> None:
        left = {k: v for k, v in self.entries.items() if k in kept}
        if len(left) != len(self.entries):
            b.write_json_file(self.path, left)
            self.entries = left


def take_lock(work_dir: str):
    """The one buy worker of a work folder: an exclusive lock on buy.lock there, held while the process lives. Two workers would each sign their own nonce for one accepted transfer."""
    path = Path(work_dir) / LOCK
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise SystemExit("another buy worker already runs on this work folder") from None
    return handle


class Chain:
    """What reth says at the start of a poll, and the nonce the next send takes."""

    def __init__(self, chain_id: int, nonce: int, max_fee: int, tip: int):
        self.chain_id, self.nonce, self.max_fee, self.tip = chain_id, nonce, max_fee, tip

    def cost(self, gas: int = evm.TRANSFER_GAS) -> int:
        """The most a send of this gas limit can cost in gas, in wei."""
        return gas * self.max_fee


def read_key(path: str) -> bytes:
    """The buy key from its file: 64 hex digits (0x allowed), and the file must be readable by its owner only. The key is never printed."""
    try:
        mode = os.stat(path).st_mode
        text = Path(path).read_text().strip()
    except OSError as e:
        raise SystemExit(f"--buy-key-file cannot be read ({type(e).__name__})") from None
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise SystemExit("--buy-key-file must be readable by its owner only (mode 0600)")
    try:
        key = bytes.fromhex(text[2:] if text[:2] in ("0x", "0X") else text)
        evm.address_of(key)
    except ValueError:
        raise SystemExit("--buy-key-file must hold one private key: 64 hex digits") from None
    return key


def meta_bytes(values: dict) -> int:
    """The size of a transfer's meta: the UTF-8 bytes of every key and value."""
    return sum(len(str(k).encode()) + len(v.encode() if isinstance(v, str) else repr(v).encode()) for k, v in values.items())


class Buy:
    def __init__(self, ledger: "b.Ledger", settings: it.Settings, reth, key: bytes, price: Fraction, min_buy: Fraction, work_dir: str, max_meta: int = 0, clock=time.time, contexts=it.Contexts):
        """`price` is the Canton Coin that one tROME costs, `min_buy` the least amount accepted (Canton Coin), `max_meta` the most bytes of a transfer's meta (0: no cap); `reth` is an `evm.Reth`."""
        self.ledger, self.settings, self.reth, self.key, self.clock, self.contexts = ledger, settings, reth, key, clock, contexts
        self.price, self.min_buy, self.max_meta = price, min_buy, max_meta
        self.address = evm.address_of(key)
        self.dir = Path(work_dir)
        self.journal = Journal(self.dir / JOURNAL)
        self.intake = it.Intake(ledger, settings)
        self.told: set = set()   # (instruction, why) of what was already reported
        self.chain_id = None
        self.lock = None

    @classmethod
    def from_args(cls, args, ledger: "b.Ledger", settings: it.Settings) -> "Buy":
        lock = take_lock(args.work_dir)   # before the journal is read
        try:
            worker = cls(ledger, settings, evm.Reth(args.reth_rpc), read_key(args.buy_key_file), buy_price(args), buy_least(args), args.work_dir, args.max_meta_bytes)
        except BaseException:
            lock.close()
            raise
        worker.lock = lock
        return worker

    def close(self) -> None:
        """Lets go of the work folder's lock."""
        if self.lock is not None:
            self.lock.close()
            self.lock = None

    def describe(self) -> dict:
        """The settings, said once at the start (never the key)."""
        return {"price": limits.amount_text(self.price), "minBuy": limits.amount_text(self.min_buy), "party": self.settings.gateway, "maxMetaBytes": self.max_meta, "sendFrom": "0x" + self.address}

    def wei_for(self, amount: Fraction) -> int:
        """The tROME, in wei, that this much Canton Coin buys, rounded down."""
        return int(amount * WEI / self.price)

    # ---- what a transfer must be

    def check(self, cid: str, transfer: dict) -> tuple:
        """(the recipient's 40 hex digits, the wei to send) of a transfer that may be accepted. A memos.Unreadable with the reason when it must be left pending."""
        instrument = transfer["instrumentId"]
        if instrument.get("id") != COIN or instrument.get("admin") not in self.settings.registries:
            raise memos.Unreadable("the instrument is not Canton Coin")
        amount = b.base_units(transfer["amount"])
        if amount is None:
            raise memos.Unreadable("the amount is not a Canton amount")
        values = ((transfer.get("meta") or {}).get("values")) or {}
        text = values.get(memos.REASON_KEY)
        if not isinstance(text, str) or not text.strip():
            raise memos.Unreadable("the transfer has no memo")
        recipient = memos.address_of(text.strip())
        if self.max_meta and meta_bytes(values) > self.max_meta:
            raise memos.Unreadable("the transfer's meta is larger than the cap")
        coins = Fraction(amount, b.UNIT)
        if coins < self.min_buy:
            raise memos.Unreadable("the amount is below the least buy")
        wei = self.wei_for(coins)
        if wei < 1:
            raise memos.Unreadable("the amount buys no tROME")
        return recipient, wei

    def estimate(self, recipient: str, wei: int) -> int:
        """The gas limit of the send to this recipient: reth's estimate for the transfer (a recipient whose code runs needs more than a plain transfer's), with room. A memos.Unreadable when reth says the transfer fails or it needs more than MAX_SEND_GAS."""
        try:
            need = self.reth.estimate_gas(self.address, recipient, wei)
        except evm.RpcError:
            raise memos.Unreadable("the transfer to this address would fail") from None
        gas = evm.TRANSFER_GAS if need <= evm.TRANSFER_GAS else int(need * GAS_HEADROOM)   # a plain transfer needs exactly 21000
        if gas > MAX_SEND_GAS:
            raise memos.Unreadable("the transfer to this address needs more gas than the worker sends")
        return gas

    # ---- reth

    def read_chain(self) -> Chain:
        if self.chain_id is None:
            self.chain_id = self.reth.chain_id()
        price = self.reth.gas_price()
        max_fee = 2 * price
        return Chain(self.chain_id, self.reth.next_nonce(self.address), max_fee, min(self.reth.tip(), max_fee))

    def owed(self, chain: Chain, waiting: dict) -> int:
        """The wei, gas included, that the buys not yet settled still take from the buy key (a buy whose accept is still to be made is counted when it is taken)."""
        return sum(int(e["wei"]) + chain.cost(int(e.get("gas", evm.TRANSFER_GAS))) for c, e in self.journal.entries.items() if e["state"] in ("accepted", "sent") or (e["state"] == "accepting" and c not in waiting))

    def say_once(self, cid: str, why: str) -> None:
        why = b.bounded_text(why)
        if (cid, why) not in self.told:
            self.told.add((cid, why))
            it.say({"pending": cid, "why": why})

    # ---- one pass

    def poll(self) -> list:
        """One round: finishes what the journal holds, then takes the new transfers. Returns the lines of the accepts (each also printed as JSON)."""
        waiting = dict(self.intake.waiting())
        self.told = {k for k in self.told if k[0] in waiting}
        chain, accepted = self.read_chain(), []
        for cid in sorted(self.journal.entries, key=lambda c: (self.journal.entries[c].get("nonce", 1 << 64), self.journal.entries[c]["at"], c)):
            try:
                self.finish(cid, self.journal.entries[cid], waiting, chain)
            except Exception as e:   # one buy's failure never stops the others
                self.say_once(cid, str(e) if isinstance(e, (RuntimeError, memos.Unreadable)) else f"{type(e).__name__}: {e}")
        available = self.reth.balance(self.address) - self.owed(chain, waiting)
        contexts = self.contexts(self.settings.registries, self.settings.registry_tokens)
        for cid, transfer in sorted(waiting.items()):
            entry = self.journal.entries.get(cid)
            if entry is not None and entry["state"] != "accepting":
                continue
            try:
                recipient, wei = self.check(cid, transfer)
                if available < wei + chain.cost():
                    raise memos.Unreadable("the buy key holds too little tROME for this amount")
                gas = self.estimate(recipient, wei)
                if available < wei + chain.cost(gas):
                    raise memos.Unreadable("the buy key holds too little tROME for this amount")
                line = self.accept(cid, transfer, recipient, wei, gas, contexts)
            except Exception as e:   # a bad memo, a registry that does not answer, an accept that did not complete: left pending, tried again at the next poll
                self.say_once(cid, str(e) if isinstance(e, (memos.Unreadable, RuntimeError)) else f"{type(e).__name__}: {e}")
                continue
            accepted.append(line)
            available -= wei + chain.cost(gas)
            try:
                self.finish(cid, self.journal.entries[cid], waiting, chain)
            except Exception as e:   # the send is in the journal when it was signed: the next poll sends it again
                self.say_once(cid, str(e) if isinstance(e, RuntimeError) else f"{type(e).__name__}: {e}")
        self.journal.forget({c for c, e in self.journal.entries.items() if not (e["state"] == "done" and self.clock() - e["at"] > KEEP_DONE_SECONDS)})
        self.publish(available, chain)
        return accepted

    def command_of(self, cid: str, n: int) -> str:
        """The command id of the n-th try to accept this transfer: each try its own, so the completion of one never stands for another."""
        return "buy-" + hashlib.sha256(f"{cid}:{n}".encode()).hexdigest()[:32]

    def settle(self, entry: dict) -> tuple:
        """What became of the last try of an accept: ("committed", its completion), ("failed", None) (Canton failed it, or no completion came and Canton's own time is past the last moment it could commit), or ("open", None)."""
        found, reached = self.ledger.completion_and_time(entry["command"], entry["begin"])
        if found and found["committed"]:
            return "committed", found
        if found or (reached is not None and entry["at"] + self.ledger.cfg.resolve_seconds <= reached <= self.clock() + b.SKEW_SECONDS):
            return "failed", None
        return "open", None

    def accepted(self, cid: str, entry: dict, update) -> dict:
        self.journal.keep(cid, state="accepted", update=update)
        line = {"accepted": cid, "amount": entry["amount"], "sender": entry["sender"], "recipient": entry["to"], "wei": entry["wei"], "updateId": update}
        it.say(line)
        return line

    def accept(self, cid: str, transfer: dict, recipient: str, wei: int, gas: int, contexts) -> dict:
        """The validator party accepts the transfer, with the registry's accept context. The journal says "accepting" first, with the command id and the ledger end, so a stop between the accept and its record is settled by the command's completion.
        A transfer that is still pending with a try on record is tried again only once that try is settled as failed: a try that may still commit is waited for, never raced."""
        admin = transfer["instrumentId"]["admin"]
        context, disclosed = contexts.accept(admin, cid)
        entry = self.journal.entries.get(cid)
        if entry is None:
            entry = self.journal.keep(cid, state="accepting", n=1, command=self.command_of(cid, 1), begin=self.ledger.end(), at=self.clock(), to=recipient, amount=transfer["amount"], sender=transfer["sender"], wei=str(wei), gas=gas)
        else:
            outcome, found = self.settle(entry)
            if outcome == "committed":
                return self.accepted(cid, entry, found["updateId"])
            if outcome == "open":
                raise memos.Unreadable("the last try to accept it is not settled yet")
            n = entry["n"] + 1
            entry = self.journal.keep(cid, n=n, command=self.command_of(cid, n), begin=self.ledger.end(), at=self.clock(), to=recipient, wei=str(wei), gas=gas)
        answer = it.submit(self.ledger, self.settings.gateway, {"ExerciseCommand": {"templateId": it.TRANSFER_INSTRUCTION, "contractId": cid, "choice": ACCEPT,
                           "choiceArgument": {"extraArgs": {"context": context or it.EMPTY_CONTEXT, "meta": {"values": {}}}}}}, disclosed, entry["command"])
        return self.accepted(cid, entry, answer.get("updateId"))

    def finish(self, cid: str, entry: dict, waiting: dict, chain: Chain) -> None:
        """What a journal entry needs next: its accept settled, its send signed, its send seen on Ostia."""
        state = entry["state"]
        if state == "accepting":
            if cid in waiting:   # not accepted yet: the new transfers' pass takes it again
                return
            outcome, found = self.settle(entry)
            if outcome == "committed":
                self.accepted(cid, entry, found["updateId"])
            elif outcome == "failed":
                self.journal.drop(cid)   # the last try did not commit, and the transfer is gone (its sender took it back): nothing is owed
                it.say({"dropped": cid, "why": "the accept did not commit and the transfer is gone"})
                return
            else:
                return
            entry = self.journal.entries[cid]
            state = entry["state"]
        if state == "accepted":   # accepted, not signed yet: the nonce, then the bytes on disk, then the send
            nonce = max(chain.nonce, 1 + max((e["nonce"] for e in self.journal.entries.values() if "nonce" in e), default=-1))
            gas = int(entry.get("gas", evm.TRANSFER_GAS))
            raw = evm.transfer(self.key, chain.chain_id, nonce, entry["to"], int(entry["wei"]), chain.max_fee, chain.tip, gas)
            self.journal.keep(cid, state="sent", nonce=nonce, raw=raw.hex(), hash="0x" + evm.keccak256(raw).hex())
            chain.nonce = nonce + 1
            entry = self.journal.entries[cid]
            self.send(cid, entry, first=True)
        elif state == "sent":
            receipt = self.reth.receipt(entry["hash"])
            if receipt is not None:
                self.journal.keep(cid, state="done", at=self.clock())
                it.say({"settled": cid, "hash": entry["hash"], "block": receipt.get("blockNumber"), "success": receipt.get("status") == "0x1"})
            elif not self.reth.known(entry["hash"]):
                self.send(cid, entry, first=False)

    def send(self, cid: str, entry: dict, first: bool) -> None:
        """The journaled bytes to reth. The same bytes each time, so reth holds the send once whatever happens in between."""
        try:
            self.reth.send(bytes.fromhex(entry["raw"]))
        except evm.RpcError as e:
            if "already known" not in e.message.lower():
                raise
        it.say({"sent" if first else "sentAgain": cid, "hash": entry["hash"], "nonce": entry["nonce"], "recipient": entry["to"], "wei": entry["wei"]})

    def publish(self, available: int, chain: Chain) -> None:
        """buy-status.json: the price, the least buy, the party, and whether the stock still covers the least buy (open) or not (sold out). A write that fails is said and never stops the worker."""
        least = max(self.wei_for(self.min_buy), 1) + chain.cost()
        doc = {"version": 1, "updatedAt": datetime.fromtimestamp(self.clock(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "price": limits.amount_text(self.price),
               "minBuy": limits.amount_text(self.min_buy), "party": self.settings.gateway, "state": "open" if available >= least else "sold out"}
        try:
            b.write_json_file(self.dir / STATUS, doc)
        except OSError as e:
            it.say({"error": b.bounded_text(f"the status file cannot be written ({type(e).__name__})")})


def positive_decimal(text: str, flag: str, zero: bool = False) -> Fraction:
    try:
        value = b.decimal(text)
    except ValueError:
        value = None
    if value is None or value < 0 or (value == 0 and not zero):
        raise SystemExit(f"{flag} must be a {'number' if zero else 'positive number'} of Canton Coin as plain decimal text, not {str(text)[:40]!r}")
    return value


def buy_price(args) -> Fraction:
    return positive_decimal(args.price, "--price")


def buy_least(args) -> Fraction:
    return positive_decimal(args.min_buy, "--min-buy", zero=True)


def check_args(args) -> None:
    """The settings the buy mode needs. It is its own process: the intake and the payouts need their own user and party."""
    if args.intake or args.payout_offers:
        raise SystemExit("--buy runs on its own: not with --intake or --payout-offers (it acts as the validator party, they as the gateway)")
    for flag, value in (("--validator-party", args.validator_party), ("--ledger-user", args.ledger_user), ("--price", args.price), ("--min-buy", args.min_buy),
                        ("--buy-key-file", args.buy_key_file), ("--reth-rpc", args.reth_rpc), ("--work-dir", args.work_dir)):
        if not value:
            raise SystemExit(f"--buy needs {flag}")
    if not b.canton_party_text(args.validator_party):
        raise SystemExit("--validator-party must be a party id")
    if args.max_meta_bytes < 0:
        raise SystemExit("--max-meta-bytes must be zero (no cap) or more")
    buy_price(args), buy_least(args)


def settings_of(args) -> it.Settings:
    """The registries as the intake takes them; the party is the validator party. Canton Coin is the instrument of an admin that has a registry."""
    registries = b.parse_registries(args.registry)
    if not registries:
        raise SystemExit("--buy needs --registry for Canton Coin's admin: the accept's choice context comes from it")
    return it.Settings(args.validator_party, registries, b.read_registry_tokens(args.registry_token_file, registries))
