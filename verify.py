# verify.py -- proves the small database gives the same answers as the big one.
#   python verify.py database/refs/storage/cp_pruned.db database/refs/storage/slim.db
# It takes random vertices from the big database (plus rotated / mirrored copies of them, and some that are not in it),
# asks both files for their folding sequences, and compares every number. Both files are only read.

import json, os, random, sqlite3, sys

if len(sys.argv) != 3:
    sys.exit("usage: python verify.py <the big database> <the small database>")
big, small = sys.argv[1:]
os.environ["REFS_DB"] = small                        # (before server.py is loaded, so it leaves the big one alone)
import server

N = int(os.environ.get("VERIFY_COUNT", 3000))
con = sqlite3.connect(f"file:{big}?mode=ro", uri=True)
print(f"taking {N:,} random vertices from {big}...", flush=True)
try:
    top = con.execute("SELECT MAX(rowid) FROM vertex_index").fetchone()[0]
    picked = []
    while len(picked) < N:
        picked += con.execute("SELECT px,qx,dx,py,qy,dy FROM vertex_index WHERE rowid = ?", (random.randint(1, top),)).fetchall()
except sqlite3.Error:                                               # (a table without row numbers: the first ones then)
    picked = con.execute("SELECT px,qx,dx,py,qy,dy FROM vertex_index LIMIT ?", (N,)).fetchall()
rows = [[2 * p - d, 2 * q, d, 2 * P - D, 2 * Q, D] for p, q, d, P, Q, D in picked]    # the page's recipe: [-1, 1] coordinates
tests = list(rows)
for mx, nx, dx, my, ny, dy in rows[:N // 3]:                        # the same vertices turned and mirrored
    tests += [[-my, -ny, dy, mx, nx, dx], [mx, nx, dx, -my, -ny, dy], [-mx, -nx, dx, -my, -ny, dy]]
tests += [[random.randint(-9, 9), random.randint(-9, 9), 10, random.randint(-9, 9), random.randint(-9, 9), 10] for _ in range(300)]
print(f"{len(tests):,} questions in all (the vertices, turned copies of some, and 300 that are probably not in it)", flush=True)

def ask(db):
    server.DB = db
    if hasattr(server._local, "con"):
        server._local.con.close()
        del server._local.con
    print(f"asking {db}...", flush=True)
    return json.loads(json.dumps(server.lookup(tests)))

def same(a, b):
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, float):
        return abs(a - b) < 1e-12
    return a == b

a, b = ask(big), ask(small)
wrong = sorted((k for k in set(a) | set(b) if k not in a or k not in b or not same(a[k], b[k])), key=int)
print(f"\nbig file found {len(a):,}, small file found {len(b):,}")

# a difference is HARMLESS if the small file's answer is the big file's answer turned / mirrored (same steps, same order)
SQUARE = [lambda x, y: (x, y), lambda x, y: (1 - y, x), lambda x, y: (1 - x, 1 - y), lambda x, y: (y, 1 - x),
          lambda x, y: (1 - x, y), lambda x, y: (1 - y, 1 - x), lambda x, y: (x, 1 - y), lambda x, y: (y, x)]
def moved(seq, f):
    out = []
    for st in seq:
        st = json.loads(json.dumps(st))
        for key in ("new_crease_v1", "new_crease_v2"):
            if st.get(key) is not None: st[key] = list(f(*st[key]))
        for r in st.get("refs", []):
            for key in ("v", "v1", "v2"):
                if key in r: r[key] = list(f(*r[key]))
        out.append(st)
    return out
def sort_ends(seq):                                  # a crease has no direction: put its two ends in a fixed order
    for st in seq:
        if st.get("new_crease_v1") is not None and st["new_crease_v1"] > st["new_crease_v2"]:
            st["new_crease_v1"], st["new_crease_v2"] = st["new_crease_v2"], st["new_crease_v1"]
        for r in st.get("refs", []):
            if "v1" in r and r["v1"] > r["v2"]: r["v1"], r["v2"] = r["v2"], r["v1"]
        st["refs"] = sorted(st.get("refs", []), key=json.dumps)
    return seq
def harmless(x, y):
    return any(same(sort_ends(moved(x, f)), sort_ends(json.loads(json.dumps(y)))) for f in SQUARE)

missing = [k for k in wrong if k not in a or k not in b]
turned = [k for k in wrong if k in a and k in b and harmless(a[k], b[k])]
real = [k for k in wrong if k in a and k in b and k not in turned]
if wrong:
    print(f"{len(wrong)} answers are not the same letter for letter:")
    print(f"   {len(turned)} only turned / mirrored the other way round (the same folds, harmless)")
    print(f"   {len(real)} really different")
    print(f"   {len(missing)} found by only one of the two files")
    def show(k):
        print(f"\n--- question {k}: {tests[int(k)]} ---")
        for name, ans in (("big", a.get(k)), ("small", b.get(k))):
            print(f"  {name}: " + ("(nothing)" if ans is None else f"{len(ans)} steps: " + ", ".join(st['function_name'] for st in ans)))
            if ans:
                print("        creases: " + "  ".join(f"({st['new_crease_v1']}->{st['new_crease_v2']})" for st in ans[1:3]))
    for group in (real[:2], missing[:2], turned[:1]):
        for k in group: show(k)
    if real or missing:
        sys.exit(1)
    print("\nevery difference is only an equal orientation of the same folds. The small file is good.")
    sys.exit(0)
print("every answer is identical. The small file is good.")
