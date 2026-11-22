"""The worker's records (one JSON file for each worker, written whole and then renamed, mode 0600) and its guards: caps by the hour, the day and the recipient, counted from the records, so a restart forgets nothing."""
import json, os, threading, time
from pathlib import Path


class Records:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.lock = threading.RLock()   # the intake's thread and the pass both write
        self.data = json.loads(self.path.read_text()) if self.path.exists() else {"cursor": None, "items": {}}

    def get(self, key: str) -> dict:
        return self.data["items"].get(key, {})

    def put(self, key: str, **fields) -> dict:
        with self.lock:
            item = self.data["items"].setdefault(key, {})
            item.update(fields)
            self.save()
            return item

    def save(self) -> None:
        with self.lock:
            tmp = self.path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(self.data, f)
            os.replace(tmp, self.path)

    def where(self, state: str) -> list:
        return [(k, v) for k, v in list(self.data["items"].items()) if v.get("state") == state]


def whole_setting(name: str, default: int) -> int:
    value = os.environ.get(name, str(default))
    if not value.isdigit():
        raise SystemExit(f"{name} must be a whole number, not {value!r}")
    return int(value)


def over_caps(records: Records, recipient: str, caps: dict, now: float = None) -> "str | None":
    """Why one more send is not allowed, or None. Every record with a send time `at` counts, whatever became of it: a transaction that failed still cost gas. A cap of 0 is no sends."""
    now = time.time() if now is None else now
    sent = [v for v in list(records.data["items"].values()) if v.get("at") is not None]
    day = [v for v in sent if now - v["at"] < 86400]
    if len(day) >= caps["day"]:
        return "the day's cap is reached"
    if sum(1 for v in day if now - v["at"] < 3600) >= caps["hour"]:
        return "the hour's cap is reached"
    if sum(1 for v in day if v.get("recipient") == recipient) >= caps["recipient"]:
        return "the cap for this recipient is reached"
    return None
