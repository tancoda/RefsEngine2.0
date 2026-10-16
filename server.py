# server.py -- serves the page (docs/) and answers /refs: for crease-pattern vertices, the shortest folding
# sequence in the reference database. Needs only flask. No engine code: the database is plain sqlite.
#
#   pip install flask        python server.py        ->  http://127.0.0.1:5000/
#   public:  pip install gunicorn flask ;  gunicorn -w 2 -b 127.0.0.1:8000 server:app
#
# The browser sends vertices as exact recipes in page coordinates (the paper is [-1, 1]^2):
# [mx, nx, dx, my, ny, dy] = x = (mx + nx*sqrt2)/dx, y likewise. The database works in [0, 1]^2 and stores
# a vertex as six integers (px, qx, dx, py, qy, dy): x = (px + qx*sqrt2)/dx. A number a + b*sqrt2 is kept
# here as the pair (a, b) of Fractions. Answer: { ok, results: { "<index>": [step, ...] } }, each step
# { function_name, new_crease_v1, new_crease_v2, refs } in [0, 1]^2, the first being the root.

import json, os, sqlite3, threading
from fractions import Fraction as F
from math import gcd, sqrt
from pathlib import Path
from flask import Flask, request, jsonify

ROOT = Path(__file__).parent
DB = os.environ.get("REFS_DB", str(ROOT / "database/refs/storage/cp_pruned.db"))
SQRT2 = sqrt(2)
COORDS = ("px", "qx", "dx", "py", "qy", "dy")

app = Flask(__name__, static_folder="docs", static_url_path="")


@app.after_request
def cors(response):                    # lets the page work when it is opened another way (e.g. VS Code's Live Server)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response


@app.get("/")
def index():
    return app.send_static_file("index.html")


# ---- the database -------------------------------------------------------------------------------------------

def build_index():
    """A lookup is only quick with an index starting with the six numbers. Built once if it is missing (a minute or
    two on a big file; it is saved in the .db, so upload the file with it). A database made by slim.py has one already."""
    try:
        con = sqlite3.connect(DB)
        have = any(tuple(r[2] for r in con.execute(f"PRAGMA index_info({name})"))[:6] == COORDS
                   for _, name, *_ in con.execute("PRAGMA index_list(vertex_index)").fetchall())
        if not have:
            print("refs: building the vertex index (one time only)...", flush=True)
            con.execute("CREATE INDEX IF NOT EXISTS idx_vi_coords_depth ON vertex_index(px,qx,dx,py,qy,dy,depth,node_id)")
            con.commit()
        con.close()
    except sqlite3.Error as err:
        print(f"refs: could not check or build the index ({err})", flush=True)


if os.path.exists(DB):
    build_index()
_local = threading.local()


def conn():
    if not hasattr(_local, "con"):
        _local.con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    return _local.con


# ---- vertices: x = a + b*sqrt2 as (a, b); a point is (x, y) ----------------------------------------------------

def to_z2(c):
    """(a, b) -> (p, q, d) reduced, d > 0: the form the database stores."""
    d = c[0].denominator * c[1].denominator // gcd(c[0].denominator, c[1].denominator)
    p, q = int(c[0] * d), int(c[1] * d)
    if p == 0 and q == 0:
        return (0, 0, 1)
    g = gcd(gcd(abs(p), abs(q)), d)
    return (p // g, q // g, d // g)


def from_z2(p, q, d):
    return (F(p, d), F(q, d))


def cartesian(pt):
    return [float(c[0]) + float(c[1]) * SQRT2 for c in pt]


def read_vertex(blob, at=0):
    """Six variable-length ints (2-byte length, then big-endian signed bytes) -> the point; also the next offset."""
    z = []
    for _ in range(6):
        n = int.from_bytes(blob[at:at + 2], "big")
        z.append(int.from_bytes(blob[at + 2:at + 2 + n], "big", signed=True))
        at += 2 + n
    return (from_z2(*z[:3]), from_z2(*z[3:])), at


# The 8 symmetries of the unit square (where the database looks), and their inverses. 1 - c reflects a number in 1/2.
one_minus = lambda c: (1 - c[0], -c[1])
SYMMETRIES = {                                    # name: (stored -> user, user -> stored); all on (x, y)
    "identity":         (lambda x, y: (x, y),                     lambda x, y: (x, y)),
    "rot90":            (lambda x, y: (one_minus(y), x),          lambda x, y: (y, one_minus(x))),
    "rot180":           (lambda x, y: (one_minus(x), one_minus(y)), lambda x, y: (one_minus(x), one_minus(y))),
    "rot270":           (lambda x, y: (y, one_minus(x)),          lambda x, y: (one_minus(y), x)),
    "reflect_x":        (lambda x, y: (x, one_minus(y)),          lambda x, y: (x, one_minus(y))),
    "reflect_x+rot90":  (lambda x, y: (y, x),                     lambda x, y: (y, x)),
    "reflect_x+rot180": (lambda x, y: (one_minus(x), y),          lambda x, y: (one_minus(x), y)),
    "reflect_x+rot270": (lambda x, y: (one_minus(y), one_minus(x)), lambda x, y: (one_minus(y), one_minus(x))),
}

def sequence(con, node_id, forward):
    """The steps from the root down to node_id, turned into the user's orientation."""
    chain, cur = [], node_id
    while cur is not None:
        row = con.execute("SELECT parent_id, function_name, new_crease_v1, new_crease_v2, refs FROM nodes WHERE id=?",
                          (cur,)).fetchone()
        if row is None:
            break
        chain.append(row)
        cur = row[0]
    steps = []
    for _, fn, v1, v2, refs in reversed(chain):
        out = []
        for ref in json.loads(refs):
            if ref["type"] == "vertex":
                out.append({"type": "vertex", "v": cartesian(forward(*from_pair(ref["v"])))})
            else:
                out.append({"type": "crease", "v1": cartesian(forward(*from_pair(ref["v1"]))),
                            "v2": cartesian(forward(*from_pair(ref["v2"])))})
        steps.append({"function_name": fn, "new_crease_v1": cartesian(forward(*read_vertex(v1)[0])),
                      "new_crease_v2": cartesian(forward(*read_vertex(v2)[0])), "refs": out})
    return steps


def from_pair(z):                                 # [px, qx, dx, py, qy, dy] -> (x, y)
    return from_z2(*z[:3]), from_z2(*z[3:])


def images(z):
    """The 8 copies of a vertex (p, q, d, P, Q, D) in the order of SYMMETRIES (user -> stored). 1 - x is (d - p, -q, d)."""
    X, Y = z[:3], z[3:]
    om = lambda t: (t[2] - t[0], -t[1], t[2])
    return [X + Y, Y + om(X), om(X) + om(Y), om(Y) + X, X + om(Y), Y + X, om(X) + Y, om(Y) + om(X)]


COLUMNS = ("SELECT depth, node_id{} FROM vertex_index WHERE px=? AND qx=? AND dx=? AND py=? AND qy=? AND dy=? "
           "ORDER BY depth, node_id LIMIT 1")


def lookup(rows):
    """rows: page recipes. For each vertex the shallowest node holding it or one of its 7 rotated / mirrored copies."""
    con, out = conn(), {}
    symmetric = any(r[1] == "g" for r in con.execute("PRAGMA table_info(vertex_index)"))   # made by slim.py: one row per set of 8 copies
    forwards = [f for f, _ in SYMMETRIES.values()]
    inverses = [i for _, i in SYMMETRIES.values()]
    for i, (mx, nx, dx, my, ny, dy) in enumerate(rows):
        user = ((F(mx + dx, 2 * dx), F(nx, 2 * dx)), (F(my + dy, 2 * dy), F(ny, 2 * dy)))   # page [-1,1] -> [0,1]
        z = to_z2_pair(user)
        if symmetric:                                  # the stored copy is the smallest of the 8; g says how it was turned
            copies = images(z)
            key = min(copies)
            h = copies.index(key)
            hit = con.execute(COLUMNS.format(", g"), key).fetchone()
            if hit:
                out[str(i)] = sequence(con, hit[1], lambda x, y, g=hit[2]: forwards[h](*inverses[g](x, y)))
            continue
        best = None
        for k, key in enumerate(images(z)):
            hit = con.execute(COLUMNS.format(""), key).fetchone()
            if hit and (best is None or hit < best[0]):
                best = (hit, k)
        if best:
            out[str(i)] = sequence(con, best[0][1], forwards[best[1]])
    return out


def to_z2_pair(pt):
    return to_z2(pt[0]) + to_z2(pt[1])


@app.post("/refs")
def refs():
    try:
        if not os.path.exists(DB):
            raise FileNotFoundError("the reference database is not on this server")
        return jsonify({"ok": True, "results": lookup(request.get_json()["vertices"])})
    except Exception as err:
        return jsonify({"ok": False, "problems": [f"{type(err).__name__}: {err}"]}), 400


if __name__ == "__main__":
    app.run(port=5000)