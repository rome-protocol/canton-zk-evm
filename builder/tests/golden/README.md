# Golden record of the producer at depth 1

One file for each scenario of `../test_golden.py`: `commit`, `refusal`, `not_taken`, `unknown_then_committed`,
`unknown_then_not_committed_by_the_window`, `prover_failure`, `skipped`, `restart_with_a_kept_file`, `restart_with_a_record`.

Each file holds three lists, all from the builder as it is on main when the file is written:

- `calls`: every call the fakes got, in the order they came, whichever fake it was: reth's WebSocket port (`reth`) and Engine port
  (`engine`), the Canton JSON Ledger API (`ledger`), and the prover's input tool and the prover (`prover`).
- `journal`: the lines the producer wrote to its journal.
- `reports`: the reports it printed.

The test replays the scenario and compares the three lists with the file. Only the fields named in `VOLATILE_KEYS` and
`VOLATILE_PATTERNS` at the top of `test_golden.py` are left out (how long a step took, the prover's output folder name, the test's temporary
folder). The wall clock is fixed during a scenario, so block timestamps, block hashes and command ids are the same on every run and are compared.

## Regenerate

From the repository root, with the builder's requirements installed:

    GOLDEN_REGENERATE=1 python3 -m unittest discover -s builder/tests -p test_golden.py

Then run the whole suite without the variable, and look at `git diff builder/tests/golden` before you commit: every changed line must be
a change you meant to make.

## When a file may change

These files pin what the one-block producer does today. A later slice of the builder pipelining work (design plan section 2.6) may change
them only by what that section lists for the slice:

- S2: `eth_getProof` is read before the prover instead of after it.
- S3: the input tool and the prove command get the attempt's own folder; kept entries carry the block `number`.
- S4 at one prover: nothing.
- S5a, S5b and S6: nothing on the old path.

Any other change in a file means depth 1 behaves differently, which is a defect to fix in the code, not a reason to regenerate.
