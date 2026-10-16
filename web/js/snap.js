import { TEXT as T } from "./text.js";
// snap.js -- turns the floating-point graph from parse.js into EXACT
// coordinates of the form (m + n*sqrt(2)) / D  (m, n integers, D > 0).
//
// Pipeline (each stage is one exported function, so you can test it alone):
//
//   graph.vertices --uniqueCoords--> { C, VC }      short list of distinct values
//   buildLibrary  --> sorted table of every (m, n, D) value in [-1, 1]
//   C --snapValue--> one match (or null) per distinct value
//   everything --snapGraph--> exact vertices + problems + warnings + stats
//
// DATA SHAPES
//   Recipe  : [m, n, D]       value = (m + n*sqrt(2)) / D, always REDUCED
//                             (gcd(m, n, D) = 1). Because sqrt(2) is irrational,
//                             a reduced recipe is the only recipe for its value.
//   Library : { values: Float64Array (sorted ascending),
//               recipes: Int32Array (3 numbers per entry: m, n, D) }
//   Match   : { recipe, value, dist, ambiguous }   recipe is null if no match

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
  let best = null, second = Infinity;
  for (let D = 1; D <= maxD; D++) {
    for (let n = -maxN; n <= maxN; n++) {
      const base = D * x - n * SQRT2;
      for (let m = Math.ceil(base - D * tol); m <= Math.floor(base + D * tol); m++) {
        if (gcd(gcd(m, n), D) !== 1) continue;
        const value = (m + n * SQRT2) / D;
        const dist = Math.abs(value - x);
        if (dist > tol) continue;
        if (!best || dist < best.dist) { if (best) second = best.dist; best = { recipe: [m, n, D], value, dist }; }
        else if (dist < second) second = dist;
      }
    }
  }
  if (!best) return null;
  return { ...best, ambiguous: second <= tol && second < 10 * best.dist };
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

// Input : x (float), library, tol
// Output: Match
// A match needs |entry - x| <= tol. It is flagged AMBIGUOUS if the runner-up
// is also within tol and not at least 10x farther away than the best one.
function snapValue(x, library, tol) {
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
    const wide = wideSearch(x, Math.min(tol, WIDE.tol));
    if (wide) return wide;
    return { recipe: null, value: null, dist: best.dist, ambiguous: false };
  }

  const secondDist = candidates.length > 1 ? candidates[1].dist : Infinity;
  const { m, n, D, value } = best.entry;
  return {
    recipe: [m, n, D],
    value,
    dist: best.dist,
    ambiguous: secondDist <= tol && secondDist < 10 * best.dist,
  };
}

// ---------------------------------------------------------------------------
// STEP 4: snap a whole graph
// ---------------------------------------------------------------------------

// Input : graph { vertices: [[x, y], ...], edges: [[i, j, type], ...] }
//         in [-1, 1], plus optional overrides of SNAP_DEFAULTS
// Output: {
//   exact    : per vertex, [recipeX, recipeY] (either may be null)
//   problems : things that stop the pattern being used
//   warnings : suspicious but usable (ambiguous matches)
//   stats    : { coordCount, matched, coverage, maxD }
// }
export function snapGraph(graph, options = {}) {
  const opts = { ...SNAP_DEFAULTS, ...options };
  const { vertices, edges } = graph;
  const problems = [];
  const warnings = [];

  // 1. distinct coordinates, then the library, then snap each distinct value once
  const { C, VC } = uniqueCoords(vertices, opts.mergeEps);
  const library = buildLibrary(opts);
  resetWideBudget();
  const matches = C.map(c => snapValue(c, library, opts.tol));

  // 2. which vertices use each distinct coordinate (so messages can point at them)
  const users = C.map(() => []);
  VC.forEach(([cx, cy], vi) => {
    users[cx].push(vi);
    if (cy !== cx) users[cy].push(vi);
  });
  const where = ci => T.whereVertices(users[ci].slice(0, 5).join(", "), users[ci].length > 5);

  // 3. unmatched coordinates are problems, ambiguous matches are warnings
  matches.forEach((match, ci) => {
    if (match.recipe === null) {
      problems.push(T.coordNoMatch(C[ci], where(ci), match.dist));
    } else if (match.ambiguous) {
      warnings.push(T.coordAmbiguous(C[ci], where(ci), JSON.stringify(match.recipe)));
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
    if (off > opts.angleTol && off <= 0.05) {            // (an edge far from the grid is an ordinary crease; only a near miss is a mistake)
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
  return { exact, problems, warnings, stats };
}
