"""Ed25519 signature verification (RFC 8032, section 5.1.7), standard library only. It is slow (milliseconds), and it only checks: it holds no secret."""
import hashlib

P = 2**255 - 19
Q = 2**252 + 27742317777372353535851937790883648493       # the order of the base point
D = -121665 * pow(121666, P - 2, P) % P
SQRT_M1 = pow(2, (P - 1) // 4, P)                          # a square root of -1


def _x(y: int, sign: int):
    """The x of the curve point with this y and this low bit of x, or None when there is none."""
    xx = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    x = pow(xx, (P + 3) // 8, P)
    if (x * x - xx) % P:
        x = x * SQRT_M1 % P
    if (x * x - xx) % P or (x == 0 and sign):
        return None
    return P - x if x & 1 != sign else x


def _add(a, b):
    """Points are in extended coordinates (X, Y, Z, T)."""
    p, q = (a[1] - a[0]) * (b[1] - b[0]) % P, (a[1] + a[0]) * (b[1] + b[0]) % P
    c, d = 2 * a[3] * b[3] * D % P, 2 * a[2] * b[2] % P
    e, f, g, h = q - p, d - c, d + c, q + p
    return e * f % P, g * h % P, f * g % P, e * h % P


def mul(s: int, point):
    out = (0, 1, 1, 0)
    while s:
        if s & 1:
            out = _add(out, point)
        point, s = _add(point, point), s >> 1
    return out


def encode(point) -> bytes:
    zi = pow(point[2], P - 2, P)
    x, y = point[0] * zi % P, point[1] * zi % P
    return (y | ((x & 1) << 255)).to_bytes(32, "little")


def decode(raw: bytes):
    n = int.from_bytes(raw, "little")
    y = n & ((1 << 255) - 1)
    x = _x(y, n >> 255) if y < P else None
    return None if x is None else (x, y, 1, x * y % P)


_BY = 4 * pow(5, P - 2, P) % P
B = (_x(_BY, 0), _BY, 1, _x(_BY, 0) * _BY % P)             # the base point


def verify(public: bytes, message: bytes, signature: bytes) -> bool:
    """Whether `signature` (64 bytes) is `public`'s (32 bytes) signature of `message`: [s]B = R + [h]A, with s below the group order."""
    if len(public) != 32 or len(signature) != 64:
        return False
    a, r, s = decode(public), decode(signature[:32]), int.from_bytes(signature[32:], "little")
    if a is None or r is None or s >= Q:
        return False
    h = int.from_bytes(hashlib.sha512(signature[:32] + public + message).digest(), "little") % Q
    return encode(mul(s, B)) == encode(_add(r, mul(h, a)))
