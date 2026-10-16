// static-refs.js -- looks up folding sequences without a server, in the small files made by build_static.py (web/data).
// Used by refs.js when that folder is there (a published copy of the page); otherwise the Python server answers.
//
// The same lookup as server.py, step by step: put the vertex in the unit square, take the smallest of its 8 rotated /
// mirrored copies, find that in the vertex files, and read the chain of nodes from the root down.

const BASE = globalThis.REFS_DATA_BASE ?? new URL("../data/", import.meta.url).href;   // (the first is for testing)
const SQUARE_STEP = 32 / 4;                                  // 8 whole numbers per vertex record

let meta;                                                    // undefined: not asked yet; null: no data folder
const shards = new Map();                                    // file -> promise of its contents (each is fetched once)

function once(url, kind) {
  if (!shards.has(url)) {
    shards.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: ${r.status}`); return kind === "bin" ? r.arrayBuffer().then(b => new Int32Array(b)) : r.json(); }));
  }
  return shards.get(url);
}

export async function staticAvailable() {
  if (meta === undefined) {
    try { const r = await fetch(BASE + "meta.json"); meta = r.ok ? await r.json() : null; } catch { meta = null; }
  }
  return meta !== null;
}

// ---- exact numbers: a vertex is six whole numbers [p, q, d, P, Q, D], x = (p + q*sqrt2)/d ----
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function unitVertex([mx, nx, dx, my, ny, dy]) {              // the page's [-1, 1] recipe -> the database's [0, 1] numbers
  const one = (m, n, d) => {
    const p = m + d, q = n, dd = 2 * d;
    if (p === 0 && q === 0) return [0, 0, 1];
    const g = gcd(gcd(Math.abs(p), Math.abs(q)), dd);
    return [p / g, q / g, dd / g];
  };
  return [...one(mx, nx, dx), ...one(my, ny, dy)];
}
const turned = t => [t[2] - t[0], -t[1] + 0, t[2]];           // 1 - x
function images(z) {                                         // the 8 copies, in server.py's order
  const X = z.slice(0, 3), Y = z.slice(3), oX = turned(X), oY = turned(Y);
  return [[...X, ...Y], [...Y, ...oX], [...oX, ...oY], [...oY, ...X], [...X, ...oY], [...Y, ...X], [...oX, ...Y], [...oY, ...oX]];
}
const less = (a, b) => { for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
const same = (a, b) => a.every((v, i) => v === b[i]);

// ---- the 8 symmetries of the square on (x, y) in [0, 1] (server.py's SYMMETRIES) ----
const om = c => 1 - c;
const FORWARD = [(x, y) => [x, y], (x, y) => [om(y), x], (x, y) => [om(x), om(y)], (x, y) => [y, om(x)],
                 (x, y) => [x, om(y)], (x, y) => [y, x], (x, y) => [om(x), y], (x, y) => [om(y), om(x)]];
const INVERSE = [(x, y) => [x, y], (x, y) => [y, om(x)], (x, y) => [om(x), om(y)], (x, y) => [om(y), x],
                 (x, y) => [x, om(y)], (x, y) => [y, x], (x, y) => [om(x), y], (x, y) => [om(y), om(x)]];

function hashKey(key) {                                      // the same as hash_key in build_static.py
  let h = 2166136261;
  for (const v of key) h = Math.imul(h ^ (v | 0), 16777619) >>> 0;
  return h;
}

async function findVertex(key) {                             // -> [node, g] or null
  const file = (hashKey(key) & (meta.vshards - 1)).toString(16).padStart(4, "0");
  const words = await once(`${BASE}v/${file}.bin`, "bin");
  for (let at = 0; at < words.length; at += SQUARE_STEP) {
    if (words[at] === key[0] && words[at + 1] === key[1] && words[at + 2] === key[2] &&
        words[at + 3] === key[3] && words[at + 4] === key[4] && words[at + 5] === key[5]) {
      return [words[at + 6], words[at + 7] & 255];
    }
  }
  return null;
}

async function node(id) {
  const file = await once(`${BASE}n/${id >> meta.nshift}.json`, "json");
  return file[id];
}

async function sequence(nodeId, forward) {                   // the steps from the root down, turned to the user's orientation
  const last = await node(nodeId);
  const chain = [...(await Promise.all(last[4].map(node))).reverse(), last];
  const at = p => forward(p[0], p[1]);
  return chain.map(([fn, a, b, refs]) => ({
    function_name: fn, new_crease_v1: at(a), new_crease_v2: at(b),
    refs: refs.map(r => (r[0] === "v" ? { type: "vertex", v: at(r[1]) } : { type: "crease", v1: at(r[1]), v2: at(r[2]) })),
  }));
}

// rows = [[mx, nx, dx, my, ny, dy], ...] -> { index: steps } for the vertices the database knows
export async function staticRefs(rows) {
  if (!(await staticAvailable())) return null;
  const results = {};
  await Promise.all(rows.map(async (row, i) => {
    const copies = images(unitVertex(row));
    let key = copies[0], h = 0;
    copies.forEach((c, j) => { if (less(c, key)) { key = c; h = j; } });
    const hit = await findVertex(key);
    if (hit) results[i] = await sequence(hit[0], (x, y) => FORWARD[h](...INVERSE[hit[1]](x, y)));
  }));
  return results;
}