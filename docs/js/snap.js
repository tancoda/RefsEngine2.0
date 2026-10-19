import { TEXT as T } from "./text.js";
// snap.js -- turns the floating-point graph from parse.js into EXACT
// coordinates of the form (m + n*sqrt(2)) / D  (m, n integers, D > 0).
//
// Pipeline (each stage is one exported function, so you can test it alone):
//
//   graph.vertices --uniqueCoords--> { C, VC }      short list of distinct values
//   buildLibrary  --> sorted table of every (m, n, D) value in [-1, 1]
//   C --snapValue--> one match (or null) per distinct value
//   everything --snapGraph--> exact vertices + problems + stats + which vertices are broken
//
// DATA SHAPES
//   Recipe  : [m, n, D]       value = (m + n*sqrt(2)) / D, always REDUCED
//                             (gcd(m, n, D) = 1). Because sqrt(2) is irrational,
//                             a reduced recipe is the only recipe for its value.
//   Library : { values: Float64Array (sorted ascending),
//               recipes: Int32Array (3 numbers per entry: m, n, D) }
//   Match   : { recipe, value, dist }   recipe is null if no match

const SQRT2 = Math.SQRT2;

// Source - https://stackoverflow.com/a/17445304
// Posted by alex, modified by community. See post 'Timeline' for change history
// Retrieved 2026-10-13, License - CC BY-SA 4.0

 var gcd = function(a, b) {

  if (!b) {
    return Math.abs(a);
  }

  return gcd(b, a % b);
}


// Measured on real files: the sample FOLD has noise up to ~8e-11 after
// rescaling to [-1, 1]; the sample CP ~1e-14. 1e-9 sits ~10x above the worst
// noise and far below the smallest gap between library entries (~4e-8 for the
// caps below). Note 1e-11 is TOO tight (it failed to match half the FOLD).
export const SNAP_DEFAULTS = {
  tol: 1e-9,        // max distance between a coordinate and its library match
  mergeEps: 1e-9,   // coordinates closer than this count as the same coordinate
  maxD: 64,         // largest denominator in the library
  maxN: 64,         // largest |n| in the library
  angleTol: 1e-9,   // allowed error, in units of 22.5 degrees, on snapped edges
};

// "Looks like a 22.5-degree pattern" (in units of 22.5 degrees, how far an edge may be from the grid):
const LEGIT_ANGLE = 1e-4;   // a coordinate gets the big search only next to edges this exactly on the grid
// Real noise in a 22.5-degree pattern is far smaller than this (measured: under 0.001 units of 22.5 degrees, a few short
// creases up to 0.01), while deliberate creases at other angles that happen to lie close to the grid are not (0.02 and up).
const NEAR_ANGLE = 0.01;    // a crease this close to the grid (units of 22.5 degrees) but not on it is a near miss: noise
const GRID_SHARE = 0.985;    // a pattern counts as a 22.5-degree pattern if this share of its creases is on the grid or a near miss

// ---------------------------------------------------------------------------
// STEP 1: collect the distinct coordinate values
// ---------------------------------------------------------------------------

// Input : vertices [[x, y], ...], eps
// Output: { C, VC }
//   C  : the distinct values, ascending
//   VC : for each vertex, [index of its x in C, index of its y in C]
// Only C gets snapped (a few dozen numbers instead of hundreds), and vertices
// that share an x or y automatically share the same exact value.
export function uniqueCoords(vertices, eps) {
  const C = [];
  const VC = vertices.map(() => [0, 0]);
  const C0 = [];

  for (let i = 0; i < vertices.length; i++) {
    C0.push([vertices[i][0], i, 0], [vertices[i][1], i, 1]);
  }
  C0.sort((a, b) => a[0] - b[0]);

  let clusterStart = 0;
  for (let i = 1; i <= C0.length; i++) {
    if (i < C0.length && C0[i][0] - C0[i - 1][0] <= eps) continue;   // same cluster

    let sum = 0;
    for (let j = clusterStart; j < i; j++) sum += C0[j][0];
    C.push(sum / (i - clusterStart));
    for (let j = clusterStart; j < i; j++) VC[C0[j][1]][C0[j][2]] = C.length - 1;
    clusterStart = i;
  }
  return { C, VC };
}

// ---------------------------------------------------------------------------
// STEP 2: the library
// ---------------------------------------------------------------------------

let libCached = null;

// Input : { maxD, maxN }
// Output: Library (see top). Cache it, it only needs building once.
function buildLibrary({ maxD = SNAP_DEFAULTS.maxD, maxN = SNAP_DEFAULTS.maxN } = {}) {

    if (libCached && libCached.maxD === maxD && libCached.maxN === maxN) return libCached.library;

    const library = [];

    for (let D = 1; D <= maxD; D++){
        for (let n = -maxN; n <= maxN; n++) {
            const minM = Math.ceil(-D - n * SQRT2);
            const maxM = Math.floor(D - n * SQRT2);

            for (let m = minM; m <= maxM; m++) {
                if (gcd(gcd(m,n),D) !== 1) continue;
                library.push({value: (m + n * SQRT2) / D, m: m, n: n, D: D});
            }
        }
    }

    library.sort((a,b) => a.value - b.value);

    libCached = {library: library, maxD:maxD, maxN:maxN};

    return library;
}

// Evaluates a recipe back to a float. Useful for the angle check.
export function recipeValue([m, n, D]) {
  return (m + n * SQRT2) / D;
}

// ---------------------------------------------------------------------------
// STEP 3: look one value up
// ---------------------------------------------------------------------------

function binarySearchLB(arr, target) {
    let low = 0, high = arr.length-1;
    let res = arr.length;

    while (low <= high) {
        let mid = low + Math.floor((high - low) / 2);
        if (arr[mid].value >= target) {
            res = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }
    return res;
}

// The library only holds denominators up to maxD and |n| up to maxN. Real patterns sometimes need more: values built
// from repeated sqrt(2) ratios have a small denominator but a huge n, e.g. (456 - 325*sqrt2)/4 (= -0.9048...), the two
// big terms nearly cancelling. So a value the library misses is searched for directly, in bigger and bigger ranges: for
// each D and n, m must lie within D*tol of D*x - n*sqrt2, which leaves a handful of integers. Nothing is stored, so
// the range can be far bigger than the library's.
//
// How far is it worth going? The values in a range are about 1.7 / (maxN * maxD^2) apart. A window of `tol` then
// matches a wrong value by chance about once in spacing/(2*tol) tries, so the range may grow only while that stays
// rare: with the 1e-11 window (files like these agree to ~1e-13) the last tier below is about 1 chance in 300 per value,
// and every match is also checked afterwards (all edges must be on the 22.5-degree grid). Beyond that a bigger range
// finds more coincidences than real values. For a noisy file (errors around 1e-6) the useful limit is already the
// library itself, so the deep tiers give up after a few misses (a noisy file has hundreds, a big-number file a few).
const WIDE = {
  tol: 1e-11,
  tiers: [{ maxD: 128, maxN: 256 }, { maxD: 128, maxN: 1024 }, { maxD: 256, maxN: 4096, tol: 3e-12 }],   // (a tier may have a window of its own)
  deepMisses: 10,
};
let wideMisses = 0;
function resetWideBudget() { wideMisses = 0; }

function searchRange(x, tol, { maxD, maxN }) {
  let best = null;
  for (let D = 1; D <= maxD; D++) {
    for (let n = -maxN; n <= maxN; n++) {
      const base = D * x - n * SQRT2;
      for (let m = Math.ceil(base - D * tol); m <= Math.floor(base + D * tol); m++) {
        if (gcd(gcd(m, n), D) !== 1) continue;
        const value = (m + n * SQRT2) / D;
        const dist = Math.abs(value - x);
        if (dist > tol) continue;
        if (!best || dist < best.dist) best = { recipe: [m, n, D], value, dist };
      }
    }
  }
  return best;
}

function wideSearch(x, tol) {
  for (let t = 0; t < WIDE.tiers.length; t++) {
    if (t >= 1 && wideMisses >= WIDE.deepMisses) break;       // many misses: noise, not big numbers
    const hit = searchRange(x, Math.min(tol, WIDE.tiers[t].tol ?? tol), WIDE.tiers[t]);
    if (hit) return hit;
  }
  wideMisses++;
  return null;
}

// Input : x (float), library, tol, wide (also try the big search when the library has nothing)
// Output: Match
// A match needs |entry - x| <= tol.
function snapValue(x, library, tol, wide = true) {
  const i = binarySearchLB(library, x);

  // the two nearest entries always sit among these four neighbours of the insertion point
  const candidates = [];
  for (let j = i - 2; j <= i + 1; j++) {
    if (j >= 0 && j < library.length) {
      candidates.push({ entry: library[j], dist: Math.abs(library[j].value - x) });
    }
  }
  candidates.sort((a, b) => a.dist - b.dist);

  const best = candidates[0];
  if (best.dist > tol) {
    // not in the library: look directly through the much larger range before giving up
    // (snapGraph asks for this itself, and only for coordinates that look legitimate)
    const found = wide ? wideSearch(x, Math.min(tol, WIDE.tol)) : null;
    if (found) return found;
    return { recipe: null, value: null, dist: best.dist };
  }
  const { m, n, D, value } = best.entry;
  return { recipe: [m, n, D], value, dist: best.dist };
}

// ---------------------------------------------------------------------------
// STEP 4: snap a whole graph
// ---------------------------------------------------------------------------

// Input : graph { vertices: [[x, y], ...], edges: [[i, j, type], ...] }
//         in [-1, 1], plus optional overrides of SNAP_DEFAULTS
// Output: {
//   exact    : per vertex, [recipeX, recipeY] (either may be null)
//   problems : things that stop the pattern being used
//   stats    : { coordCount, matched, coverage, maxD }
// }
export function snapGraph(graph, options = {}) {
  const opts = { ...SNAP_DEFAULTS, ...options };
  const { vertices, edges } = graph;
  const problems = [];

  // 1. distinct coordinates, then the library, then snap each distinct value once
  const { C, VC } = uniqueCoords(vertices, opts.mergeEps);
  const library = buildLibrary(opts);
  resetWideBudget();
  const matches = C.map(c => snapValue(c, library, opts.tol, false));      // (the library only, for now)

  // 2. which vertices use each distinct coordinate (so messages can point at them)
  const users = C.map(() => []);
  VC.forEach(([cx, cy], vi) => {
    users[cx].push(vi);
    if (cy !== cx) users[cy].push(vi);
  });
  const where = ci => T.whereVertices(users[ci].slice(0, 5).join(", "), users[ci].length > 5);

  // 2b. the creases at each vertex, and how far each is from the 22.5-degree grid (in units of 22.5 degrees)
  const incident = vertices.map(() => []);
  const offOf = edges.map(([a, b], ei) => {
    incident[a].push(ei); incident[b].push(ei);
    const units = Math.atan2(vertices[b][1] - vertices[a][1], vertices[b][0] - vertices[a][0]) / (Math.PI / 8);
    return Math.abs(units - Math.round(units));
  });
  const other = (ei, v) => (edges[ei][0] === v ? edges[ei][1] : edges[ei][0]);
  const known = v => matches[VC[v][0]].recipe !== null && matches[VC[v][1]].recipe !== null;     // a vertex with exact values: "confident"

  // 2c. the big search is the one that finds false matches by chance, so it only runs for a coordinate whose vertex
  // looks like a real 22.5-degree vertex: every crease on the grid, and one of them leading to a confident vertex.
  // (A value it finds makes its vertex confident, which can open the next one: so it repeats until nothing changes.)
  const looksLegit = v => incident[v].length > 0 && incident[v].every(ei => offOf[ei] <= LEGIT_ANGLE) && incident[v].some(ei => known(other(ei, v)));
  const gaveUp = new Set();
  for (let changed = true; changed;) {
    changed = false;
    C.forEach((c, ci) => {
      if (matches[ci].recipe !== null || gaveUp.has(ci) || !users[ci].some(looksLegit)) return;
      const hit = wideSearch(c, Math.min(opts.tol, WIDE.tol));
      if (hit) { matches[ci] = hit; changed = true; } else gaveUp.add(ci);
    });
  }

  // 2d. is this a 22.5-degree pattern at all? Only then can anything in it be "broken". A pattern with creases at other
  // angles has coordinates outside this world, so unmatched coordinates there are not mistakes and Wiggle cannot help.
  const gridShare = edges.length ? offOf.filter(o => o <= NEAR_ANGLE).length / edges.length : 0;
  const is225 = gridShare >= GRID_SHARE;

  // the vertices that are really broken (the problems list, and the "try wiggling" suggestion): no exact value, all
  // creases (nearly) on the grid, and either one of them leads to a confident vertex or one is a little off the grid.
  const turf = new Set();
  if (is225) vertices.forEach((_, v) => {
    if (known(v) || incident[v].length === 0) return;
    if (!incident[v].every(ei => offOf[ei] <= NEAR_ANGLE)) return;
    if (incident[v].some(ei => known(other(ei, v)) || offOf[ei] > 1e-6)) turf.add(v);
  });

  // the creases that are almost (not quite) on the grid, in a 22.5-degree pattern
  const turfEdges = is225 ? edges.map((_, ei) => ei).filter(ei => offOf[ei] > 1e-6 && offOf[ei] <= NEAR_ANGLE) : [];

  // 3. unmatched coordinates in the turf are problems
  matches.forEach((match, ci) => {
    if (match.recipe === null) {
      if (users[ci].some(v => turf.has(v))) problems.push(T.coordNoMatch(C[ci], where(ci), match.dist));
    }
  });

  // 4. exact recipes per vertex: [recipeX, recipeY], either can be null
  const exact = VC.map(([cx, cy]) => [matches[cx].recipe, matches[cy].recipe]);

  // 5. angle check on the SNAPPED values: every edge must be a multiple of 22.5 degrees
  edges.forEach(([a, b], ei) => {
    const [rxa, rya] = exact[a];
    const [rxb, ryb] = exact[b];
    if (!rxa || !rya || !rxb || !ryb) return;            // already reported above
    const dx = recipeValue(rxb) - recipeValue(rxa);
    const dy = recipeValue(ryb) - recipeValue(rya);
    const units = Math.atan2(dy, dx) / (Math.PI / 8);
    const off = Math.abs(units - Math.round(units));
    if (is225 && off > opts.angleTol && off <= NEAR_ANGLE) {      // (an edge far from the grid is an ordinary crease; only a near miss is a mistake)
      problems.push(T.edgeOffGrid(ei, a, b, (off * 22.5).toFixed(4)));
    }
  });

  // 6. summary numbers
  const matched = matches.filter(m => m.recipe !== null);
  const stats = {
    coordCount: C.length,
    matched: matched.length,
    coverage: C.length ? matched.length / C.length : 1,
    maxD: matched.reduce((mx, m) => Math.max(mx, m.recipe[2]), 0),
  };
  return { exact, problems, stats, turf, turfEdges };
}