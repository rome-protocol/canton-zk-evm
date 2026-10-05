"""Keccak-256 as Ethereum uses it (not the final SHA3-256: the padding byte differs). Python's hashlib has only
the final one, and the builder needs this one to find a balance's storage key and to check a block header's hash."""

_MASK = (1 << 64) - 1


def _rol(x: int, n: int) -> int:
    n %= 64
    return ((x << n) | (x >> (64 - n))) & _MASK if n else x


def _permute(a: list) -> None:
    """Keccak-f[1600] on 25 lanes, a[x + 5 * y]."""
    r = 1
    for _ in range(24):
        c = [a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20] for x in range(5)]
        d = [c[(x + 4) % 5] ^ _rol(c[(x + 1) % 5], 1) for x in range(5)]
        a[:] = [a[i] ^ d[i % 5] for i in range(25)]
        x, y, cur = 1, 0, a[1]
        for t in range(24):
            x, y = y, (2 * x + 3 * y) % 5
            cur, a[x + 5 * y] = a[x + 5 * y], _rol(cur, (t + 1) * (t + 2) // 2)
        for y in range(5):
            row = a[5 * y:5 * y + 5]
            for x in range(5):
                a[x + 5 * y] = row[x] ^ (~row[(x + 1) % 5] & row[(x + 2) % 5])
        for j in range(7):
            r = ((r << 1) ^ ((r >> 7) * 0x71)) % 256
            if r & 2:
                a[0] ^= 1 << ((1 << j) - 1)


def keccak256(data: bytes) -> bytes:
    rate = 136
    padded = bytearray(data) + b"\x01"
    padded += bytes(-len(padded) % rate)
    padded[-1] |= 0x80
    state = [0] * 25
    for off in range(0, len(padded), rate):
        for i in range(rate // 8):
            state[i] ^= int.from_bytes(padded[off + 8 * i:off + 8 * i + 8], "little")
        _permute(state)
    return b"".join(lane.to_bytes(8, "little") for lane in state[:4])
