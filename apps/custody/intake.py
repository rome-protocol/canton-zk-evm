#!/usr/bin/env python3
"""The custody worker, part 1: the intake. See README.md.

  intake.py --intake [--once] --gateway-party PARTY [--poll-seconds 10] [--min-deposit ADMIN/ID=AMOUNT]... [--router 0xADDRESS]
            [--registry ADMIN=URL]... [--registry-token-file ADMIN=FILE]...

Every poll it reads the transfers to the gateway that wait for their receiver, and for each one whose instrument is a registered GatewayToken, whose memo it can read and whose amount
is at least that token's minimum, it makes the gateway accept the transfer (Intake_Accept, with the choice context of that token's registry), which makes a Receipt in the same
transaction. Everything else stays pending, for its sender to take back. It does nothing unless --intake is given. One JSON line on stdout for each accept and for each transfer left pending.
"""
import argparse, json, os, sys, time, urllib.error, urllib.parse, uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "builder"))
sys.path.insert(0, str(HERE))
import builder as b
import memo as memos

PKG = "#canton-zk-evm:Zk.Chain:"
INTAKE, GATEWAY_TOKEN, RECEIPT, DEPOSIT_REQUEST = PKG + "Intake", PKG + "GatewayToken", PKG + "Receipt", PKG + "DepositRequest"
TRANSFER_INSTRUCTION = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferInstruction"
WAITING = "TransferPendingReceiverAcceptance"   # the only status in which the receiver may accept


class Contexts(b.ChoiceContexts):
    """The builder's registry reader, with the choice context of a receiver's accept."""

    @b.registry_guard("token registry")
    def accept(self, admin: str, instruction: str):
        """(context, disclosed contracts) for `TransferInstruction_Accept` of this instruction."""
        reply = self.ask(admin, f"/registry/transfer-instruction/v1/{urllib.parse.quote(instruction, safe='')}/choice-contexts/accept", {"meta": {}, "excludeDebugFields": True})
        return self.read(reply)


class Settings:
    """`minimums` is {(instrument admin, instrument id): the least amount, a Fraction}; `router` the address that a route memo's receipt is for, or None."""

    def __init__(self, gateway: str, registries: dict = None, registry_tokens: dict = None, minimums: dict = None, router: str = None):
        self.gateway, self.registries, self.registry_tokens, self.minimums, self.router = gateway, registries or {}, registry_tokens or {}, minimums or {}, router


def say(line: dict) -> None:
    print(json.dumps(line, sort_keys=True), flush=True)


def submit(ledger: "b.Ledger", gateway: str, command: dict, disclosed: list) -> dict:
    """The command as the gateway, in one transaction, waiting for it. Raises with the participant's reason when it is refused."""
    body = {"commands": [command], "commandId": str(uuid.uuid4()), "userId": ledger.cfg.ledger_user, "actAs": [gateway], "readAs": [gateway]}
    if disclosed:
        body["disclosedContracts"] = disclosed
    try:
        answer = b.post_json(ledger.cfg.ledger_url + "/v2/commands/submit-and-wait", body, ledger.auth)
    except urllib.error.HTTPError as e:
        try:
            why = b.bounded_text(e.read(500).decode("utf-8", "replace"))
        finally:
            e.close()
        raise RuntimeError(f"the participant refused it (HTTP {e.code}): {why}") from None
    return answer if isinstance(answer, dict) else {}


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

    def poll(self) -> list:
        """One poll: the transfers that were accepted, each as what `say` printed. A transfer that cannot be taken stays as it is and is tried again at the next poll."""
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
                deposit_id = b.deposit_id_of(transfer["sender"], label)
                taken = self.open_ids() if taken is None else taken
                if deposit_id in taken:
                    raise memos.Unreadable("a deposit with this id is open already")
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


def parse_minimums(items: list) -> dict:
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
            raise SystemExit(f"--min-deposit is ADMIN/ID=AMOUNT (the admin party, the instrument id, the least amount), not {item[:80]!r}")
        if (admin, name) in found:
            raise SystemExit(f"two --min-deposit for {admin}/{name}")
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
    ap.add_argument("--router", default=env.get("CZE_ROUTER_ADDRESS", ""), metavar="0xADDRESS", help="the router: a memo that is a route text (r1:...) is accepted, with the router as the receipt's recipient (also CZE_ROUTER_ADDRESS). Default: route memos stay pending")
    return ap


def ledger_of(args) -> "b.Ledger":
    """A builder ledger client that reads as the gateway, with the ledger user's token."""
    bearer, bearer_file = os.environ.get("CZE_LEDGER_TOKEN", ""), args.bearer_file
    fields = {"ws_url": "", "engine_url": "", "jwt_secret": b"", "ledger_url": args.ledger_url, "ledger_user": args.ledger_user, "ledger_token": bearer,
              "party": args.gateway_party, "fee_recipient": "", "genesis": "", "work_dir": "", "make_input_cmd": "", "prove_cmd": "", "ledger_token_file": bearer_file}
    return b.Ledger(b.Config(**fields))


def settings_of(args) -> Settings:
    if not b.canton_party_text(args.gateway_party) or not args.ledger_user:
        raise SystemExit("set --gateway-party (a party id) and --ledger-user")
    registries = b.parse_registries(args.registry)
    router = memos.address_of(args.router) if args.router else None
    return Settings(args.gateway_party, registries, b.read_registry_tokens(args.registry_token_file, registries), parse_minimums(args.min_deposit), router)


def main(argv: list) -> int:
    args = parser().parse_args(argv)
    if not args.intake:
        print("the intake is off: pass --intake (or CZE_INTAKE=1) to switch it on", file=sys.stderr)
        return 0
    try:
        worker = Intake(ledger_of(args), settings_of(args))
    except b.BuilderError as e:
        raise SystemExit(str(e)) from None
    while True:
        try:
            worker.poll()
        except Exception as e:   # the ledger cannot be read now: try again at the next poll
            say({"error": b.bounded_text(f"{type(e).__name__}: {e}")})
        if args.once:
            return 0
        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
