# build_static.py -- turns the small database (made by slim.py) into plain files a web page can read without any server.
#   python build_static.py database/refs/storage/slim.db docs/data
# Nothing in the .db is changed. The folder it makes (docs/data) goes next to index.html (in docs/) when the page is published
# (GitHub Pages, Netlify, ...). The page looks things up by fetching a few of the small files, never the whole thing.
#
#   data/meta.json      how many pieces there are
#   data/v/NNNN.bin     the vertices: 32 bytes each (six whole numbers, the node, the turn), grouped by a hash of the vertex
#   data/n/K.json       the nodes (one fold step each): K = node id // 256

import json, os, sqlite3, struct, sys, time
from math import gcd, sqrt
from fractions import Fraction as F

if len(sys.argv) != 3:
    sys.exit("usage: python build_static.py <the small database made by slim.py> <output folder, e.g. docs/data>")
src, out = sys.argv[1:]
START = time.time()
SQRT2 = sqrt(2)
NODE_SHIFT = 8                                   # nodes per file: 2**8
TARGET_BYTES = 48 * 1024                         # about this much per vertex file


def say(text=""):
    print(f"[{int(time.time() - START) // 60}:{int(time.time() - START) % 60:02d}] {text}", flush=True)


def hash_key(key):                               # the same in static-refs.js (FNV-1a over the six numbers)
    h = 2166136261
    for v in key:
        h = ((h ^ (v & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
    return h


def read_vertex(blob):                           # six variable-length ints -> (x, y) as floats on [0, 1]
    z, at = [], 0
    for _ in range(6):
        n = int.from_bytes(blob[at:at + 2], "big")
        z.append(int.from_bytes(blob[at + 2:at + 2 + n], "big", signed=True))
        at += 2 + n
    return cartesian(z)


def cartesian(z):                                # [px, qx, dx, py, qy, dy] -> [x, y]
    return [float(F(z[0], z[2])) + float(F(z[1], z[2])) * SQRT2, float(F(z[3], z[5])) + float(F(z[4], z[5])) * SQRT2]


if not os.path.exists(src):
    sys.exit(f"{src} is not there")
con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
if not any(r[1] == "g" for r in con.execute("PRAGMA table_info(vertex_index)")):
    sys.exit("this database was not made by slim.py (it has no 'g' column). Run slim.py first.")
os.makedirs(os.path.join(out, "v"), exist_ok=True)
os.makedirs(os.path.join(out, "n"), exist_ok=True)

# ---- the vertices -------------------------------------------------------------------------------------------
rows = con.execute("SELECT COUNT(*) FROM vertex_index").fetchone()[0]
shards = 16
while rows * 32 / shards > TARGET_BYTES:
    shards *= 2
say(f"{rows:,} vertices -> {shards:,} files of about {rows * 32 / shards / 1024:.0f} KB")
buckets = [[] for _ in range(shards)]
done = 0
for px, qx, dx, py, qy, dy, depth, node, g in con.execute("SELECT px,qx,dx,py,qy,dy,depth,node_id,g FROM vertex_index"):
    key = (px, qx, dx, py, qy, dy)
    if any(abs(v) >= 2 ** 31 for v in key) or node >= 2 ** 31:
        sys.exit(f"a number is too big for the file format: {key}, node {node}. Tell Claude.")
    buckets[hash_key(key) & (shards - 1)].append(struct.pack("<6iIBxxx", *key, node, g))
    done += 1
    if done % 500000 == 0:
        say(f"   read {done:,} of {rows:,}")
size = 0
for i, items in enumerate(buckets):
    data = b"".join(items)
    size += len(data)
    with open(os.path.join(out, "v", f"{i:04x}.bin"), "wb") as f:
        f.write(data)
say(f"   vertex files written: {size / 1e6:.1f} MB in all")

# ---- the nodes ----------------------------------------------------------------------------------------------
say("reading the nodes...")
nodes = {}
for nid, parent, fn, v1, v2, refs in con.execute("SELECT id, parent_id, function_name, new_crease_v1, new_crease_v2, refs FROM nodes"):
    out_refs = []
    for ref in json.loads(refs):
        if ref["type"] == "vertex":
            out_refs.append(["v", cartesian(ref["v"])])
        else:
            out_refs.append(["c", cartesian(ref["v1"]), cartesian(ref["v2"])])
    nodes[nid] = [parent, fn, read_vertex(v1), read_vertex(v2), out_refs]
say(f"   {len(nodes):,} nodes")
files, size = {}, 0
for nid, (parent, fn, a, b, refs) in nodes.items():
    up, cur = [], parent                          # the ancestors, nearest first: the page fetches them all at once
    while cur is not None and cur in nodes:
        up.append(cur)
        cur = nodes[cur][0]
    files.setdefault(nid >> NODE_SHIFT, {})[nid] = [fn, a, b, refs, up]
for k, content in files.items():
    text = json.dumps(content, separators=(",", ":"))
    size += len(text)
    with open(os.path.join(out, "n", f"{k}.json"), "w") as f:
        f.write(text)
say(f"   {len(files):,} node files written: {size / 1e6:.1f} MB in all")

with open(os.path.join(out, "meta.json"), "w") as f:
    json.dump({"format": 1, "vshards": shards, "nshift": NODE_SHIFT, "vertices": rows, "nodes": len(nodes)}, f)
total = sum(os.path.getsize(os.path.join(d, n)) for d, _, names in os.walk(out) for n in names)
say(f"FINISHED. {out} is {total / 1e6:.1f} MB in {sum(len(n) for _, _, n in os.walk(out)):,} files.")