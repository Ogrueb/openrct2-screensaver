"""Write TOML (the stdlib only reads it): the subset the project's playlists and park profiles use.

dumps(data, header="") returns the text of a document whose tomllib.loads() equals `data`:
strings, booleans, integers, floats, arrays, tables, arrays of tables and inline tables. Plain
keys come before tables at every level, as TOML needs. A list of tables is written inline (one
`{...}` per line) when each table holds only plain values and fits on a line, else as `[[...]]`.
Comments are not kept: `header` (lines without the leading "# ") goes at the top.

patch(text, data) edits a document in place instead, so its comments and layout stay: values that
changed are replaced on their lines, removed keys and tables lose their lines, and new keys go after
their table's last key (new tables at the end). It returns None when it can't (a change inside an
array of tables, or a result that wouldn't read back as `data`); the caller then writes it anew.

Usage: python3 tools/tomlwrite.py --check FILE...   round-trips each file and reports any change
"""
import math, re, sys, tomllib

BARE_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
INLINE_WIDTH = 100  # longest inline table written on one line in an array


def key(k):
    return k if BARE_KEY.match(k) else string(k)


def string(s):
    out = ['"']
    for ch in s:
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\r":
            out.append("\\r")
        elif ord(ch) < 0x20 or ord(ch) == 0x7F:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def value(v):
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if math.isnan(v):
            return "nan"
        if math.isinf(v):
            return "inf" if v > 0 else "-inf"
        text = repr(v)
        return text if any(c in text for c in ".eE") else text + ".0"
    if isinstance(v, str):
        return string(v)
    if isinstance(v, dict):
        return "{" + ", ".join("%s = %s" % (key(k), value(x)) for k, x in v.items()) + "}" if v else "{}"
    if isinstance(v, (list, tuple)):
        return "[" + ", ".join(value(x) for x in v) + "]"
    raise TypeError("can't write %r as TOML" % (v,))


def flat(d):
    """A table holding no tables or arrays of tables (so it reads well inline)."""
    return all(not isinstance(x, dict) and not (isinstance(x, list) and any(isinstance(y, dict) for y in x))
               for x in d.values())


def table_list(v):
    return isinstance(v, list) and v and all(isinstance(x, dict) for x in v)


def inline_list(v):
    return all(flat(x) and len(value(x)) <= INLINE_WIDTH for x in v)


def table(lines, path, data):
    plain = [(k, v) for k, v in data.items()
             if not isinstance(v, dict) and not (table_list(v) and not inline_list(v))]
    plain_keys = {k for k, _ in plain}
    tables = [(k, v) for k, v in data.items() if k not in plain_keys]
    for k, v in plain:
        if table_list(v):
            lines.append("%s = [" % key(k))
            lines.extend("    %s," % value(x) for x in v)
            lines.append("]")
        else:
            lines.append("%s = %s" % (key(k), value(v)))
    for k, v in tables:
        sub = path + [key(k)]
        if isinstance(v, dict):
            # A table that holds only tables needs no header of its own ([a.b] implies [a])
            if any(not isinstance(x, dict) for x in v.values()) or not v:
                lines.append("")
                lines.append("[%s]" % ".".join(sub))
            table(lines, sub, v)
        else:
            for item in v:
                lines.append("")
                lines.append("[[%s]]" % ".".join(sub))
                table(lines, sub, item)


def dumps(data, header=""):
    lines = ["# " + line if line else "#" for line in header.splitlines()]
    if lines:
        lines.append("")
    table(lines, [], data)
    lines = [line for i, line in enumerate(lines) if line or (i and lines[i - 1])]  # one blank line at most
    while lines and not lines[0]:
        lines.pop(0)
    return "\n".join(lines) + "\n"


# --- editing in place ---

class _Doc:
    """Where each key's value and each table header sits in a document (character offsets)."""

    def __init__(self, text):
        self.text, self.n = text, len(text)
        self.keys = {}     # key path -> (line start, value start, value end, line end after its newline)
        self.tables = {}   # table path -> {"header": (start, end after newline) or None, "last": where a new key goes}
        self.arrays = {}  # path of each array of tables -> its entries so far; an entry's keys and tables
                          # are under path + (index,)
        self.tables[()] = {"header": None, "last": None}
        self.first_header = None
        self.parse()

    def eol(self, i):
        j = self.text.find("\n", i)
        return self.n if j < 0 else j

    def after_line(self, i):
        j = self.eol(i)
        return min(self.n, j + 1)

    def skip_string(self, i):
        t = self.text
        for q in ('"""', "'''"):
            if t.startswith(q, i):
                j = i + 3
                while not t.startswith(q, j):
                    if j >= self.n:
                        raise ValueError("unclosed string")
                    j += 2 if q == '"""' and t[j] == "\\" else 1
                j += 3
                while j < self.n and t[j] == q[0]:
                    j += 1
                return j
        q = t[i]
        j = i + 1
        while t[j] != q:
            if t[j] == "\n":
                raise ValueError("unclosed string")
            j += 2 if q == '"' and t[j] == "\\" else 1
        return j + 1

    def key_path(self, i, stop):
        """A dotted key starting at i, up to a character in `stop`: (parts, index of the stop)."""
        t, parts = self.text, []
        while True:
            while t[i] in " \t":
                i += 1
            if t[i] in "\"'":
                j = self.skip_string(i)
                parts.append(tomllib.loads("k = " + t[i:j])["k"])
            else:
                m = BARE_KEY_RUN.match(t, i)
                if not m:
                    raise ValueError("bad key")
                j = m.end()
                parts.append(m.group())
            i = j
            while t[i] in " \t":
                i += 1
            if t[i] == ".":
                i += 1
                continue
            if t[i] in stop:
                return tuple(parts), i
            raise ValueError("bad key")

    def value_end(self, i):
        t, depth = self.text, 0
        while i < self.n:
            c = t[i]
            if c in "\"'":
                i = self.skip_string(i)
            elif c in "[{":
                depth, i = depth + 1, i + 1
            elif c in "]}":
                depth, i = depth - 1, i + 1
            elif c == "#":
                if not depth:
                    break
                i = self.eol(i)
            elif c == "\n" and not depth:
                break
            else:
                i += 1
        while t[i - 1] in " \t\r":
            i -= 1
        return i

    def parse(self):
        t, i, table = self.text, 0, ()
        while i < self.n:
            line = i
            while i < self.n and t[i] in " \t\r":
                i += 1
            if i >= self.n:
                break
            if t[i] in "#\n":
                i = self.after_line(i)
                continue
            if t[i] == "[":
                array = t.startswith("[[", i)
                path, j = self.key_path(i + (2 if array else 1), "]")
                end = self.after_line(j)
                if self.first_header is None:
                    self.first_header = line
                # Inside an array of tables ([[park]] then [park.views]): under the latest entry
                for k in range(len(path) - (1 if array else 0), 0, -1):
                    if path[:k] in self.arrays:
                        path = path[:k] + (self.arrays[path[:k]] - 1,) + path[k:]
                        break
                if array:
                    self.arrays[path] = self.arrays.get(path, 0) + 1
                    path += (self.arrays[path] - 1,)
                table = path
                self.tables[path] = {"header": (line, end), "last": end}
                i = end
                continue
            path, j = self.key_path(i, "=")
            start = j + 1
            while t[start] in " \t":
                start += 1
            end = self.value_end(start)
            self.keys[table + path] = (line, start, end, self.after_line(end))
            self.tables[table]["last"] = self.after_line(end)
            i = self.after_line(end)


BARE_KEY_RUN = re.compile(r"[A-Za-z0-9_-]+")


def _nest(path, value):
    for k in reversed(path):
        value = {k: value}
    return value


def patch(text, data):
    if not text.endswith("\n"):
        text += "\n"
    try:
        doc = _Doc(text)
        old = tomllib.loads(text)
    except (ValueError, IndexError, tomllib.TOMLDecodeError):
        return None
    edits = []  # (start, end, replacement)
    appended = []

    def under(prefix, path):
        return path[:len(prefix)] == prefix

    def new_table(p, v):
        """A table that isn't there yet: inside an array entry after the entry's keys, else at the end."""
        lines = []
        table(lines, [], _nest(tuple(k for k in p if not isinstance(k, int)), v))
        entry = [i for i, k in enumerate(p) if isinstance(k, int)]
        if entry:
            at = doc.tables[p[:entry[-1] + 1]]["last"]
            edits.append((at, at, "\n".join(lines) + "\n\n"))
        else:
            appended.append("\n".join(lines))

    def remove(path):
        if any(under(path, a) for a in doc.arrays):
            raise LookupError
        for p, (line, _, _, after) in doc.keys.items():
            if under(path, p):
                edits.append((line, after, ""))
        for p, t in doc.tables.items():
            if p and under(path, p) and t["header"]:
                edits.append((t["header"][0], t["header"][1], ""))

    def insert(path, k, v):
        table = doc.tables.get(path)
        line = "%s = %s" % (key(k), value(v))
        if table is None or (not path and table["last"] is None and doc.first_header is not None):
            if not path:  # a first plain key before the first table
                edits.append((doc.first_header, doc.first_header, line + "\n\n"))
                return
            new_table(path, {k: v})
            return
        at = table["last"] if table["last"] is not None else 0
        edits.append((at, at, line + "\n"))

    def same_entries(a, b):
        """The same entries in the same order (so comments stay with theirs): each keeps its first
        key's value and none moved to another place."""
        if len(a) != len(b):
            return False
        for i, (x, y) in enumerate(zip(a, b)):
            first = next(iter(x), None)
            if first is not None and x.get(first) != y.get(first):
                return False
            if x != y and any(y == z for j, z in enumerate(a) if j != i):
                return False
        return True

    def walk(path, a, b):
        for k in a:
            if k not in b:
                remove(path + (k,))
        for k, v in b.items():
            p = path + (k,)
            if k in a:
                if a[k] == v:
                    continue
                if p in doc.keys:
                    _, start, end, _ = doc.keys[p]
                    edits.append((start, end, value(v)))
                elif isinstance(a[k], dict) and isinstance(v, dict):
                    walk(p, a[k], v)
                elif p in doc.arrays and table_list(v) and same_entries(a[k], v):  # each entry edited in place
                    for i, (x, y) in enumerate(zip(a[k], v)):
                        walk(p + (i,), x, y)
                else:
                    raise LookupError
            elif isinstance(v, dict) and p not in doc.keys and not any(under(p, q) for q in doc.keys):
                if v:
                    new_table(p, v)
            elif table_list(v) and not inline_list(v):
                raise LookupError
            else:
                insert(path, k, v)

    try:
        walk((), old, data)
    except LookupError:
        return None
    out = text
    # Back to front; at one place the later edit goes first, so the earlier one ends up in front of it
    for _, (start, end, new) in sorted(enumerate(edits), key=lambda e: (e[1][0], e[1][1], e[0]), reverse=True):
        out = out[:start] + new + out[end:]
    if appended:
        out = out.rstrip("\n") + "\n" + "\n".join(appended) + "\n"
    out = re.sub(r"\n{3,}", "\n\n", out)
    try:
        return out if tomllib.loads(out) == data else None
    except tomllib.TOMLDecodeError:
        return None


def main():
    if len(sys.argv) < 3 or sys.argv[1] != "--check":
        sys.exit(__doc__.strip().splitlines()[-1])
    bad = 0
    for path in sys.argv[2:]:
        with open(path, "rb") as f:
            data = tomllib.load(f)
        again = tomllib.loads(dumps(data))
        print("%s %s" % ("ok  " if again == data else "DIFF", path))
        bad += again != data
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
