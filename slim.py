# slim.py -- makes a much smaller copy of the reference database that gives the same answers to server.py.
# Run once:   python slim.py database/refs/storage/cp_pruned.db database/refs/storage/slim.db
# Your original file is only read, never changed. Then run the server with the small one (set REFS_DB, or rename it).
# It talks all the way through (and keeps a copy of everything it says in slim.log next to the new file).
# Stop it any time with Ctrl+C: it deletes the half-made copy, and you can simply start again.
#
# What it keeps: for every vertex, only the shallowest node holding it (a lookup only ever asks for that one), and only
# the nodes on the way from the root to those nodes. Also: a vertex and its 7 rotated / mirrored copies are one entry
# (the smallest copy is stored, with a note of how it was turned), so the lookup is one search instead of eight.
# What it drops: the stored copy of the whole crease pattern of every node (vertices_blob / edges_blob) and
# everything else the lookup never reads.

import glob, os, random, shutil, sqlite3, sys, tempfile, time

if len(sys.argv) != 3:
    sys.exit("usage: python slim.py <the big database> <the new small database>")
src, dst = sys.argv[1], sys.argv[2]
if not os.path.exists(src):
    sys.exit(f"{src} not found")
if os.path.exists(dst):
    sys.exit(f"{dst} already exists: delete it first, or pick another name")

START = time.time()
BEAT = float(os.environ.get("SLIM_BEAT", 10))        # seconds between "still working" lines
LOG = open(os.path.splitext(dst)[0] + ".log", "a", encoding="utf-8")


def clock(seconds=None):
    s = int((time.time() - START) if seconds is None else seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}"

def say(text=""):
    line = f"[{clock()}] {text}" if text else ""
    print(line, flush=True)
    LOG.write(line + "\n")
    LOG.flush()

def mb(path_or_bytes):
    n = path_or_bytes if isinstance(path_or_bytes, (int, float)) else (os.path.getsize(path_or_bytes) if os.path.exists(path_or_bytes) else 0)
    return f"{n / 1e9:.2f} GB" if n >= 1e9 else f"{n / 1e6:,.0f} MB"

def temp_bytes():                                    # sqlite's scratch files while it sorts and groups
    return sum(os.path.getsize(p) for p in glob.glob(os.path.join(tempfile.gettempdir(), "etilqs_*")) if os.path.exists(p))

def free_disk(where=None):
    return shutil.disk_usage(where or os.path.dirname(os.path.abspath(dst))).free


# ---- start ---------------------------------------------------------------------------------------------------------
say(f"original: {src} ({mb(src)})")
say(f"new file: {dst}")
say(f"free disk space where the new file goes: {mb(free_disk())}")
say(f"sqlite's scratch files (for sorting) go to {tempfile.gettempdir()}, free space there: {mb(free_disk(tempfile.gettempdir()))}")
say("   (about as much free as the original's size, in each place, is a safe amount)")
if min(free_disk(), free_disk(tempfile.gettempdir())) < os.path.getsize(src):
    say("WARNING: less free space than the original's size somewhere. It may still fit; if a disk fills up it stops with an error and nothing is harmed.")

con = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
con.execute("ATTACH ? AS s", (dst,))
KEY = "px,qx,dx,py,qy,dy"
B = 4294967296                                       # depth * B + node_id: the smaller, the shallower

# While sqlite works on one big statement we hear nothing from it by itself: this makes it report every few seconds.
label, last_beat = "", [time.time()]
def heartbeat():
    if time.time() - last_beat[0] >= BEAT:
        last_beat[0] = time.time()
        say(f"   ... still working on: {label}   (new file {mb(dst)}, scratch files {mb(temp_bytes())}, free disk {mb(free_disk())} / scratch drive {mb(free_disk(tempfile.gettempdir()))})")
    return 0
con.set_progress_handler(heartbeat, 100000)

def step(text, sql, note=""):
    global label
    label = text.strip()
    say(f"{text}  {note}")
    began = time.time()
    con.execute(sql)
    con.commit()
    say(f"   done in {clock(time.time() - began)}")

def copies(z):                                       # the 8 copies of a vertex; same order as server.py (1 - x is (d - p, -q, d))
    p, q, d, P, Q, D = z
    X, Y = (p, q, d), (P, Q, D)
    om = lambda t: (t[2] - t[0], -t[1], t[2])
    return [X + Y, Y + om(X), om(X) + om(Y), om(Y) + X, X + om(Y), Y + X, om(X) + Y, om(Y) + om(X)]


def main():
    global label
    label = "counting the rows"
    say("counting what is in the original (can take a minute on a big file)...")
    n_vertices = con.execute("SELECT COUNT(*) FROM main.vertex_index").fetchone()[0]
    n_nodes = con.execute("SELECT COUNT(*) FROM main.nodes").fetchone()[0]
    say(f"   {n_vertices:,} vertex entries, {n_nodes:,} nodes")
    say()

    step("STEP 1 of 4: each vertex once (keeping its shallowest node)", f"""
        CREATE TEMP TABLE once AS SELECT {KEY}, MIN(depth * {B} + node_id) AS m FROM main.vertex_index GROUP BY {KEY}""",
         "(the long quiet one: sqlite sorts everything)")
    total = con.execute("SELECT COUNT(*) FROM once").fetchone()[0]
    say(f"   {total:,} different vertices ({n_vertices / max(total, 1):.1f}x fewer than {n_vertices:,})")
    say()

    say(f"STEP 2 of 4: turning every vertex into its smallest rotated / mirrored copy")
    label = "step 2"
    con.execute(f"CREATE TEMP TABLE turned({KEY}, m, mask)")
    cursor, done, began, last = con.execute(f"SELECT {KEY}, m FROM once"), 0, time.time(), time.time()
    while True:
        batch = cursor.fetchmany(100000)
        if not batch:
            break
        rows = []
        for *z, m in batch:
            c = copies(z)
            smallest = min(c)
            mask = sum(1 << j for j, x in enumerate(copies(smallest)) if x == tuple(z))   # which copies of the smallest are this vertex
            rows.append((*smallest, m, mask))
        con.executemany("INSERT INTO turned VALUES (?,?,?,?,?,?,?,?)", rows)
        done += len(batch)
        if time.time() - last >= min(BEAT, 5) or done == total:
            last = time.time()
            rate = done / max(time.time() - began, 1e-9)
            say(f"   {done:,} of {total:,}  ({100 * done / total:.0f}%)   {rate:,.0f} per second   about {clock((total - done) / max(rate, 1e-9))} left")
    con.commit()
    con.execute("DROP TABLE once")
    say(f"   done in {clock(time.time() - began)}")
    say()

    step("STEP 3 of 4: writing the vertex table", f"""
        CREATE TABLE s.vertex_index({KEY}, depth INTEGER, node_id INTEGER, g INTEGER, PRIMARY KEY({KEY})) WITHOUT ROWID""")
    # one row per set of 8 copies: its shallowest node, and "g" = which of the copies that node holds (a bit for each of the 8)
    label = "merging the copies"
    say("   merging the copies (sqlite sorts first, so it is quiet for a while)...")
    began, last, written, pending = time.time(), time.time(), 0, []
    def flush(group):
        key, best, mask = group
        pending.append((*key, best // B, best % B, mask))
    group = None
    for *key, m, mask in con.execute(f"SELECT {KEY}, m, mask FROM turned ORDER BY {KEY}, m"):
        key = tuple(key)
        if group is None or group[0] != key:
            if group: flush(group)
            group = [key, m, mask]
        elif m == group[1]:
            group[2] |= mask
        if len(pending) >= 50000:
            con.executemany("INSERT INTO s.vertex_index VALUES (?,?,?,?,?,?,?,?,?)", pending)
            written += len(pending); pending.clear()
            if time.time() - last >= min(BEAT, 5):
                last = time.time()
                say(f"   {written:,} written so far")
    if group: flush(group)
    con.executemany("INSERT INTO s.vertex_index VALUES (?,?,?,?,?,?,?,?,?)", pending)
    con.commit()
    say(f"   done in {clock(time.time() - began)}")
    kept = con.execute("SELECT COUNT(*) FROM s.vertex_index").fetchone()[0]
    say(f"   {kept:,} vertices kept ({total / max(kept, 1):.1f}x fewer than before merging the rotated / mirrored copies)")
    con.execute("DROP TABLE turned")
    say()

    step("STEP 4 of 4: which nodes are needed (those, and every node above them)", "CREATE TEMP TABLE keep(id INTEGER PRIMARY KEY)")
    step("   working it out", """
        WITH RECURSIVE k(id) AS (
            SELECT DISTINCT node_id FROM s.vertex_index
            UNION SELECT n.parent_id FROM main.nodes n JOIN k ON n.id = k.id WHERE n.parent_id IS NOT NULL)
        INSERT INTO keep SELECT id FROM k""")
    step("   writing the nodes", """
        CREATE TABLE s.nodes(id INTEGER PRIMARY KEY, parent_id INTEGER, function_name TEXT,
                             new_crease_v1 BLOB, new_crease_v2 BLOB, refs TEXT)""")
    step("   filling them", """
        INSERT INTO s.nodes SELECT n.id, n.parent_id, n.function_name, n.new_crease_v1, n.new_crease_v2, n.refs
        FROM main.nodes n JOIN keep ON keep.id = n.id""")
    kept_nodes = con.execute("SELECT COUNT(*) FROM s.nodes").fetchone()[0]
    say(f"   {kept_nodes:,} nodes kept (of {n_nodes:,})")
    say()

    # a check on the result: vertices of the original must all be found in the new file, as shallow or shallower
    say("CHECK: looking up 3,000 random vertices of the original in the new file...")
    label = "the check"
    try:
        top = con.execute("SELECT MAX(rowid) FROM main.vertex_index").fetchone()[0]
        ids = [random.randint(1, top) for _ in range(3000)]
        sample = [r for i in ids for r in con.execute(f"SELECT {KEY}, depth FROM main.vertex_index WHERE rowid = ?", (i,))]
    except sqlite3.Error:
        sample = con.execute(f"SELECT {KEY}, depth FROM main.vertex_index LIMIT 3000").fetchall()
    bad = 0
    for *z, depth in sample:
        key = min(copies(z))
        row = con.execute("SELECT depth, node_id FROM s.vertex_index WHERE px=? AND qx=? AND dx=? AND py=? AND qy=? AND dy=?", key).fetchone()
        if row is None or row[0] > depth or con.execute("SELECT 1 FROM s.nodes WHERE id=?", (row[1],)).fetchone() is None:
            bad += 1
    say(f"   {len(sample):,} checked, {bad} problems" + ("  <-- tell Claude about this" if bad else "  (all good)"))
    say()
    say(f"FINISHED in {clock()}.")
    say(f"size: {mb(src)}  ->  {mb(dst)}")
    say(f"use it by renaming it to cp_pruned.db, or start the server with REFS_DB set to {dst}")


try:
    main()
except KeyboardInterrupt:
    say("\nstopped. Deleting the half-made new file; just run it again when you like.")
    con.close()
    try:
        os.remove(dst)
    except OSError:
        pass
    sys.exit(1)
finally:
    con.close()
