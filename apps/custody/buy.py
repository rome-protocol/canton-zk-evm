"""The custody worker's buy mode: Canton Coin in, tROME out. Run by intake.py with --buy (off by default). See README.md ("The paid path").

Every poll it reads the pending Canton Coin transfers to Rome's validator party. A transfer that passes every check is accepted (`TransferInstruction_Accept`, with the
registry's choice context, as the intake accepts) and the buyer is sent floor(amount / price) tROME from the buy key, straight to reth. A transfer that fails a check is left
pending, never rejected: it goes back to its sender at its own deadline. The journal (buy.json in the work folder) keeps each accepted transfer with its signed send, so a restart
sends nothing twice and a send that reth does not hold is sent again, the same bytes; a send that is not mined in time is replaced, with the same nonce and higher fees, and the buy is paid when any of its sends is mined. The status file (buy-status.json) says the price, the least buy, the party and whether the stock is open or sold out.
"""
import fcntl, hashlib, os, stat, sys, time
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path
from typing import NamedTuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import intake as it
import evm, limits, memo as memos, payout
b = it.b

JOURNAL, STATUS, LOCK = "buy.json", "buy-status.json", "buy.lock"
COIN = "Amulet"   # the instrument id of Canton Coin; the admin is the one whose registry is given with --registry (exactly one)
WEI = 10**18
ACCEPT = "TransferInstruction_Accept"
KEEP_DONE_SECONDS = 30 * 86400   # a settled buy stays in the journal this long
MIN_BUMP_PERCENT = 10   # what reth's pool (EIP-1559) takes at least, in max fee and in tip, to replace a transaction of the same nonce


class Sending(NamedTuple):
    """How the worker sends: the worker's settings (--send-gas-cap, --send-gas-headroom, --send-stuck-seconds, --send-fee-bump-percent, --send-fee-cap), these are their defaults."""
    gas_cap: int = 100_000   # a send whose gas limit is over this (a recipient whose code does real work) is left pending
    gas_headroom: Fraction = Fraction(6, 5)   # the gas limit is the estimate times this (21000 for a plain transfer)
    stuck_seconds: int = 60   # a send not mined after this long is replaced
    bump_percent: int = 12   # a replacement's max fee and tip are this much more than the send's (at least MIN_BUMP_PERCENT)
    fee_cap: int = 10**18   # the most a send's gas limit times its max fee may be, in wei (reth's own per-transaction cap, 1 tROME)


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
    def __init__(self, ledger: "b.Ledger", settings: it.Settings, reth, key: bytes, price: Fraction, min_buy: Fraction, work_dir: str, max_meta: int = 0, clock=time.time, contexts=it.Contexts, sending: Sending = Sending()):
        """`price` is the Canton Coin that one tROME costs, `min_buy` the least amount accepted (Canton Coin), `max_meta` the most bytes of a transfer's meta (0: no cap), `sending` how the sends are made; `reth` is an `evm.Reth`."""
        if len(settings.registries) != 1:
            raise SystemExit("--buy takes exactly one --registry: Canton Coin's own admin")
        self.ledger, self.settings, self.reth, self.key, self.clock, self.contexts = ledger, settings, reth, key, clock, contexts
        self.price, self.min_buy, self.max_meta, self.sending = price, min_buy, max_meta, sending
        self.address = evm.address_of(key)
        self.dir = Path(work_dir)
        self.journal = Journal(self.dir / JOURNAL)
        self.intake = it.Intake(ledger, settings)
        self.told: set = set()   # (instruction, why) of what was already reported
        self.capped: set = set()   # the instructions whose stuck send was said to be at the fee cap
        self.chain_id = None
        self.lock = None

    @classmethod
    def from_args(cls, args, ledger: "b.Ledger", settings: it.Settings) -> "Buy":
        lock = take_lock(args.work_dir)   # before the journal is read
        try:
            worker = cls(ledger, settings, evm.Reth(args.reth_rpc), read_key(args.buy_key_file), buy_price(args), buy_least(args), args.work_dir, args.max_meta_bytes, sending=sending_of(args))
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
        s = self.sending
        return {"price": limits.amount_text(self.price), "minBuy": limits.amount_text(self.min_buy), "party": self.settings.gateway, "maxMetaBytes": self.max_meta, "sendFrom": "0x" + self.address,
                "sendGasCap": s.gas_cap, "sendGasHeadroom": limits.amount_text(s.gas_headroom), "sendStuckSeconds": s.stuck_seconds, "sendFeeBumpPercent": s.bump_percent, "sendFeeCap": limits.amount_text(Fraction(s.fee_cap, WEI))}

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
        try:
            lapsed = datetime.fromtimestamp(self.clock(), timezone.utc) >= b.ledger_time(transfer.get("executeBefore"), "executeBefore")
        except b.BuilderError:
            raise memos.Unreadable("the transfer's deadline is not a time") from None
        if lapsed:   # only its sender can take it back now: no try is made, and an earlier try's stock is freed once that try has failed
            raise memos.Unreadable("the transfer's deadline has passed")
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
        """The gas limit of the send to this recipient: reth's estimate for the transfer (a recipient whose code runs needs more than a plain transfer's) times the headroom setting. A memos.Unreadable when reth says the transfer fails or the limit is over the gas cap setting."""
        try:
            need = self.reth.estimate_gas(self.address, recipient, wei)
        except evm.RpcError:
            raise memos.Unreadable("the transfer to this address would fail") from None
        gas = evm.TRANSFER_GAS if need <= evm.TRANSFER_GAS else int(need * self.sending.gas_headroom)   # a plain transfer needs exactly 21000
        if gas > self.sending.gas_cap:
            raise memos.Unreadable("the transfer to this address needs more gas than the worker sends")
        return gas

    # ---- reth

    def read_chain(self) -> Chain:
        if self.chain_id is None:
            self.chain_id = self.reth.chain_id()
        price = self.reth.gas_price()
        max_fee = 2 * price
        return Chain(self.chain_id, self.reth.next_nonce(self.address), max_fee, min(self.reth.tip(), max_fee))

    def reserved(self, chain: Chain, entry: dict) -> int:
        """The wei, gas included, that one journal entry takes from the buy key."""
        return int(entry["wei"]) + int(entry.get("gas", evm.TRANSFER_GAS)) * int(entry.get("maxFee", chain.max_fee))

    def owed(self, chain: Chain) -> int:
        """The wei, gas included, that the buys not yet settled still take from the buy key: an accept in doubt counts too, since its try may still commit."""
        return sum(self.reserved(chain, e) for e in self.journal.entries.values() if e["state"] in ("accepting", "accepted", "sent"))

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
        available = self.reth.balance(self.address) - self.owed(chain)
        contexts = self.contexts(self.settings.registries, self.settings.registry_tokens)
        for cid, transfer in sorted(waiting.items(), key=lambda t: (t[0] not in self.journal.entries, t[0])):   # a transfer with a try on record first: its stock is freed before the others look for theirs
            entry = self.journal.entries.get(cid)
            if entry is not None and entry["state"] != "accepting":
                continue
            room = available + (self.reserved(chain, entry) if entry is not None else 0)   # a try already on record is held in `available`: it is taken back for this transfer's own checks
            try:
                recipient, wei = self.check(cid, transfer)
                if room < wei + chain.cost():
                    raise memos.Unreadable("the buy key holds too little tROME for this amount")
                gas = self.estimate(recipient, wei)
                if chain.cost(gas) > self.sending.fee_cap:
                    raise memos.Unreadable("the fee of the send would be over the fee cap")
                if room < wei + chain.cost(gas):
                    raise memos.Unreadable("the buy key holds too little tROME for this amount")
                line = self.accept(cid, transfer, recipient, wei, gas, contexts)
            except Exception as e:   # a bad memo, a registry that does not answer, an accept that did not complete: left pending, tried again at the next poll
                held = self.journal.entries.get(cid)   # a try that was submitted may still commit: its stock stays held until that try has failed
                available = room - (self.reserved(chain, held) if held is not None and self.may_commit(held) else 0)
                self.say_once(cid, str(e) if isinstance(e, (memos.Unreadable, RuntimeError)) else f"{type(e).__name__}: {e}")
                continue
            accepted.append(line)
            available = room - self.reserved(chain, self.journal.entries[cid])
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

    def may_commit(self, entry: dict) -> bool:
        """Whether the last try of an accept may still commit. True too when the ledger cannot say."""
        try:
            return self.settle(entry)[0] != "failed"
        except Exception:
            return True

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
            max_fee = min(chain.max_fee, self.sending.fee_cap // gas)   # never above the fee cap
            tip = min(chain.tip, max_fee)
            raw = evm.transfer(self.key, chain.chain_id, nonce, entry["to"], int(entry["wei"]), max_fee, tip, gas)
            sent = "0x" + evm.keccak256(raw).hex()
            self.journal.keep(cid, state="sent", nonce=nonce, raw=raw.hex(), hash=sent, hashes=[sent], maxFee=str(max_fee), tip=str(tip), sentAt=self.clock())
            chain.nonce = nonce + 1
            entry = self.journal.entries[cid]
            self.send(cid, entry, "sent")
        elif state == "sent":
            self.follow(cid, entry, chain)

    def follow(self, cid: str, entry: dict, chain: Chain) -> None:
        """A sent buy: paid when any of the hashes of its nonce is mined; else sent again when reth holds none of them, and replaced (same nonce, higher fees) when it is not mined in time."""
        hashes = entry.get("hashes") or [entry["hash"]]
        for h in hashes:
            receipt = self.reth.receipt(h)
            if receipt is not None:
                self.journal.keep(cid, state="done", at=self.clock(), hash=h)
                it.say({"settled": cid, "hash": h, "block": receipt.get("blockNumber"), "success": receipt.get("status") == "0x1"})
                return
        held, now = [self.reth.known(h) for h in hashes], self.clock()
        if not any(held):   # reth lost them (a restart, a full pool): the latest bytes again, and the time starts again
            self.send(cid, entry, "sentAgain")
            self.journal.keep(cid, sentAt=now)
        elif entry.get("sentAt") is None:
            self.journal.keep(cid, sentAt=now)
        elif now - entry["sentAt"] >= self.sending.stuck_seconds and self.replace(cid, entry, chain, now):
            return
        elif not held[-1]:   # a replacement that was journaled and not taken by reth
            self.send(cid, entry, "sentAgain")

    def replace(self, cid: str, entry: dict, chain: Chain, now: float) -> bool:
        """True when it made a replacement, False when the fee cap leaves none. The send as a new transaction of the same nonce, with the max fee and the tip each raised by the bump setting (and no lower than reth's price now), within the fee cap. Its bytes are on disk before they are sent; the hashes of the earlier ones stay."""
        gas, pct = int(entry.get("gas", evm.TRANSFER_GAS)), self.sending.bump_percent
        old_fee, old_tip = int(entry.get("maxFee", chain.max_fee)), int(entry.get("tip", chain.tip))
        up = lambda value, percent: -(-value * (100 + percent) // 100)   # rounded up
        fee = min(max(up(old_fee, pct), chain.max_fee), self.sending.fee_cap // gas)
        tip = min(max(up(old_tip, pct), old_tip + 1, min(chain.tip, fee)), fee)
        if fee < up(old_fee, MIN_BUMP_PERCENT) or tip < up(old_tip, MIN_BUMP_PERCENT):   # reth would not take it as a replacement
            if cid not in self.capped:
                self.capped.add(cid)
                it.say({"stuck": cid, "hash": entry["hash"], "why": "the send is not mined and its fees cannot be raised within the fee cap: it keeps waiting"})
            return False
        raw = evm.transfer(self.key, chain.chain_id, entry["nonce"], entry["to"], int(entry["wei"]), fee, tip, gas)
        replacement = "0x" + evm.keccak256(raw).hex()
        hashes = list(entry.get("hashes") or [entry["hash"]])
        entry = self.journal.keep(cid, raw=raw.hex(), hash=replacement, hashes=hashes + [replacement], maxFee=str(fee), tip=str(tip), sentAt=now)
        self.send(cid, entry, "replaced")
        return True

    def send(self, cid: str, entry: dict, kind: str) -> None:
        """The journaled bytes to reth. The same bytes each time, so reth holds the send once whatever happens in between."""
        try:
            self.reth.send(bytes.fromhex(entry["raw"]))
        except evm.RpcError as e:
            if "already known" not in e.message.lower():
                raise
        it.say({kind: cid, "hash": entry["hash"], "nonce": entry["nonce"], "recipient": entry["to"], "wei": entry["wei"]})

    def publish(self, available: int, chain: Chain) -> None:
        """buy-status.json: the price, the least buy, the party, and whether the stock still covers the least buy (open) or not (sold out). A write that fails is said and never stops the worker."""
        least = max(self.wei_for(self.min_buy), 1) + chain.cost()
        doc = {"version": 1, "updatedAt": datetime.fromtimestamp(self.clock(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "price": limits.amount_text(self.price),
               "minBuy": limits.amount_text(self.min_buy), "party": self.settings.gateway, "state": "open" if available >= least else "sold out"}
        try:
            b.write_json_file(self.dir / STATUS, doc)
        except OSError as e:
            it.say({"error": b.bounded_text(f"the status file cannot be written ({type(e).__name__})")})


def positive_decimal(text: str, flag: str, zero: bool = False, of: str = " of Canton Coin") -> Fraction:
    try:
        value = b.decimal(text)
    except ValueError:
        value = None
    if value is None or value < 0 or (value == 0 and not zero):
        raise SystemExit(f"{flag} must be a {'number' if zero else 'positive number'}{of} as plain decimal text, not {str(text)[:40]!r}")
    return value


def whole_number(text, flag: str, least: int) -> int:
    try:
        value = b.decimal(text)
    except ValueError:
        value = None
    if value is None or value.denominator != 1 or value < least:
        raise SystemExit(f"{flag} must be a whole number, {least} or more, not {str(text)[:40]!r}")
    return int(value)


def sending_of(args) -> Sending:
    """The sending settings (the defaults of Sending where a flag is not given), checked."""
    headroom = positive_decimal(args.send_gas_headroom, "--send-gas-headroom", of="")
    if headroom < 1:
        raise SystemExit("--send-gas-headroom must be 1 or more")
    fee_cap = positive_decimal(args.send_fee_cap, "--send-fee-cap", of=" of tROME")
    return Sending(whole_number(args.send_gas_cap, "--send-gas-cap", evm.TRANSFER_GAS), headroom, whole_number(args.send_stuck_seconds, "--send-stuck-seconds", 1),
                   whole_number(args.send_fee_bump_percent, "--send-fee-bump-percent", MIN_BUMP_PERCENT), int(fee_cap * WEI))


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
    buy_price(args), buy_least(args), sending_of(args)


def settings_of(args) -> it.Settings:
    """The registries as the intake takes them; the party is the validator party. Canton Coin is the instrument of an admin that has a registry."""
    registries = b.parse_registries(args.registry)
    if not registries:
        raise SystemExit("--buy needs --registry for Canton Coin's admin: the accept's choice context comes from it")
    if len(registries) > 1:
        raise SystemExit("--buy takes exactly one --registry: Canton Coin's own admin (another admin's Amulet is not Canton Coin)")
    return it.Settings(args.validator_party, registries, b.read_registry_tokens(args.registry_token_file, registries))
