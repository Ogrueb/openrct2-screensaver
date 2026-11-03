"""Park names and builders from the New Element Designs catalogue (tools/data/nedesigns.json, 4981
parks from the site's public API, crawled 2026-10-30), matched to a download by its name.

Download names follow NE's own zips: YYMMDD-game-builder[-builder...]-park_name (a few are
"<name>-<NE id>"); other names never match. A download matches a park when the park's name, reduced to letters and digits,
ends the download's name part at a word boundary (a trailing version number may be dropped); else a
park released within 2 days with a builder named in the download; else the park's saved name.
Builders named in the download and the release date break ties; a tie left over gives no match.

Usage: python3 tools/nedesigns.py DOWNLOAD...   prints each download's match
"""
import datetime, functools, json, os, re, sys, unicodedata

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "nedesigns.json")


def norm(s):
    s = s.replace("&", " and ").replace("@", " at ")
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", s)


@functools.lru_cache(maxsize=1)
def catalogue():
    """(parks, {id: park}, {normalised name: [parks]})."""
    try:
        with open(DATA, encoding="utf-8") as f:
            parks = json.load(f)["parks"]
    except (OSError, ValueError, KeyError):
        parks = []
    by_name = {}
    for p in parks:
        if norm(p["name"]):
            by_name.setdefault(norm(p["name"]), []).append(p)
    return parks, {p["id"]: p for p in parks}, by_name


def suffixes(name):
    starts = [0] + [m.end() for m in re.finditer(r"[-_]+", name)]
    return {norm(name[i:]) for i in starts} - {""}


def match(download, saved_name=None):
    """The catalogue entry for a download (file or folder name), or None:
    {"id", "name", "url", "released", "builders": [names, largest share first]}."""
    parks, by_id, by_name = catalogue()
    stem = os.path.basename(download.rstrip("/\\"))
    if os.path.splitext(stem)[1].lower() in (".zip", ".park", ".sv6", ".sc6", ".7z", ".rar"):
        stem = os.path.splitext(stem)[0]
    m = re.match(r"^(.*)-(\d{3,5})$", stem)
    if m and not stem[:6].isdigit() and int(m.group(2)) in by_id:
        return entry(by_id[int(m.group(2))])
    parts = stem.split("-")
    try:
        date = datetime.datetime.strptime(parts[0], "%y%m%d").date()
    except ValueError:
        return None  # not named like an NE download: a park of the same name elsewhere is no match
    if len(parts) < 3:
        return None
    name = "-".join(parts[2:])
    tokens = "".join(norm(p) for p in parts[2:])
    cands = [p for k in suffixes(name) for p in by_name.get(k, [])]
    if not cands:
        trimmed = re.sub(r"[-_]\d+$", "", name)  # "leafy-lake-4"
        cands = [p for k in suffixes(trimmed) for p in by_name.get(k, [])]
    if not cands:
        cands = [p for p in parks if p.get("released")
                 and abs((datetime.date.fromisoformat(p["released"]) - date).days) <= 2
                 and any(len(norm(b[0])) >= 3 and norm(b[0]) in tokens for b in p["builders"])]
    if not cands and saved_name:
        cands = list(by_name.get(norm(saved_name), []))
    if not cands:
        return None

    def score(p):
        named = sum(1 for b in p["builders"] if len(norm(b[0])) >= 3 and norm(b[0]) in tokens)
        gap = 9999
        if date and p.get("released"):
            gap = abs((datetime.date.fromisoformat(p["released"]) - date).days)
        return (named, len(norm(p["name"])), -gap)

    cands = sorted({p["id"]: p for p in cands}.values(), key=score, reverse=True)
    if len(cands) > 1 and score(cands[1]) == score(cands[0]):
        return None  # a tie nothing breaks
    return entry(cands[0])


def entry(p):
    return {"id": p["id"], "name": p["name"], "url": "https://www.nedesigns.com/park/" + p["stub"],
            "released": p.get("released"), "builders": [b[0] for b in p["builders"]]}


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__.strip().splitlines()[-1])
    for d in sys.argv[1:]:
        m = match(d)
        print("%-70s %s" % (os.path.basename(d)[:70], "%s by %s" % (m["name"], ", ".join(m["builders"])) if m else "no match"))


if __name__ == "__main__":
    main()
