#!/usr/bin/env python3
"""The custody worker, part 1: the intake (part 2, the payouts, is payout.py and runs in the same process with --payout-offers). See README.md.

  intake.py --intake [--once] --gateway-party PARTY [--poll-seconds 10] [--min-deposit ADMIN/ID=AMOUNT]... [--router 0xADDRESS --book 0xADDRESS] [--ostia-rpc URL] [--gateway-address 0xADDRESS]
            [--registry ADMIN=URL]... [--registry-token-file ADMIN=FILE]...

Every poll it reads the transfers to the gateway that wait for their receiver, and for each one whose instrument is a registered GatewayToken, whose memo it can read and whose amount
is at least that token's minimum and that can be claimed now (for a route memo, read live from the router's book on Ostia: the fee, the minimum and the memo's most fee), it makes the gateway accept the transfer (Intake_Accept, with the choice context of that token's registry), which makes a Receipt in the same
transaction. A transfer that cannot be claimed is rejected, so the coin goes back to its sender at once. Everything else stays pending, for its sender to take back. It does nothing unless --intake is given.
One JSON line on stdout for each accept, each reject and each transfer left pending.
"""
import argparse, json, os, sys, time, urllib.error, urllib.parse, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "builder"))
sys.path.insert(0, str(HERE))
import builder as b
import memo as memos
import claimable

PKG = "#canton-zk-evm:Zk.Chain:"
INTAKE, GATEWAY_TOKEN, RECEIPT, DEPOSIT_REQUEST = PKG + "Intake", PKG + "GatewayToken", PKG + "Receipt", PKG + "DepositRequest"
TRANSFER_INSTRUCTION = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction"
WAITING = "TransferPendingReceiverAcceptance"   # the only status in which the receiver may accept
PREAPPROVAL = "#splice-amulet:Splice.AmuletRules:TransferPreapproval"   # a Canton Coin receiver's standing consent: a transfer to it completes at once, with no offer to refuse
REJECT_KEY = "romeprotocol.com/ostia-reject-reason"   # in the reject's meta: why
EMPTY_CONTEXT = {"values": {}}


class Contexts(b.ChoiceContexts):
    """The builder's registry reader, with the choice context of a receiver's accept."""

    @b.registry_guard("token registry")
    def accept(self, admin: str, instruction: str, choice: str = "accept"):
        """(context, disclosed contracts) for `TransferInstruction_Accept` of this instruction (with choice "withdraw", for the sender's `TransferInstruction_Withdraw`)."""
        reply = self.ask(admin, f"/registry/transfer-instruction/v1/{urllib.parse.quote(instruction, safe='')}/choice-contexts/{choice}", {"meta": {}, "excludeDebugFields": True})
        return self.read(reply)

    def withdraw(self, admin: str, instruction: str):
        return self.accept(admin, instruction, "withdraw")

    def reject(self, admin: str, instruction: str):
        return self.accept(admin, instruction, "reject")

    @b.registry_guard("token registry")
    def transfer_factory(self, admin: str, transfer: dict):
        """(factory id, context, disclosed contracts) of the factory the registry names for this transfer. The standard's own `expectedAdmin` check, made by the factory, is what ties it to the token."""
        args = {"expectedAdmin": admin, "transfer": transfer, "extraArgs": {"context": {"values": {}}, "meta": {"values": {}}}}
        reply = self.ask(admin, "/registry/transfer-instruction/v1/transfer-factory", {"choiceArguments": args, "excludeDebugFields": True})
        factory = reply.get("factoryId") if isinstance(reply, dict) else None
        if not isinstance(factory, str) or not factory:
            raise b.NoCantonSide("the token registry named no transfer factory")
        return (factory, *self.read(reply.get("choiceContext")))


class Settings:
    """`minimums` is {(instrument admin, instrument id): the least amount, a Fraction}; `router` the address that a route memo's receipt is for, or None; `used` a function from a
    deposit id to whether the gateway has used it already, or None (then only the ids that a Receipt or DepositRequest holds are known to be taken); `ostia` the router's book and
    router as `claimable.Ostia` reads them, or None (then a route memo is never accepted: its fee and minimum are unknown)."""

    def __init__(self, gateway: str, registries: dict = None, registry_tokens: dict = None, minimums: dict = None, router: str = None, used=None, ostia: "claimable.Ostia" = None):
        self.gateway, self.registries, self.registry_tokens, self.minimums, self.router, self.used, self.ostia = gateway, registries or {}, registry_tokens or {}, minimums or {}, router, used, ostia


def say(line: dict) -> None:
    print(json.dumps(line, sort_keys=True), flush=True)


def call(ledger: "b.Ledger", path: str, body: dict) -> dict:
    """A POST to the Ledger API as the ledger user. Raises with the participant's reason when it is refused."""
    try:
        answer = b.post_json(ledger.cfg.ledger_url + path, body, ledger.auth)
    except urllib.error.HTTPError as e:
        try:
            why = b.bounded_text(e.read(500).decode("utf-8", "replace"))
        finally:
            e.close()
        raise RuntimeError(f"the participant refused it (HTTP {e.code}): {why}") from None
    return answer if isinstance(answer, dict) else {}


def submit(ledger: "b.Ledger", gateway: str, command: dict, disclosed: list, command_id: str = None) -> dict:
    """The command as the gateway, in one transaction, waiting for it. Raises with the participant's reason when it is refused."""
    body = {"commands": [command], "commandId": command_id or str(uuid.uuid4()), "userId": ledger.cfg.ledger_user, "actAs": [gateway], "readAs": [gateway]}
    if disclosed:
        body["disclosedContracts"] = disclosed
    return call(ledger, "/v2/commands/submit-and-wait", body)


class Intake:
    def __init__(self, ledger: "b.Ledger", settings: Settings, send=None, contexts=Contexts):
        self.ledger, self.settings, self.contexts = ledger, settings, contexts
        self.send = send or (lambda command, disclosed: submit(ledger, settings.gateway, command, disclosed))
        self.told: set = set()   # (instruction, why) of the transfers left pending that were already reported

    def waiting(self) -> list:
        """(instruction, transfer) of every transfer to the gateway that waits for its receiver."""
        found = []
        for cid, view in self.ledger.interface_views(TRANSFER_INSTRUCTION):
            transfer = view.get("transfer") if isinstance(view, dict) else None
            status = view.get("status") if isinstance(view, dict) else None
            if isinstance(transfer, dict) and transfer.get("receiver") == self.settings.gateway and isinstance(status, dict) and status.get("tag") == WAITING:
                found.append((cid, transfer))
        return found

    def registered(self) -> tuple:
        """(the Intake, {(admin, id): GatewayToken}) of the gateway's chain."""
        gateway = self.settings.gateway
        made = [i for i in self.ledger.active(INTAKE) if i.get("gateway") == gateway]
        if len(made) != 1:
            raise RuntimeError(f"the gateway sees {len(made)} intakes, not one: Daml 0.6.0 and its Intake must be set up")
        intake = made[0]
        tokens = {}
        for t in self.ledger.active(GATEWAY_TOKEN):
            if all(t.get(k) == intake.get(k) for k in ("chainId", "operator", "confirmer", "gateway")):
                tokens[(t["instrumentId"]["admin"], t["instrumentId"]["id"])] = t
        return intake, tokens

    def open_ids(self) -> set:
        """The deposit ids that a receipt or a deposit request holds open now."""
        return {r["depositId"] for template in (RECEIPT, DEPOSIT_REQUEST) for r in self.ledger.active(template) if "depositId" in r}

    def claimable(self, entry: dict, transfer: dict, label: str) -> None:
        """Nothing when the transfer can be claimed now, else a `claimable.Refused` (the transfer is rejected) or a RuntimeError (the live numbers cannot be read: it stays pending and is tried again)."""
        amount = b.base_units(transfer["amount"])
        if amount is None:
            raise memos.Unreadable("the amount is not a Canton amount")
        route = memos.route_parts(label)
        if route is None:
            return claimable.check_plain(amount)
        if self.settings.ostia is None:
            raise RuntimeError("the router's book is not set: a route's fee and minimum are unknown")
        try:
            erc20 = memos.address_of("0x" + entry["evmToken"])
        except memos.Unreadable:
            raise RuntimeError("the token's address on Ostia is not an address") from None
        claimable.check_route(self.settings.ostia, erc20, route[0], amount, route[1])

    def reject(self, cid: str, transfer: dict, why: str, contexts) -> dict:
        """The gateway rejects the offer (the standard's `TransferInstruction_Reject`, with the registry's reject context), so the coin goes back to its sender at once. The line `say` printed."""
        admin = transfer["instrumentId"]["admin"]
        context, disclosed = contexts.reject(admin, cid) if contexts.wants(admin) else (None, [])
        answer = self.send({"ExerciseCommand": {"templateId": TRANSFER_INSTRUCTION, "contractId": cid, "choice": "TransferInstruction_Reject",
                                                "choiceArgument": {"extraArgs": {"context": context or EMPTY_CONTEXT, "meta": {"values": {REJECT_KEY: why}}}}}}, disclosed)
        line = {"rejected": cid, "reason": why, "amount": transfer["amount"], "instrument": transfer["instrumentId"], "sender": transfer["sender"], "updateId": answer.get("updateId")}
        say(line)
        return line

    def poll(self) -> list:
        """One poll: the transfers that were accepted, each as what `say` printed. A transfer that cannot be claimed as it stands (its amount cannot pay the live fee and minimum) is rejected, and
        its line is `rejected`; any other that cannot be taken stays as it is and is tried again at the next poll."""
        candidates = self.waiting()
        accepted, now = [], {c for c, _ in candidates}
        self.told = {k for k in self.told if k[0] in now}
        if not candidates:
            return accepted
        intake, registered = self.registered()
        taken = None
        contexts = self.contexts(self.settings.registries, self.settings.registry_tokens)
        for cid, transfer in candidates:
            try:
                instrument = transfer["instrumentId"]
                entry = registered.get((instrument["admin"], instrument["id"]))
                if entry is None:
                    raise memos.Unreadable("the instrument is not a registered token")
                least = self.settings.minimums.get((instrument["admin"], instrument["id"]))
                if least is not None and b.decimal(transfer["amount"]) < least:
                    raise memos.Unreadable("the amount is below the token's minimum")
                label, recipient = memos.read(((transfer.get("meta") or {}).get("values")) or {}, cid, self.settings.router)
                try:
                    self.claimable(entry, transfer, label)
                except claimable.Refused as e:
                    self.reject(cid, transfer, b.bounded_text(str(e)), contexts)
                    continue
                deposit_id = b.deposit_id_of(transfer["sender"], label)
                taken = self.open_ids() if taken is None else taken
                if deposit_id in taken:
                    raise memos.Unreadable("a deposit with this id is open already")
                if self.settings.used is not None and self.settings.used(deposit_id):
                    raise memos.Unreadable("a deposit with this id was claimed already")
                context, disclosed = contexts.accept(instrument["admin"], cid) if contexts.wants(instrument["admin"]) else (None, [])
                answer = self.send({"ExerciseCommand": {"templateId": INTAKE, "contractId": intake["contractId"], "choice": "Intake_Accept",
                                                        "choiceArgument": {"gatewayToken": entry["contractId"], "instruction": cid, "label": label, "recipient": recipient, "choiceContext": context}}}, disclosed)
            except Exception as e:   # one transfer's failure (a bad memo, a registry that does not answer, an accept that did not complete) never stops the others
                why = str(e) if isinstance(e, (memos.Unreadable, RuntimeError)) else f"{type(e).__name__}: {e}"
                why = b.bounded_text(why)
                if (cid, why) not in self.told:
                    self.told.add((cid, why))
                    say({"pending": cid, "why": why})
                continue
            taken.add(deposit_id)
            line = {"accepted": cid, "amount": transfer["amount"], "instrument": instrument, "label": label, "recipient": recipient, "sender": transfer["sender"], "updateId": answer.get("updateId")}
            say(line)
            accepted.append(line)
        return accepted


def parse_minimums(items: list, flag: str = "--min-deposit") -> dict:
    """{(admin, id): amount} of `ADMIN/ID=AMOUNT` items: split on the first "/" (a party id has none) and the last "=" (an instrument id is free text)."""
    found = {}
    for item in items:
        instrument, eq, amount = item.rpartition("=")
        admin, slash, name = instrument.partition("/")
        try:
            least = b.decimal(amount) if eq else None
        except ValueError:
            least = None
        if least is None or least < 0 or not slash or not name or not b.canton_party_text(admin):
            raise SystemExit(f"{flag} is ADMIN/ID=AMOUNT (the admin party, the instrument id, the least amount), not {item[:80]!r}")
        if (admin, name) in found:
            raise SystemExit(f"two {flag} for {admin}/{name}")
        found[(admin, name)] = least
    return found


def parser() -> argparse.ArgumentParser:
    env = os.environ
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--intake", action="store_true", default=env.get("CZE_INTAKE") == "1", help="switch the intake on (also CZE_INTAKE=1); without it the worker does nothing")
    ap.add_argument("--once", action="store_true", help="one poll, then exit")
    ap.add_argument("--poll-seconds", type=float, default=float(env.get("CZE_POLL_SECONDS", 10)), metavar="SECONDS", help="the time between two polls (default 10; also CZE_POLL_SECONDS)")
    ap.add_argument("--gateway-party", default=env.get("CZE_GATEWAY_PARTY", ""), metavar="PARTY", help="the chain's gateway party (also CZE_GATEWAY_PARTY): the ledger user must act as it")
    ap.add_argument("--ledger-url", default=env.get("CZE_LEDGER_URL", "http://127.0.0.1:7575"), help="Canton's JSON Ledger API (also CZE_LEDGER_URL)")
    ap.add_argument("--ledger-user", default=env.get("CZE_LEDGER_USER", ""), help="the ledger user, the operator's (also CZE_LEDGER_USER)")
    ap.add_argument("--ledger-token-file", dest="bearer_file", default=env.get("CZE_LEDGER_TOKEN_FILE", ""), metavar="FILE", help="a file with the user's bearer token, read again for each call (also CZE_LEDGER_TOKEN_FILE, or CZE_LEDGER_TOKEN)")
    ap.add_argument("--registry", action="append", default=[x for x in env.get("CZE_TOKEN_REGISTRIES", "").split(",") if x.strip()], metavar="ADMIN=URL",
                    help="the token registry of the instruments of ADMIN, as the builder takes it (repeatable; also CZE_TOKEN_REGISTRIES, comma separated): its choice context for the accept. An admin with none gets an empty context")
    ap.add_argument("--registry-token-file", action="append", default=[x for x in env.get("CZE_TOKEN_REGISTRY_TOKEN_FILES", "").split(",") if x.strip()], metavar="ADMIN=FILE",
                    help="a file with the bearer token that the registry of ADMIN wants (repeatable; also CZE_TOKEN_REGISTRY_TOKEN_FILES, comma separated)")
    ap.add_argument("--min-deposit", action="append", default=[], metavar="ADMIN/ID=AMOUNT", help="the least amount of an instrument that is accepted (repeatable); a transfer below it stays pending. Default: no minimum")
    ap.add_argument("--router", default=env.get("CZE_ROUTER_ADDRESS", ""), metavar="0xADDRESS", help="the router: a memo that is a route text (r1:...) is accepted when the router would claim it now, with the router as the receipt's recipient (also CZE_ROUTER_ADDRESS); needs --book and --ostia-rpc. Default: route memos stay pending")
    ap.add_argument("--book", default=env.get("CZE_BOOK_ADDRESS", ""), metavar="0xADDRESS", help="the router's book on Ostia (also CZE_BOOK_ADDRESS): its live fees, minimum and unit decide whether a route memo can be claimed; with --router")
    ap.add_argument("--ostia-rpc", default=env.get("CZE_OSTIA_RPC_URL", ""), metavar="URL", help="Ostia's JSON-RPC: with --gateway-address, a transfer whose deposit id the gateway has used already stays pending; with --router and --book, the book is read for each route memo (also CZE_OSTIA_RPC_URL). Never printed. Default: only the open ids are checked")
    ap.add_argument("--gateway-address", default=env.get("CZE_GATEWAY_ADDRESS", ""), metavar="0xADDRESS", help="the chain's gateway contract on Ostia (also CZE_GATEWAY_ADDRESS)")
    ap.add_argument("--payout-offers", action="store_true", default=env.get("CZE_PAYOUT_OFFERS") == "1",
                    help="pay each open Payout as one transfer offer from the gateway (also CZE_PAYOUT_OFFERS=1); needs --work-dir. Default: off")
    ap.add_argument("--offer-hours", type=float, default=float(env.get("CZE_OFFER_HOURS", 24)), metavar="HOURS", help="how long a payout's offer stays open before it is withdrawn and offered again; a rejected offer is offered again after the same time (default 24; also CZE_OFFER_HOURS)")
    ap.add_argument("--min-payout", action="append", default=[], metavar="ADMIN/ID=AMOUNT", help="the least amount of an instrument that is offered as a payout (repeatable); a smaller payout gets no offer and no Canton transaction, and waits. Default: no minimum")
    ap.add_argument("--max-offers", type=int, default=int(env.get("CZE_MAX_OFFERS", 0)), metavar="N", help="how many offers a payout gets: one that was offered (or refused) N times and not accepted is not offered again (also CZE_MAX_OFFERS). Default 0: no limit")
    ap.add_argument("--work-dir", default=env.get("CZE_WORK_DIR", ""), metavar="DIR", help="the builder's work folder (also CZE_WORK_DIR): the worker keeps payouts.json there and reads custody-stop.json from it")
    ap.add_argument("--expiring-instrument", action="append", default=[], metavar="ADMIN", help="as the builder's: an instrument whose holdings run out (Canton Coin), paid with the builder's input choice, floor and custody check; needs its --registry and --registry-token-file")
    ap.add_argument("--custody-floor-days", type=float, default=30, metavar="DAYS", help="as the builder's (default 30)")
    ap.add_argument("--custody-due-days", type=float, default=7, metavar="DAYS", help="as the builder's (default 7); only checked against the other two")
    ap.add_argument("--custody-alert-days", type=float, default=3, metavar="DAYS", help="as the builder's (default 3); only checked against the other two")
    ap.add_argument("--max-transfer-inputs", type=int, default=50, metavar="N", help="as the builder's (default 50)")
    ap.add_argument("--disclosed", metavar="FILE", help="a JSON list of disclosed contracts that a token with no registry needs for its transfer factory, as the builder takes it")
    return ap


def gateway_used(url: str, address: str):
    """A function from a deposit id (64 hex digits) to whether the gateway's `used` mapping (slot 1) has it set, read on Ostia at the latest block. An unreadable answer is a RuntimeError that does not name the URL."""
    def used(deposit_id: str) -> bool:
        slot = "0x" + b.keccak256(bytes.fromhex(deposit_id) + (1).to_bytes(32, "big")).hex()
        try:
            answer = b.post_json(url, {"jsonrpc": "2.0", "id": 1, "method": "eth_getStorageAt", "params": ["0x" + address, slot, "latest"]}, {"user-agent": "Rome Protocol rome@romeprotocol.com"}, timeout=30)
            return int(answer["result"], 16) != 0
        except (OSError, ValueError, KeyError, TypeError) as e:
            if isinstance(e, urllib.error.HTTPError):
                e.close()
            raise RuntimeError("the gateway's used(id) cannot be read on Ostia") from None
    return used


def ledger_of(args) -> "b.Ledger":
    """A builder ledger client that reads as the gateway, with the ledger user's token."""
    bearer, bearer_file = os.environ.get("CZE_LEDGER_TOKEN", ""), args.bearer_file
    fields = {"ws_url": "", "engine_url": "", "jwt_secret": b"", "ledger_url": args.ledger_url, "ledger_user": args.ledger_user, "ledger_token": bearer,
              "party": args.gateway_party, "fee_recipient": "", "genesis": "", "work_dir": args.work_dir, "make_input_cmd": "", "prove_cmd": "", "ledger_token_file": bearer_file}
    return b.Ledger(b.Config(**fields))


def settings_of(args) -> Settings:
    if not b.canton_party_text(args.gateway_party) or not args.ledger_user:
        raise SystemExit("set --gateway-party (a party id) and --ledger-user")
    registries = b.parse_registries(args.registry)
    try:
        router = "0x" + memos.address_of(args.router) if args.router else None
    except memos.Unreadable:
        raise SystemExit("--router must be an EVM address (0x and 40 hex digits)") from None
    if bool(args.book) != bool(args.router):
        raise SystemExit("--router and --book go together: a route memo is accepted only on the book's live fees and minimum")
    if args.router and not args.ostia_rpc:
        raise SystemExit("--router needs --ostia-rpc, to read the book")
    try:
        ostia = claimable.Ostia(claimable.eth_call(args.ostia_rpc), memos.address_of(args.book), memos.address_of(args.router)) if args.router else None
    except memos.Unreadable:
        raise SystemExit("--book must be an EVM address (0x and 40 hex digits)") from None
    if args.gateway_address and not args.ostia_rpc:
        raise SystemExit("--ostia-rpc and --gateway-address go together")
    if args.ostia_rpc and not args.gateway_address and not args.router:
        raise SystemExit("--ostia-rpc and --gateway-address go together")
    try:
        used = gateway_used(args.ostia_rpc, memos.address_of(args.gateway_address)) if args.gateway_address else None
    except memos.Unreadable:
        raise SystemExit("--gateway-address must be an EVM address (0x and 40 hex digits)") from None
    return Settings(args.gateway_party, registries, b.read_registry_tokens(args.registry_token_file, registries), parse_minimums(args.min_deposit), router, used, ostia)


def preapproval_warning(ledger: "b.Ledger", gateway: str) -> None:
    """The gateway must hold no Canton Coin transfer preapproval: with one, a transfer completes at once and there is no offer for the intake to refuse. One `warning` line when it holds one, or when that cannot be read."""
    try:
        held = [p for p in ledger.active(PREAPPROVAL) if p.get("receiver") == gateway]
    except Exception as e:   # the check never stops the worker
        say({"warning": b.bounded_text(f"the gateway's Canton Coin transfer preapproval could not be checked ({type(e).__name__})")})
        return
    if held:
        say({"warning": "the gateway holds a Canton Coin transfer preapproval: coins reach it with no offer, so the intake cannot refuse what cannot be claimed; archive it", "preapprovals": [p["contractId"] for p in held]})


def main(argv: list) -> int:
    args = parser().parse_args(argv)
    if not (args.intake or args.payout_offers):
        print("the custody worker is off: pass --intake and/or --payout-offers (or CZE_INTAKE=1, CZE_PAYOUT_OFFERS=1) to switch it on", file=sys.stderr)
        return 0
    try:
        ledger, settings = ledger_of(args), settings_of(args)
        workers = [Intake(ledger, settings)] if args.intake else []
        if args.intake:
            preapproval_warning(ledger, settings.gateway)
        if args.payout_offers:
            import payout
            payouts = payout.Payouts.from_args(args, ledger, settings)
            workers.append(payouts)
            say({"payouts": payouts.describe()})
    except b.BuilderError as e:
        raise SystemExit(str(e)) from None
    while True:
        for worker in workers:
            try:
                worker.poll()
            except Exception as e:   # the ledger cannot be read now: try again at the next poll
                say({"error": b.bounded_text(f"{type(e).__name__}: {e}")})
        if args.once:
            return 0
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
