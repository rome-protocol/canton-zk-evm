"""The golden scenarios again, on the engine that keeps several blocks in flight, run at one block in flight: every call to the fakes, in order, and
every journal line and report must be the bytes of the fixtures in golden/, the same ones the single-block producer is held to (`Golden.check`)."""
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import builder as b
import test_golden as tg


class GoldenAtOne(tg.Golden):
    engine = b.Pipeline


if __name__ == "__main__":
    unittest.main()
