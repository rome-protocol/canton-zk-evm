"""The golden scenarios again, on the engine that keeps several blocks in flight, run at one block in flight: every call to the fakes, in order, and
every journal line and report must be the bytes of the fixtures in golden/, the same ones the single-block producer is held to."""
import json, sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_golden as tg


class GoldenAtOne(tg.Golden):
    engine = b.Pipeline

    def check(self, name, s):
        super().check(name, s)   # which entry differs, if any
        if not tg.REGENERATE:   # then the whole record as the fixture is written: the same bytes, not only the same values
            got = json.dumps(self.record(s), indent=1, sort_keys=True) + "\n"
            self.assertEqual(got.encode(), (tg.GOLDEN / f"{name}.json").read_bytes(), f"{name}: the record is not the fixture's bytes")


if __name__ == "__main__":
    unittest.main()
