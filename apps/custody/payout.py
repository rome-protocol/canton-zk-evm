"""The custody worker, part 2: the payouts. Run by intake.py with --payout-offers (off by default). See README.md.

For each open Payout the gateway makes one standard transfer offer to the party, through the factory that the token's registry names, and marks the Payout paid only when the
receiver accepted it (or the transfer completed at once). Rome's state is a small journal (payouts.json in the work folder); everything else is read from the ledger.
"""
import hashlib, json, sys, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
import intake as it
b = it.b

PAYOUT = b.PAYOUT
TRANSFER_FACTORY = "#splice-api-token-transfer-instruction-v1:Splice.Api.Token.TransferInstructionV1:TransferFactory"
WITHDRAWAL_KEY = "romeprotocol.com/ostia-withdrawal"   # in the transfer's meta: the payout's id
COMPLETED, PENDING = "TransferInstructionResult_Completed", "TransferInstructionResult_Pending"
JOURNAL = "payouts.json"
EMPTY_CONTEXT = {"values": {}}
EVERYTHING = {"cumulative": [{"identifierFilter": {"WildcardFilter": {"value": {"includeCreatedEventBlob": False}}}}]}


def exercise_output(tx: dict, contract: str, choice: str):
    """The `output` ({tag, value}) that this choice of this contract gave in the transaction, or None unless it was exercised once and gave one."""
    found = [e["ExercisedEvent"] for e in tx.get("events", []) if "ExercisedEvent" in e and e["ExercisedEvent"].get("choice") == choice and e["ExercisedEvent"].get("contractId") == contract]
    result = found[0].get("exerciseResult") if len(found) == 1 else None
    output = result.get("output") if isinstance(result, dict) else None
    return output if isinstance(output, dict) else None


class Journal:
    """{payout id: what was done for it}: n (the offers made), at (when the last was made), command, begin (the ledger end before it), factory, state, instruction, update, offset.
    state: "sending" (the command may or may not have committed), "offered" (the instruction is pending), "completed" (the transfer completed, the Payout is not marked yet),
    "ended" (the offer lapsed, was rejected or failed: offered again once its time has passed). One that cannot be read stops the worker: it does not guess."""

    def __init__(self, path: Path):
        self.path = path
        try:
            self.entries = json.loads(path.read_text()) if path.exists() else {}
        except (OSError, ValueError) as e:
            raise b.BuilderError(f"cannot read {path}: {e}") from None
        if not isinstance(self.entries, dict):
            raise b.BuilderError(f"{path} is not a journal")

    def keep(self, payout: str, **fields) -> dict:
        entry = self.entries.setdefault(payout, {})
        if any(entry.get(k) != v for k, v in fields.items()):
            entry.update(fields)
            b.write_json_file(self.path, self.entries)
        return entry

    def forget(self, kept: set) -> None:
        gone = set(self.entries) - kept
        if gone:
            for payout in gone:
                del self.entries[payout]
            b.write_json_file(self.path, self.entries)


class Payouts:
    def __init__(self, ledger: "b.Ledger", settings: it.Settings, work_dir: str, offer_hours: float = 24.0, clock=time.time, contexts=it.Contexts):
        self.ledger, self.settings, self.contexts, self.clock = ledger, settings, contexts, clock
        self.lifetime = timedelta(hours=offer_hours)
        self.journal = Journal(Path(work_dir) / JOURNAL)
        self.told: set = set()   # (payout, why) of what was already reported

    @classmethod
    def from_args(cls, args, ledger: "b.Ledger", settings: it.Settings) -> "Payouts":
        if not args.work_dir:
            raise SystemExit("--payout-offers needs --work-dir (the builder's work folder)")
        if not args.offer_hours > 0:
            raise SystemExit("--offer-hours must be more than zero")
        cfg = ledger.cfg
        for name in ("registries", "registry_tokens"):   # the builder's check_expiring reads them from its config
            setattr(cfg, name, getattr(settings, name))
        b.check_expiring(args, cfg)
        if args.disclosed:
            cfg.disclosed = b.read_disclosed(args.disclosed)
        return cls(ledger, settings, args.work_dir, args.offer_hours)

    # ---- reading the ledger

    def update(self, **which) -> dict:
        """The transaction of an update (by `updateId` or by `offset`) with its effects, as the gateway sees it."""
        body = {**which, "updateFormat": {"includeTransactions": {"eventFormat": {"filtersByParty": {self.settings.gateway: EVERYTHING}, "verbose": False},
                                                                  "transactionShape": "TRANSACTION_SHAPE_LEDGER_EFFECTS"}}}
        found = it.call(self.ledger, "/v2/updates/update-by-" + ("id" if "updateId" in which else "offset"), body)
        tx = (found.get("update") or {}).get("Transaction", {}).get("value")
        if not isinstance(tx, dict):
            raise RuntimeError("the ledger gave no transaction for the update")
        return tx

    def live(self) -> dict:
        """{payout id: [(instruction, transfer, status tag)]} of the gateway's own pending transfers that carry a payout's id."""
        found = {}
        for cid, view in self.ledger.interface_views(it.TRANSFER_INSTRUCTION):
            transfer = view.get("transfer") if isinstance(view, dict) else None
            status = view.get("status") if isinstance(view, dict) else None
            values = (transfer.get("meta") or {}).get("values") if isinstance(transfer, dict) else None
            payout = values.get(WITHDRAWAL_KEY) if isinstance(values, dict) else None
            if isinstance(payout, str) and transfer.get("sender") == self.settings.gateway and isinstance(status, dict):
                found.setdefault(payout, []).append((cid, transfer, status.get("tag")))
        return found

    def outcome(self, instruction: str):
        """How an instruction that is no longer active ended, from the choice that archived it: (update id, offset) when it completed the transfer, False when it did not (rejected,
        withdrawn, failed), None when that cannot be read yet."""
        body = {"contractId": instruction, "eventFormat": {"filtersByParty": {self.settings.gateway: EVERYTHING}, "verbose": False}}
        archived = (it.call(self.ledger, "/v2/events/events-by-contract-id", body).get("archived") or {}).get("archivedEvent")
        offset = archived.get("offset") if isinstance(archived, dict) else None
        if type(offset) is not int:
            return None
        tx = self.update(offset=offset)
        for e in tx.get("events", []):
            ex = e.get("ExercisedEvent")
            if isinstance(ex, dict) and ex.get("contractId") == instruction and ex.get("consuming"):
                result = ex.get("exerciseResult")
                output = result.get("output") if isinstance(result, dict) else None
                return (tx["updateId"], offset) if isinstance(output, dict) and output.get("tag") == COMPLETED else False
        return None

    # ---- one pass

    def poll(self) -> list:
        """One pass over the open Payouts of the gateway: what each needs next. Returns the lines said (each also printed as JSON)."""
        gateway, said = self.settings.gateway, []
        payouts = [p for p in self.ledger.active(PAYOUT) if p.get("gateway") == gateway]
        self.journal.forget({p["payoutId"] for p in payouts})
        self.told = {k for k in self.told if k[0] in {p["payoutId"] for p in payouts}}
        if not payouts:
            return said
        tokens = {t["contractId"]: t for t in self.ledger.active(it.GATEWAY_TOKEN) if t.get("gateway") == gateway}
        live, contexts = self.live(), self.contexts(self.settings.registries, self.settings.registry_tokens)
        for p in sorted(payouts, key=lambda p: p["payoutId"]):
            try:
                line = self.step(p, tokens.get(p["gatewayToken"]), live.get(p["payoutId"], []), contexts)
            except Exception as e:   # one payout's failure (a registry that does not answer, a send the participant refused) never stops the others
                why = b.bounded_text(str(e) if isinstance(e, (RuntimeError, b.NoCantonSide, b.BuilderError)) else f"{type(e).__name__}: {e}")
                if (p["payoutId"], why) not in self.told:
                    self.told.add((p["payoutId"], why))
                    it.say({"waiting": p["payoutId"], "why": why})
                continue
            if line:
                it.say(line)
                said.append(line)
        return said

    def step(self, p: dict, registered, live: list, contexts):
        pid, now = p["payoutId"], self.clock()
        if registered is None:
            raise RuntimeError("the payout's token is not registered with the gateway")
        admin = registered["instrumentId"]["admin"]
        entry = self.journal.entries.get(pid)
        if live:   # the offer is out, or the issuer is working on it: reconcile by the id in its meta, never a second one
            cid, transfer, tag = live[0]
            self.journal.keep(pid, **({} if entry else {"n": 1, "at": now, "command": ""}), state="offered", instruction=cid)
            if tag == it.WAITING and datetime.fromtimestamp(now, timezone.utc) >= b.ledger_time(transfer.get("executeBefore"), "executeBefore"):
                context, disclosed = contexts.withdraw(admin, cid) if contexts.wants(admin) else (None, list(self.ledger.cfg.disclosed))
                it.submit(self.ledger, self.settings.gateway, {"ExerciseCommand": {"templateId": it.TRANSFER_INSTRUCTION, "contractId": cid, "choice": "TransferInstruction_Withdraw",
                                                                                  "choiceArgument": {"extraArgs": {"context": context or EMPTY_CONTEXT, "meta": {"values": {}}}}}}, disclosed)
                return {"withdrawn": pid, "instruction": cid, "why": "the offer lapsed"}
            return None
        if entry is None:
            return self.offer(p, registered, contexts, 0)
        if entry["state"] == "sending":   # the worker stopped, or the answer was lost, between the send and its record: the command's own completion says what happened
            found, _ = self.ledger.completion_and_time(entry["command"], entry["begin"])
            if found and found["committed"] and found["updateId"]:
                return self.sent(p, registered, self.update(updateId=found["updateId"]), entry["factory"])
            if found or (found is None and now > entry["at"] + self.ledger.cfg.resolve_seconds):
                self.journal.keep(pid, state="ended", at=0)   # it did not commit: offered again now
            return None
        if entry["state"] == "offered":   # the instruction is gone: the choice that archived it says how it ended
            ended = self.outcome(entry["instruction"])
            if ended is None:
                return None
            self.journal.keep(pid, **({"state": "completed", "update": ended[0], "offset": ended[1]} if ended else {"state": "ended"}))
            entry = self.journal.entries[pid]
        if entry["state"] == "completed":
            return self.finish(p, registered, entry)
        if now >= entry["at"] + self.lifetime.total_seconds():   # ended: a lapse or a reject is offered again once the offer's time has passed
            return self.offer(p, registered, contexts, entry["n"])
        return None

    # ---- sending, and paying

    def inputs(self, registered: dict, units: int, contexts) -> list:
        """The gateway's holdings that the transfer takes: for an --expiring-instrument by the builder's rules (floor, nearest expiry first, at most the cap, the stop file and the open-round fee check), else the largest first."""
        instrument = registered["instrumentId"]
        held = [h for h in self.ledger.active_holdings() if h["owner"] == self.settings.gateway and h["instrumentId"] == instrument and not h.get("lock") and b.base_units(h["amount"]) is not None]
        cfg = self.ledger.cfg
        if instrument["admin"] in cfg.expiring:
            canton = b.Canton(self.ledger, {}, datetime.now(timezone.utc), expiry=b.ExpiryRules(cfg, contexts))
            return b.expiring_inputs(canton, SimpleNamespace(amount=units), instrument["admin"], held)
        return b.largest_first_inputs(held, units)

    def offer(self, p: dict, registered: dict, contexts, made: int):
        pid, gateway, instrument = p["payoutId"], self.settings.gateway, registered["instrumentId"]
        units = b.base_units(p["amount"])
        if not units:
            raise RuntimeError("the payout's amount is not an amount")
        at = datetime.fromtimestamp(self.clock(), timezone.utc)
        transfer = {"sender": gateway, "receiver": p["party"], "amount": b.canton_amount(units), "instrumentId": instrument, "requestedAt": b.stamp(at - timedelta(minutes=1)),
                    "executeBefore": b.stamp(at + self.lifetime), "inputHoldingCids": self.inputs(registered, units, contexts), "meta": {"values": {WITHDRAWAL_KEY: pid}}}
        if contexts.wants(instrument["admin"]):
            factory, context, disclosed = contexts.transfer_factory(instrument["admin"], transfer)
        else:   # a token with no registry: the factory it was registered with, and the contracts given with --disclosed
            factory, context, disclosed = registered["factory"], None, list(self.ledger.cfg.disclosed)
        command_id = "payout-" + hashlib.sha256(f"{pid}:{made + 1}".encode()).hexdigest()[:32]
        self.journal.keep(pid, n=made + 1, at=self.clock(), command=command_id, begin=self.ledger.end(), factory=factory, state="sending", instruction=None, update=None, offset=None)
        arguments = {"expectedAdmin": instrument["admin"], "transfer": transfer, "extraArgs": {"context": context or EMPTY_CONTEXT, "meta": {"values": {}}}}
        body = {"commands": {"commands": [{"ExerciseCommand": {"templateId": TRANSFER_FACTORY, "contractId": factory, "choice": "TransferFactory_Transfer", "choiceArgument": arguments}}],
                             "commandId": command_id, "userId": self.ledger.cfg.ledger_user, "actAs": [gateway], "readAs": [gateway], **({"disclosedContracts": disclosed} if disclosed else {})},
                "transactionFormat": {"eventFormat": {"filtersByParty": {gateway: EVERYTHING}, "verbose": False}, "transactionShape": "TRANSACTION_SHAPE_LEDGER_EFFECTS"}}
        tx = it.call(self.ledger, "/v2/commands/submit-and-wait-for-transaction", body).get("transaction")
        if not isinstance(tx, dict) or not tx.get("updateId"):
            raise RuntimeError("the ledger gave no transaction for the transfer")
        return self.sent(p, registered, tx, factory)

    def sent(self, p: dict, registered: dict, tx: dict, factory: str):
        """What the transfer's transaction says: pending (an instruction), completed at once, or neither."""
        pid = p["payoutId"]
        output = exercise_output(tx, factory, "TransferFactory_Transfer") or {}
        tag, value = output.get("tag"), output.get("value")
        if tag == PENDING and isinstance(value, dict) and isinstance(value.get("transferInstructionCid"), str):
            self.journal.keep(pid, state="offered", instruction=value["transferInstructionCid"])
            return {"offered": pid, "instruction": value["transferInstructionCid"], "party": p["party"], "amount": p["amount"], "instrument": registered["instrumentId"], "updateId": tx["updateId"]}
        if tag == COMPLETED:
            entry = self.journal.keep(pid, state="completed", update=tx["updateId"], offset=tx.get("offset"))
            return self.finish(p, registered, entry)
        self.journal.keep(pid, state="ended")
        return {"failed": pid, "why": f"the transfer's result is {tag or 'not there'}", "updateId": tx["updateId"]}

    def finish(self, p: dict, registered: dict, entry: dict):
        """The transfer completed: for an --expiring-instrument the custody check of the completing update (it fails closed, and stops the instrument's payouts and withdrawals), then Payout_Paid."""
        pid, gateway, instrument = p["payoutId"], self.settings.gateway, registered["instrumentId"]
        check = None
        if instrument["admin"] in self.ledger.cfg.expiring:
            record = {"commandId": entry["command"] or pid, "gateway": gateway, "number": None, "plan": [{"instrument": instrument, "withdrawn": b.base_units(p["amount"]), "deposits": 0}]}
            check = b.run_custody_check(self.ledger.cfg, record, entry["offset"], entry["update"])
            if check == "pending":
                raise RuntimeError("the custody check of the completed transfer could not be read yet")
        answer = it.submit(self.ledger, gateway, {"ExerciseCommand": {"templateId": PAYOUT, "contractId": p["contractId"], "choice": "Payout_Paid", "choiceArgument": {}}}, [])
        return {"paid": pid, "party": p["party"], "amount": p["amount"], "instrument": instrument, "transferUpdateId": entry["update"], "updateId": answer.get("updateId"),
                **({"custodyCheck": check} if check else {})}
