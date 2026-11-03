"""Zstandard decompression for parks saved by OpenRCT2 v0.5.x, which compresses with zstd.

decompress(data) uses Python's own zstd module (3.14+), the zstandard package or the zstd
command when one is there, and otherwise a decoder written here in plain Python (RFC 8878,
frames without dictionaries), which is slower (seconds for a large park) but needs nothing else.

Usage: python3 tools/unzstd.py <in.zst> <out>
"""
import shutil, subprocess, sys

FRAME_MAGIC = 0xFD2FB528

# Literal length and match length codes: (baseline, extra bits).
LL_CODES = [(i, 0) for i in range(16)] + [
    (16, 1), (18, 1), (20, 1), (22, 1), (24, 2), (28, 2), (32, 3), (40, 3), (48, 4), (64, 6), (128, 7),
    (256, 8), (512, 9), (1024, 10), (2048, 11), (4096, 12), (8192, 13), (16384, 14), (32768, 15), (65536, 16)]
ML_CODES = [(i + 3, 0) for i in range(32)] + [
    (35, 1), (37, 1), (39, 1), (41, 1), (43, 2), (47, 2), (51, 3), (59, 3), (67, 4), (83, 4), (99, 5),
    (131, 7), (259, 8), (515, 9), (1027, 10), (2051, 11), (4099, 12), (8195, 13), (16387, 14), (32771, 15),
    (65539, 16)]
# Predefined distributions (accuracy logs 6, 5, 6).
LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1,
              -1, -1, -1, -1]
OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1]
ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2] + [1] * 37 + [-1] * 7


class ZstdError(ValueError):
    pass


def decompress(data):
    """The decompressed bytes of one or more zstd frames."""
    try:
        from compression import zstd
        return zstd.decompress(data)
    except ImportError:
        pass
    try:
        import zstandard
        return zstandard.ZstdDecompressor().decompressobj().decompress(data)
    except ImportError:
        pass
    exe = shutil.which("zstd")
    if exe:
        result = subprocess.run([exe, "-d", "-c", "-q"], input=data, capture_output=True,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode == 0:
            return result.stdout
    return decode(data)


class BackBits:
    """A bitstream read backwards, from the marker bit in its last byte towards its first bit.
    Bits past the start read as zeros; `overflow` tells whether more were read than it holds."""

    def __init__(self, data, start, end):
        if end <= start or data[end - 1] == 0:
            raise ZstdError("corrupt bitstream")
        self.d, self.start = data, start
        self.pos = (end - start - 1) * 8 + data[end - 1].bit_length() - 1

    def read(self, n):
        if not n:
            return 0
        self.pos -= n
        pos = self.pos
        if pos >= 0:
            lo = self.start + (pos >> 3)
            return (int.from_bytes(self.d[lo:self.start + ((pos + n + 7) >> 3)], "little") >> (pos & 7)) & ((1 << n) - 1)
        have = pos + n
        if have <= 0:
            return 0
        v = int.from_bytes(self.d[self.start:self.start + ((have + 7) >> 3)], "little") & ((1 << have) - 1)
        return v << -pos

    def overflow(self):
        return self.pos < 0


def read_fse_table(data, p, max_log, max_symbol):
    """An FSE table description at data[p]: (normalised counts, accuracy log, bytes used)."""
    bits = int.from_bytes(data[p:p + 512], "little")
    pos = 4
    log = (bits & 15) + 5
    if log > max_log:
        raise ZstdError("FSE accuracy log too large")
    remaining = (1 << log) + 1
    threshold = 1 << log
    nbits = log + 1
    counts = []
    previous0 = False
    while remaining > 1 and len(counts) <= max_symbol:
        if previous0:
            n0 = len(counts)
            while (bits >> pos) & 0xFFFF == 0xFFFF:
                n0 += 24
                pos += 16
            while (bits >> pos) & 3 == 3:
                n0 += 3
                pos += 2
            n0 += (bits >> pos) & 3
            pos += 2
            counts += [0] * (n0 - len(counts))
            if len(counts) > max_symbol:
                break
        biggest = 2 * threshold - 1 - remaining
        v = (bits >> pos) & (threshold - 1)
        if v < biggest:
            pos += nbits - 1
        else:
            v = (bits >> pos) & (2 * threshold - 1)
            if v >= threshold:
                v -= biggest
            pos += nbits
        v -= 1
        remaining -= -v if v < 0 else v
        counts.append(v)
        previous0 = v == 0
        while remaining < threshold:
            nbits -= 1
            threshold >>= 1
    if remaining != 1 or len(counts) > max_symbol + 1:
        raise ZstdError("corrupt FSE table description")
    return counts, log, (pos + 7) >> 3


def fse_decode_table(counts, log):
    """Decoding table as a list of (symbol, bits to read, base of next state)."""
    size = 1 << log
    symbols = [0] * size
    high = size - 1
    following = []
    for s, c in enumerate(counts):
        if c == -1:
            symbols[high] = s
            high -= 1
            following.append(1)
        else:
            following.append(c)
    step = (size >> 1) + (size >> 3) + 3
    mask = size - 1
    pos = 0
    for s, c in enumerate(counts):
        for _ in range(c if c > 0 else 0):
            symbols[pos] = s
            pos = (pos + step) & mask
            while pos > high:
                pos = (pos + step) & mask
    table = []
    for s in symbols:
        nxt = following[s]
        following[s] += 1
        nb = log - (nxt.bit_length() - 1)
        table.append((s, nb, (nxt << nb) - size))
    return table


def huffman_table(data, p):
    """A Huffman tree description at data[p]: (decoding table indexed by the next max-bits bits,
    as (symbol, bits), max bits, bytes used)."""
    head = data[p]
    if head < 128:
        counts, log, used = read_fse_table(data, p + 1, 6, 255)
        table = fse_decode_table(counts, log)
        bits = BackBits(data, p + 1 + used, p + 1 + head)
        s1, s2 = bits.read(log), bits.read(log)
        weights = []
        while True:
            sym, nb, base = table[s1]
            weights.append(sym)
            s1 = base + bits.read(nb)
            if bits.overflow():
                weights.append(table[s2][0])
                break
            sym, nb, base = table[s2]
            weights.append(sym)
            s2 = base + bits.read(nb)
            if bits.overflow():
                weights.append(table[s1][0])
                break
        size = 1 + head
    else:
        n = head - 127
        weights = []
        for i in range(n):
            b = data[p + 1 + i // 2]
            weights.append(b >> 4 if i % 2 == 0 else b & 15)
        size = 1 + (n + 1) // 2
    total = sum(1 << (w - 1) for w in weights if w)
    max_bits = total.bit_length()
    rest = (1 << max_bits) - total
    if rest & (rest - 1):
        raise ZstdError("corrupt Huffman weights")
    weights.append(rest.bit_length())
    table = []
    for w in range(1, max(weights) + 1):
        for s, sw in enumerate(weights):
            if sw == w:
                table += [(s, max_bits + 1 - w)] * (1 << (w - 1))
    return table, max_bits, size


def huffman_stream(data, start, end, table, max_bits, n, out):
    """Decode n literals from the Huffman stream data[start:end] onto out."""
    if end <= start or data[end - 1] == 0:
        raise ZstdError("corrupt Huffman stream")
    p = end - 1
    acc = data[p]
    have = acc.bit_length() - 1
    acc &= (1 << have) - 1
    mask = (1 << max_bits) - 1
    syms = bytes(s for s, _ in table)
    lens = bytes(b for _, b in table)
    for _ in range(n):
        if have < max_bits:
            take = min(7, p - start)
            if take:
                acc = (acc << (8 * take)) | int.from_bytes(data[p - take:p][::-1], "big")
                p -= take
                have += 8 * take
            if have < max_bits:
                acc <<= max_bits - have
                have = max_bits
        i = (acc >> (have - max_bits)) & mask
        out.append(syms[i])
        have -= lens[i]
        acc &= (1 << have) - 1


class Frame:
    def __init__(self):
        self.huffman = None
        self.tables = [None, None, None]
        self.rep = [1, 4, 8]


def literals(data, p, frame):
    """The literals section at data[p]: (literals, bytes used)."""
    b0 = data[p]
    kind, fmt = b0 & 3, (b0 >> 2) & 3
    if kind < 2:
        if fmt in (0, 2):
            n, head = b0 >> 3, 1
        elif fmt == 1:
            n, head = (b0 >> 4) + (data[p + 1] << 4), 2
        else:
            n, head = (b0 >> 4) + (data[p + 1] << 4) + (data[p + 2] << 12), 3
        if kind == 0:
            return data[p + head:p + head + n], head + n
        return bytes([data[p + head]]) * n, head + 1
    if fmt < 2:
        v = int.from_bytes(data[p:p + 3], "little")
        n, csize, head, streams = (v >> 4) & 0x3FF, (v >> 14) & 0x3FF, 3, 1 if fmt == 0 else 4
    elif fmt == 2:
        v = int.from_bytes(data[p:p + 4], "little")
        n, csize, head, streams = (v >> 4) & 0x3FFF, (v >> 18) & 0x3FFF, 4, 4
    else:
        v = int.from_bytes(data[p:p + 5], "little")
        n, csize, head, streams = (v >> 4) & 0x3FFFF, (v >> 22) & 0x3FFFF, 5, 4
    q = p + head
    end = q + csize
    if kind == 2:
        table, max_bits, used = huffman_table(data, q)
        frame.huffman = (table, max_bits)
        q += used
    elif frame.huffman is None:
        raise ZstdError("treeless literals without a previous Huffman table")
    table, max_bits = frame.huffman
    out = bytearray()
    if streams == 1:
        huffman_stream(data, q, end, table, max_bits, n, out)
    else:
        sizes = [int.from_bytes(data[q + 2 * i:q + 2 * i + 2], "little") for i in range(3)]
        q += 6
        sizes.append(end - q - sum(sizes))
        each = (n + 3) // 4
        for i, s in enumerate(sizes):
            huffman_stream(data, q, q + s, table, max_bits, each if i < 3 else n - 3 * each, out)
            q += s
    return bytes(out), head + csize


def sequence_table(data, p, mode, which, frame):
    """A sequence code table (literal lengths 0, offsets 1, match lengths 2): (table, log, bytes used)."""
    if mode == 0:
        counts, log = ((LL_DEFAULT, 6), (OF_DEFAULT, 5), (ML_DEFAULT, 6))[which]
        result = (fse_decode_table(counts, log), log)
        used = 0
    elif mode == 1:
        result = ([(data[p], 0, 0)], 0)
        used = 1
    elif mode == 2:
        counts, log, used = read_fse_table(data, p, (9, 8, 9)[which], (35, 31, 52)[which])
        result = (fse_decode_table(counts, log), log)
    else:
        if frame.tables[which] is None:
            raise ZstdError("repeated sequence table without a previous one")
        return frame.tables[which] + (0,)
    frame.tables[which] = result
    return result + (used,)


def block(data, p, end, frame, out):
    """Decode the compressed block data[p:end] onto out."""
    lits, used = literals(data, p, frame)
    p += used
    b0 = data[p]
    if b0 == 0:
        out += lits
        return
    if b0 < 128:
        count, p = b0, p + 1
    elif b0 < 255:
        count, p = ((b0 - 128) << 8) + data[p + 1], p + 2
    else:
        count, p = data[p + 1] + (data[p + 2] << 8) + 0x7F00, p + 3
    modes = data[p]
    p += 1
    ll_table, ll_log, used = sequence_table(data, p, modes >> 6, 0, frame)
    p += used
    of_table, of_log, used = sequence_table(data, p, (modes >> 4) & 3, 1, frame)
    p += used
    ml_table, ml_log, used = sequence_table(data, p, (modes >> 2) & 3, 2, frame)
    p += used
    bits = BackBits(data, p, end)
    read = bits.read
    ll, of, ml = read(ll_log), read(of_log), read(ml_log)
    rep = frame.rep
    lit = 0
    for k in range(count):
        ll_sym, ll_nb, ll_base = ll_table[ll]
        of_sym, of_nb, of_base = of_table[of]
        ml_sym, ml_nb, ml_base = ml_table[ml]
        offset = (1 << of_sym) + read(of_sym)
        mbase, mbits = ML_CODES[ml_sym]
        match = mbase + read(mbits)
        lbase, lbits = LL_CODES[ll_sym]
        length = lbase + read(lbits)
        if offset > 3:
            offset -= 3
            rep[2], rep[1], rep[0] = rep[1], rep[0], offset
        else:
            if length == 0:
                offset += 1
            if offset == 1:
                offset = rep[0]
            elif offset == 2:
                offset = rep[1]
                rep[1], rep[0] = rep[0], offset
            elif offset == 3:
                offset = rep[2]
                rep[2], rep[1], rep[0] = rep[1], rep[0], offset
            else:
                offset = rep[0] - 1
                if offset < 1:
                    raise ZstdError("corrupt repeat offset")
                rep[2], rep[1], rep[0] = rep[1], rep[0], offset
        if k + 1 < count:
            ll = ll_base + read(ll_nb)
            ml = ml_base + read(ml_nb)
            of = of_base + read(of_nb)
        if length:
            out += lits[lit:lit + length]
            lit += length
        start = len(out) - offset
        if start < 0:
            raise ZstdError("match offset before the start of the frame")
        if offset >= match:
            out += out[start:start + match]
        else:
            pattern = out[start:]
            out += (pattern * (match // offset + 1))[:match]
    if bits.pos != 0:
        raise ZstdError("corrupt sequence bitstream")
    out += lits[lit:]


def decode(data):
    """Pure-Python decompression of one or more zstd frames (skippable frames are skipped)."""
    data = bytes(data)
    result = bytearray()
    p = 0
    while p < len(data):
        magic = int.from_bytes(data[p:p + 4], "little")
        if magic & 0xFFFFFFF0 == 0x184D2A50:
            p += 8 + int.from_bytes(data[p + 4:p + 8], "little")
            continue
        if magic != FRAME_MAGIC:
            raise ZstdError("not a zstd frame")
        fhd = data[p + 4]
        p += 5
        single = (fhd >> 5) & 1
        if fhd & 8:
            raise ZstdError("reserved frame header bit set")
        p += 0 if single else 1  # window descriptor: the whole output is kept, so not needed
        if fhd & 3:
            if int.from_bytes(data[p:p + (1, 2, 4)[(fhd & 3) - 1]], "little"):
                raise ZstdError("zstd dictionaries are not supported")
            p += (1, 2, 4)[(fhd & 3) - 1]
        p += (1 if single else 0, 2, 4, 8)[fhd >> 6]
        frame = Frame()
        out = bytearray()
        while True:
            head = int.from_bytes(data[p:p + 3], "little")
            p += 3
            last, kind, size = head & 1, (head >> 1) & 3, head >> 3
            if kind == 0:
                out += data[p:p + size]
                p += size
            elif kind == 1:
                out += bytes([data[p]]) * size
                p += 1
            elif kind == 2:
                block(data, p, p + size, frame, out)
                p += size
            else:
                raise ZstdError("reserved block type")
            if last:
                break
        if fhd & 4:
            p += 4  # content checksum (XXH64), not checked
        result += out
    return bytes(result)


if __name__ == "__main__":
    with open(sys.argv[1], "rb") as f:
        raw = f.read()
    with open(sys.argv[2], "wb") as f:
        f.write(decode(raw))
