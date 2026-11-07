import hashlib, sys

ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)

def field(num, wire, payload):
    key = varint((num << 3) | wire)
    return key + (varint(payload) if wire == 0 else varint(len(payload)) + payload)

def b58(data):
    n = int.from_bytes(data, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = ALPHABET[r] + s
    return "1" * (len(data) - len(data.lstrip(b"\0"))) + s

def cidv0(data):
    if len(data) > 262144:
        raise SystemExit("file larger than one 256 KiB chunk")
    unixfs = field(1, 0, 2) + (field(2, 2, data) if data else b"") + field(3, 0, len(data))
    node = field(1, 2, unixfs)
    return b58(b"\x12\x20" + hashlib.sha256(node).digest())

if __name__ == "__main__":
    print(cidv0(open(sys.argv[1], "rb").read()))
