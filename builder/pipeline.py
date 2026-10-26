"""Blocks in flight when the producer keeps more than one at a time: what each one is, and when another may be cut. See README.md,
"Provers". Nothing here touches reth, Canton or the journal: `Pipeline` in builder.py does, and asks this module the questions."""
from dataclasses import dataclass, field

# The states of a block in flight, from the cut to the end.
BUILT = "built"          # reth built it and made it its head; the transactions are on disk
PROVING = "proving"      # on a prover
PROVEN = "proven"        # the proof commits to this block's hash
SUBMITTING = "submitting"   # the Advance is being sent
FAILED = "failed"        # the input tool or the prover failed, or the Advance could not be sent: it is handled when it is the oldest
STATES = (BUILT, PROVING, PROVEN, SUBMITTING, FAILED)


@dataclass
class InFlight:
    """One block that is built and not yet final, and what is needed to go on with it."""
    attempt: object                  # the Attempt whose journal lines this block writes
    built: object                    # the build stage's answer
    pairs: list                      # the (hash, raw transaction) pairs reth took from its pool for it
    state: str = BUILT
    proving: object = None           # the prove stage's handle while it runs
    proven: object = None
    error: Exception | None = None   # why it is FAILED
    exclude: set = field(default_factory=set)
    on_tip: bool = False             # it was built on a block in flight, so the chain contract it names is read again when it is submitted

    @property
    def number(self) -> int:
        return self.built.n

    @property
    def hash(self) -> str:
        return self.built.block_hash


def free_provers(in_flight: list, provers: int) -> int:
    """How many provers have no block on them. A block that is built but not dispatched yet counts as on one."""
    return max(0, provers - sum(1 for b in in_flight if b.state in (BUILT, PROVING)))


def why_not_cut(max_in_flight: int, in_flight: list, provers: int, any_up: bool = True, in_doubt: bool = False) -> str | None:
    """Why no block is cut now, or None when one may be. A block is cut only when fewer than `max_in_flight` are in flight, a prover is up and
    free, no command is in doubt and no block in flight has failed: the block goes straight to a prover, and the EVM is never more than
    `max_in_flight` blocks ahead of Canton."""
    if len(in_flight) >= max_in_flight:
        return "the most blocks are in flight"
    if in_doubt:
        return "a command is in doubt"
    if any(b.state == FAILED for b in in_flight):
        return "a block in flight has failed"
    if not any_up:
        return "no prover is up"
    if not free_provers(in_flight, provers):
        return "no prover is free"
    return None
