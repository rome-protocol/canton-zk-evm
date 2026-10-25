# Golden record of the producer at depth 1

One file for each scenario of `../test_golden.py`: `commit`, `refusal`, `not_taken`, `unknown_then_committed`,
`unknown_then_not_committed_by_the_window`, `prover_failure`, `skipped`, `restart_with_a_kept_file`, `restart_with_a_record`.

Each file holds three lists, all from the builder as it is on main when the file is written:

- `calls`: every call the fakes got, in the order they came, whichever fake it was: reth's WebSocket port (`reth`) and Engine port
  (`engine`), the Canton JSON Ledger API (`ledger`: each `submit-and-wait`, `active-contracts` and `completions` request, and each GET,
  such as `/v2/state/ledger-end` or `/traffic`), and the prover's input tool and the prover (`prover`).
- `journal`: the lines the producer wrote to its journal.
- `reports`: the reports it printed.

The test replays the scenario and compares the three lists with the file. Exactly this is left out, and all of it is listed at the top of
`test_golden.py`: the values of the keys `seconds`, `proveSeconds` and `advanceSeconds` (each keeps its place and shows as
`<key>`), the prover's output folder name (`/out-<pid>-<ns>`), and the test's temporary folder (`<dir>`). The wall clock is fixed during a
scenario, so block timestamps, block hashes and command ids are the same on every run and are compared. The two restart scenarios start the
second process through `Producer.run()`, so its `run_started` and `run_stopped` lines and its start sequence are in the record.

## Regenerate

From the repository root, with the builder's requirements installed:

    GOLDEN_REGENERATE=1 python3 -m unittest discover -s builder/tests -p test_golden.py

Then run the whole suite without the variable, and look at `git diff builder/tests/golden` before you commit: every changed line must be
a change you meant to make.

## When a file may change

These files pin what the one-block producer does today. A later change to the builder may alter them only in these ways:

- When the build, prove and submit stages are split, `eth_getProof` is read before the prover instead of after it.
- When two blocks can be prepared at once, the input tool and the prove command get a folder of their own for each attempt, and the kept
  entries carry the block `number`.
- Support for several provers changes nothing in these files, which run with one prover.
- Work that only adds new behaviour beside the one-block path changes nothing in these files.

Any other change in a file means the one-block producer behaves differently, which is a defect to fix in the code, not a reason to regenerate.
