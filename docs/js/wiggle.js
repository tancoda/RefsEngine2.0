// wiggle.js -- gives a slightly-off pattern exact coordinates in Q(sqrt 2) by nudging ("wiggling") its vertices.
//
// It is for patterns that snap.js can't use: every edge is on the 22.5-degree grid, but the floats are too noisy
// (e.g. from ORIPA) for some coordinates to match an exact value.
//
// The idea: a line at a multiple of 22.5 degrees has slope 0, +-(sqrt2 - 1), +-1, +-(sqrt2 + 1) or infinity, all
// of them in Q(sqrt 2). So two such lines through points with exact coordinates meet at a point with exact
// coordinates, found by plain arithmetic (Cramer's rule), no floats and no guessing. A vertex is fixed that way as
// soon as two lines through it are known: the lines of its edges to vertices that are already exact, the line of
// an edge it sits on, its x or y if that is known. The most constrained vertices go first, every fixed vertex
// helps the next ones. When nothing is that constrained any more, the most confident vertex that has ONE line is
// snapped along that line (one unknown instead of two), then the propagation goes on.
//
//   wiggle(graph, snapped, options)  -> { ok, reason, ... }   (graph and snapped from pipeline.js)
//   toCpText(result), toFoldText(result)                     the wiggled pattern as a file, in [-200, 200]

import { TEXT as T } from "./text.js";
import { SNAP_DEFAULTS, uniqueCoords, recipeValue } from "./snap.js";
import { preparePattern } from "./pipeline.js";

const SQRT2 = Math.SQRT2;

// ---------------------------------------------------------------------------
// exact numbers (a + b*sqrt2) / d, with BigInt a, b, d (d > 0, always reduced)
// ---------------------------------------------------------------------------
const absB = x => (x < 0n ? -x : x);
function gcdB(x, y) { x = absB(x); y = absB(y); while (y) [x, y] = [y, x % y]; return x; }
function Q(a, b = 0n, d = 1n) {
  if (d < 0n) { a = -a; b = -b; d = -d; }
  const g = gcdB(gcdB(a, b), d) || 1n;
  return { a: a / g, b: b / g, d: d / g };
}
const add = (x, y) => Q(x.a * y.d + y.a * x.d, x.b * y.d + y.b * x.d, x.d * y.d);
const sub = (x, y) => Q(x.a * y.d - y.a * x.d, x.b * y.d - y.b * x.d, x.d * y.d);
const mul = (x, y) => Q(x.a * y.a + 2n * x.b * y.b, x.a * y.b + x.b * y.a, x.d * y.d);
const neg = x => Q(-x.a, -x.b, x.d);
const isZero = x => x.a === 0n && x.b === 0n;
const inv = x => {                              // d / (a + b sqrt2) = d (a - b sqrt2) / (a^2 - 2 b^2)
  const norm = x.a * x.a - 2n * x.b * x.b;
  return Q(x.d * x.a, -x.d * x.b, norm);
};
const div = (x, y) => mul(x, inv(y));
const toFloat = x => (Number(x.a) + Number(x.b) * SQRT2) / Number(x.d);
const fromRecipe = ([m, n, D]) => Q(BigInt(m), BigInt(n), BigInt(D));
const ZERO = Q(0n), ONE = Q(1n);

// directions of the 8 lines at multiples of 22.5 degrees (k = 0..7), as (dx, dy)
const T1 = Q(-1n, 1n), T2 = Q(1n, 1n);          // sqrt2 - 1 = tan 22.5, sqrt2 + 1 = tan 67.5
const DIR = [
  { x: ONE, y: ZERO }, { x: ONE, y: T1 }, { x: ONE, y: ONE }, { x: ONE, y: T2 },
  { x: ZERO, y: ONE }, { x: ONE, y: neg(T2) }, { x: ONE, y: neg(ONE) }, { x: ONE, y: neg(T1) },
];

// a line  p x + q y = r
const lineThrough = (A, k) => ({ p: DIR[k].y, q: neg(DIR[k].x), r: sub(mul(DIR[k].y, A.x), mul(DIR[k].x, A.y)) });
const onLine = (L, P) => isZero(sub(add(mul(L.p, P.x), mul(L.q, P.y)), L.r));

// ---------------------------------------------------------------------------
// every (m, n, D) value within `tol` of x, found directly: for each D and n, m has to be within D*tol of
// D*x - n*sqrt2, which leaves a handful of integers (usually none or one)
// ---------------------------------------------------------------------------
function gcd3(a, b, c) { return Number(gcdB(gcdB(BigInt(a), BigInt(b)), BigInt(c))); }
function candidatesNear(x, tol, maxD, maxN) {
  const out = [];
  for (let D = 1; D <= maxD; D++) {
    for (let n = -maxN; n <= maxN; n++) {
      const base = D * x - n * SQRT2;
      for (let m = Math.ceil(base - D * tol); m <= Math.floor(base + D * tol); m++) {
        if (gcd3(m, n, D) !== 1) continue;
        const value = (m + n * SQRT2) / D;
        const dist = Math.abs(value - x);
        if (dist <= tol) out.push({ recipe: [m, n, D], value, dist });
      }
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}

// the best candidate only if it is clear: alone in its window, or 10x closer than the runner-up
function clearBest(cands) {
  if (!cands.length) return null;
  if (cands.length === 1 || cands[1].dist >= 10 * cands[0].dist) return cands[0];
  return null;
}

// the edges that are truly off the 22.5-degree grid (more than classTol units: not a matter of noise)
export function gridReport(graph, classTol = 0.05) {
  const off = [];
  graph.edges.forEach(([a, b], ei) => {
    const dx = graph.vertices[b][0] - graph.vertices[a][0], dy = graph.vertices[b][1] - graph.vertices[a][1];
    const units = Math.atan2(dy, dx) / (Math.PI / 8);
    if (Math.hypot(dx, dy) > 1e-3 && Math.abs(units - Math.round(units)) > classTol) off.push(ei);
  });
  return { off };
}

// ---------------------------------------------------------------------------
function wiggleOnce(graph, snapped, options = {}) {
  const opt = {
    maxMove: 1e-3,        // no vertex may end up farther than this from where the file put it ([-1, 1] units)
    window: 1e-4,         // the widest search window when a coordinate is snapped to an exact value
    merge: 1e-5,          // vertices closer than this are one vertex
    near: 1e-4,           // a vertex this close to an edge (not at its ends) is taken to lie on it
    classTol: 0.05,       // an edge is on the grid if its angle is within this many 22.5-degree units
    // the library grows when nothing is clear any more: small denominators first (real patterns use them, and with
    // fewer candidates a guess is less likely to be wrong), the bigger library only for what is still left
    levels: [{ maxD: 16, maxN: 16 }, { maxD: SNAP_DEFAULTS.maxD, maxN: SNAP_DEFAULTS.maxN }],
    ...options,
  };
  if (options.maxD) opt.levels = [{ maxD: options.maxD, maxN: options.maxN ?? options.maxD }];
  let levelIdx = 0;
  const lib = () => opt.levels[levelIdx];
  const fixedTols = [1e-9, 1e-8, 1e-7, 1e-6].filter(t => t <= opt.window * 1.0001);

  // 1. one vertex for each cluster of near-duplicates
  const nOld = graph.vertices.length;
  const root = Array.from({ length: nOld }, (_, i) => i);
  const find = i => (root[i] === i ? i : (root[i] = find(root[i])));
  for (let i = 0; i < nOld; i++) for (let j = i + 1; j < nOld; j++) {
    if (Math.hypot(graph.vertices[i][0] - graph.vertices[j][0], graph.vertices[i][1] - graph.vertices[j][1]) < opt.merge) root[find(j)] = find(i);
  }
  const newIndex = new Map(), members = [];
  for (let i = 0; i < nOld; i++) {
    const r = find(i);
    if (!newIndex.has(r)) { newIndex.set(r, members.length); members.push([]); }
    members[newIndex.get(r)].push(i);
  }
  const N = members.length;
  const pos = members.map(ms => [ms.reduce((s, i) => s + graph.vertices[i][0], 0) / ms.length,
                                 ms.reduce((s, i) => s + graph.vertices[i][1], 0) / ms.length]);
  const edges = [], seen = new Map(), origEdge = [];     // origEdge: the index in graph.edges
  for (const [ei0, [a0, b0, type]] of graph.edges.entries()) {
    const a = newIndex.get(find(a0)), b = newIndex.get(find(b0));
    if (a === b) continue;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (seen.has(key)) { if (type === "b") edges[seen.get(key)][2] = "b"; continue; }
    seen.set(key, edges.length);
    origEdge.push(ei0);
    edges.push([a, b, type]);
  }

  // 2. the line (k = 0..7, in 22.5-degree steps) of every edge. An edge that is truly off the grid has no line
  // (null): it decides nothing, and the vertices only it holds in place stay as they are.
  const cls = [], offGrid = [];
  edges.forEach(([a, b], ei) => {
    const dx = pos[b][0] - pos[a][0], dy = pos[b][1] - pos[a][1];
    const units = Math.atan2(dy, dx) / (Math.PI / 8);
    const k = Math.round(units);
    const off = Math.abs(units - k) > opt.classTol && Math.hypot(dx, dy) > 1e-3;
    if (off) offGrid.push(ei);
    cls.push(off ? null : ((k % 8) + 8) % 8);
  });

  // 3. which lines can a vertex be on: its edges, and the edges it sits on
  const adj = Array.from({ length: N }, () => []);        // { u, k }: v is on the line of direction k through u
  const watchers = Array.from({ length: N }, () => new Set());   // vertices whose lines depend on u
  const link = (v, u, k) => { adj[v].push({ u, k }); watchers[u].add(v); };
  edges.forEach(([a, b], ei) => { if (cls[ei] !== null) { link(a, b, cls[ei]); link(b, a, cls[ei]); } });
  edges.forEach(([a, b], ei) => {
    if (cls[ei] === null) return;
    const [ax, ay] = pos[a], [bx, by] = pos[b];
    const ex = bx - ax, ey = by - ay, len2 = ex * ex + ey * ey;
    for (let v = 0; v < N; v++) {
      if (v === a || v === b) continue;
      const t = ((pos[v][0] - ax) * ex + (pos[v][1] - ay) * ey) / len2;
      if (t <= 0 || t >= 1) continue;
      const dist = Math.abs((pos[v][0] - ax) * ey - (pos[v][1] - ay) * ex) / Math.sqrt(len2);
      if (dist <= opt.near) { link(v, a, cls[ei]); link(v, b, cls[ei]); }
    }
  });

  // 4. what is known already: the coordinates that snapped on their own, and the paper's own edges
  const kx = new Array(N).fill(null), ky = new Array(N).fill(null);
  members.forEach((ms, v) => {
    for (const [slot, arr] of [[0, kx], [1, ky]]) {
      const rs = ms.map(i => snapped.exact[i][slot]);
      // (a match from snap.js's deepest search ranges is not trusted as a starting point: on a noisy file one can be a
      // coincidence, and the lines work out such a vertex anyway)
      if (rs.every(r => r && r.join() === rs[0].join() && trusted(r))) arr[v] = fromRecipe(rs[0]);
    }
  });
  edges.forEach(([a, b, type], ei) => {
    if (type !== "b") return;
    for (const v of [a, b]) {
      if (cls[ei] === 4 && Math.abs(pos[v][0]) >= 1 - opt.maxMove) kx[v] ??= fromRecipe([Math.sign(pos[v][0]), 0, 1]);
      if (cls[ei] === 0 && Math.abs(pos[v][1]) >= 1 - opt.maxMove) ky[v] ??= fromRecipe([Math.sign(pos[v][1]), 0, 1]);
    }
  });

  // 5. the lines through v (a known x or y, and the lines to the vertices that are exact already)
  const isKnown = v => kx[v] !== null && ky[v] !== null;
  const linesOf = v => {
    const L = [];
    if (kx[v]) L.push({ p: ONE, q: ZERO, r: kx[v] });
    if (ky[v]) L.push({ p: ZERO, q: ONE, r: ky[v] });
    for (const { u, k } of adj[v]) if (isKnown(u)) L.push(lineThrough({ x: kx[u], y: ky[u] }, k));
    return L;
  };
  // two lines that cross decide the vertex; every other line has to pass through it too
  const solve = v => {
    const L = linesOf(v);
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const det = sub(mul(L[i].p, L[j].q), mul(L[j].p, L[i].q));
      if (isZero(det)) continue;
      const x = div(sub(mul(L[i].r, L[j].q), mul(L[j].r, L[i].q)), det);
      const y = div(sub(mul(L[i].p, L[j].r), mul(L[j].p, L[i].r)), det);
      const P = { x, y };
      if (!L.every(l => onLine(l, P))) return { conflict: "its lines do not meet in one point" };
      return { P };
    }
    return null;
  };
  const tooFar = (v, P) => Math.hypot(toFloat(P.x) - pos[v][0], toFloat(P.y) - pos[v][1]) > opt.maxMove;

  // How noisy is the file? The vertices fixed by plain arithmetic show it: how far each one is from where the file
  // had it. The search window for the vertices that need a guess is sized to that: a candidate much closer than the
  // noise would be a coincidence, one much farther is not this vertex.
  const residuals = [];
  let noise = null, noiseUsed = null;
  const windows = () => (noise === null ? fixedTols : [Math.min(opt.window, Math.max(3 * noise, 1e-9))]);

  const conflicts = new Map();
  const dirty = new Set(Array.from({ length: N }, (_, i) => i));
  const stale = new Set(dirty);                          // vertices whose best single snap must be recomputed
  const touch = v => { for (const w of watchers[v]) { dirty.add(w); stale.add(w); } stale.add(v); };
  let fixedBySolving = 0, fixedBySnapping = 0;

  const propagate = () => {
    while (dirty.size) {
      // most constrained first
      let best = -1, bestCount = -1;
      for (const v of dirty) {
        if (isKnown(v)) { dirty.delete(v); continue; }
        let c = (kx[v] ? 1 : 0) + (ky[v] ? 1 : 0);
        for (const { u } of adj[v]) if (isKnown(u)) c++;
        if (c > bestCount) { best = v; bestCount = c; }
      }
      if (best < 0) break;
      dirty.delete(best);
      const s = solve(best);
      if (!s) continue;
      if (s.conflict) { conflicts.set(best, s.conflict); continue; }
      if (tooFar(best, s.P)) { conflicts.set(best, "would have to move too far"); continue; }
      kx[best] = s.P.x; ky[best] = s.P.y; conflicts.delete(best);
      fixedBySolving++;
      residuals.push(Math.hypot(toFloat(s.P.x) - pos[best][0], toFloat(s.P.y) - pos[best][1]));
      touch(best);
    }
  };

  // the best way to snap v when it has no two lines: along its one line, or (no lines) coordinate by coordinate
  const snapCache = new Map();
  const bestSnap = v => {
    if (!stale.has(v) && snapCache.has(v)) return snapCache.get(v);
    stale.delete(v);
    let result = null;
    const L = linesOf(v);
    if (L.length) {
      const l = L[0];
      const p = toFloat(l.p), q = toFloat(l.q), r = toFloat(l.r);
      const f = (p * pos[v][0] + q * pos[v][1] - r) / (p * p + q * q);
      const foot = [pos[v][0] - f * p, pos[v][1] - f * q];
      const alongX = Math.abs(q) >= Math.abs(p);              // snap x (the line is not too steep), or else y
      const wins = windows();
      const cands = candidatesNear(alongX ? foot[0] : foot[1], wins[wins.length - 1], lib().maxD, lib().maxN)
        .map(c => {
          const c0 = fromRecipe(c.recipe);
          const P = alongX ? { x: c0, y: div(sub(l.r, mul(l.p, c0)), l.q) } : { x: div(sub(l.r, mul(l.q, c0)), l.p), y: c0 };
          // `full`: how far the candidate point is from where the file had the vertex; `dist`: how far along the line
          // (the vertex is usually a little off its line, and that sideways error is the same for every candidate, so
          // it must not hide which candidate is the closer one)
          return { ...c, P, full: Math.hypot(toFloat(P.x) - pos[v][0], toFloat(P.y) - pos[v][1]) };
        })
        .filter(c => c.full <= opt.maxMove)
        .sort((a, b) => a.dist - b.dist);
      // the window grows until the best candidate is clear
      for (const t of wins) {
        const inWindow = cands.filter(c => c.full <= t);
        const best = clearBest(inWindow);
        if (best) { result = { P: best.P, score: best.full }; break; }
        if (inWindow.length > 1) break;     // several in the window: leave it for later
      }
    } else {
      for (const [slot, arr] of [[0, kx], [1, ky]]) {
        if (arr[v]) continue;
        const best = clearBest(candidatesNear(pos[v][slot], Math.min(1e-6, windows()[windows().length - 1]), lib().maxD, lib().maxN));
        if (best && (!result || best.dist * 1000 < result.score)) result = { slot, value: fromRecipe(best.recipe), score: best.dist * 1000 };
      }
    }
    snapCache.set(v, result);
    return result;
  };

  const updateNoise = () => {
    if (residuals.length < 3) return;
    const est = Math.max(...residuals);
    if (noiseUsed === null || est > 1.5 * noiseUsed || est < noiseUsed / 1.5) {
      noise = est; noiseUsed = est;
      for (let v = 0; v < N; v++) stale.add(v);
    }
  };
  propagate();
  for (let guard = 0; guard < 4 * N + 10; guard++) {
    updateNoise();
    let pick = -1, pickScore = Infinity;
    for (let v = 0; v < N; v++) {
      if (isKnown(v)) continue;
      const s = bestSnap(v);
      if (s && s.score < pickScore) { pick = v; pickScore = s.score; }
    }
    if (pick < 0) {
      if (levelIdx < opt.levels.length - 1) { levelIdx++; for (let v = 0; v < N; v++) stale.add(v); continue; }   // a bigger library
      break;
    }
    const s = bestSnap(pick);
    if (s.P) { kx[pick] = s.P.x; ky[pick] = s.P.y; } else if (s.slot === 0) kx[pick] = s.value; else ky[pick] = s.value;
    fixedBySnapping++;
    touch(pick); dirty.add(pick); stale.add(pick);
    propagate();
  }

  // 6. which vertices are exact now, and does every edge that has a line lie on it? The vertices that could not be
  // decided stay where the file had them (usually: they hang on creases that are off the grid).
  const unresolved = [];
  for (let v = 0; v < N; v++) if (!isKnown(v)) unresolved.push(v);
  // Only the vertices that touch an off-grid crease may be left over. Any other vertex that cannot be decided is a
  // sign that the noise is too much to trust the guesses (they would be wrong), so then nothing is changed.
  const touchesOffGrid = new Set();
  edges.forEach(([a, b], ei) => { if (cls[ei] === null) { touchesOffGrid.add(a); touchesOffGrid.add(b); } });
  const undecided = unresolved.filter(v => !touchesOffGrid.has(v));
  if (undecided.length) {
    return { ok: false, unresolved, reason: T.wiggleSome(undecided.length, undecided.slice(0, 6).join(", "), undecided.length > 6) };
  }
  if (unresolved.length === N) {
    return { ok: false, reason: T.wiggleNone, unresolved };
  }
  const badEdges = [];
  edges.forEach(([a, b], ei) => {
    if (cls[ei] === null || !isKnown(a) || !isKnown(b)) return;
    if (!onLine(lineThrough({ x: kx[a], y: ky[a] }, cls[ei]), { x: kx[b], y: ky[b] })) badEdges.push(ei);
  });
  if (badEdges.length) {
    return { ok: false, reason: T.wiggleOffGrid(badEdges.length, badEdges.slice(0, 6).map(ei => edges[ei][0] + "-" + edges[ei][1]).join(", ")) };
  }

  // 7. two edges that cross with no vertex there (the file drew them as long lines): the crossing is exact too
  let crossings = 0;
  const px = kx.map((x, v) => (isKnown(v) ? toFloat(x) : pos[v][0])), py = ky.map((y, v) => (isKnown(v) ? toFloat(y) : pos[v][1]));
  for (let again = true; again;) {
    again = false;
    for (let e = 0; e < edges.length && !again; e++) {
      const [a, b] = edges[e];
      for (let f = e + 1; f < edges.length; f++) {
        const [c, d] = edges[f];
        if (a === c || a === d || b === c || b === d) continue;
        if (cls[e] === null || cls[f] === null || !isKnown(a) || !isKnown(b) || !isKnown(c) || !isKnown(d)) continue;
        const rx = px[b] - px[a], ry = py[b] - py[a], sx = px[d] - px[c], sy = py[d] - py[c];
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((px[c] - px[a]) * sy - (py[c] - py[a]) * sx) / den;
        const u = ((px[c] - px[a]) * ry - (py[c] - py[a]) * rx) / den;
        if (!(t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9)) continue;
        const L1 = lineThrough({ x: kx[a], y: ky[a] }, cls[e]), L2 = lineThrough({ x: kx[c], y: ky[c] }, cls[f]);
        const det = sub(mul(L1.p, L2.q), mul(L2.p, L1.q));
        if (isZero(det)) continue;
        const X = div(sub(mul(L1.r, L2.q), mul(L2.r, L1.q)), det), Y = div(sub(mul(L1.p, L2.r), mul(L2.p, L1.r)), det);
        const w = kx.length;
        kx.push(X); ky.push(Y); px.push(toFloat(X)); py.push(toFloat(Y));
        const [, , te] = edges[e], [, , tf] = edges[f];
        edges[e] = [a, w, te]; edges.push([w, b, te]); cls.push(cls[e]);
        edges[f] = [c, w, tf]; edges.push([w, d, tf]); cls.push(cls[f]);
        crossings++; again = true;
        break;
      }
    }
  }

  const known = v => kx[v] !== null && ky[v] !== null;
  const exact = Array.from({ length: kx.length }, (_, v) => (known(v) ? [kx[v], ky[v]] : [null, null]));
  const vertices = exact.map(([x, y], v) => (x ? [toFloat(x), toFloat(y)] : [...pos[v]]));
  // how far did each vertex move from where the file had it? (in [-1, 1] units)
  const moved = [];
  members.forEach((ms, v) => {
    const d = Math.max(...ms.map(i => Math.hypot(vertices[v][0] - graph.vertices[i][0], vertices[v][1] - graph.vertices[i][1])));
    if (d > 1e-9) moved.push({ vertex: v, distance: d });
  });
  const maxMoved = moved.reduce((m, o) => Math.max(m, o.distance), 0);
  return {
    ok: true, noise, maxD: lib().maxD, exact, vertices, edges, moved, maxMoved,
    partial: unresolved.length > 0 || offGrid.length > 0, unresolved, offGridEdges: offGrid.map(ei => origEdge[ei]),
    mergedVertices: nOld - N, crossings, fixedBySolving, fixedBySnapping,
    segments: edges.map(([a, b, type]) => ({ type, x1: vertices[a][0], y1: vertices[a][1], x2: vertices[b][0], y2: vertices[b][1] })),
  };
}

// ---------------------------------------------------------------------------
// STAGE 1: loosen the tolerance. For files with fewer digits than snap.js expects, most coordinates are just a
// little further from their exact value than the normal 1e-9. So: with a window of 1e-8, then 1e-7, 1e-6, 1e-5, snap
// every coordinate that did not match to the SIMPLEST exact value inside the window (smallest denominator, then
// smallest n: real patterns use simple numbers, and a simple value is unlikely to be there by chance). Coordinates
// that already matched keep their value. The guess is only believed if every edge is on the 22.5-degree grid
// afterwards and the pattern then passes all the checks; otherwise the next window, and then stage 2 (the lines).
// ---------------------------------------------------------------------------
const LOOSE_WINDOWS = [1e-8, 1e-7, 1e-6, 1e-5];
const trusted = r => Math.abs(r[1]) <= 256 && r[2] <= 128;     // (not a match from snap.js's deepest ranges: see above)
function snapLoosened(graph, snapped) {
  const V = graph.vertices;
  for (const w of LOOSE_WINDOWS) {
    const { C, VC } = uniqueCoords(V, w);
    const matched = C.map(() => new Map());                 // the recipes snap.js already found, per distinct coordinate
    V.forEach((_, i) => [0, 1].forEach(slot => { const r = snapped.exact[i][slot]; if (r && trusted(r)) matched[VC[i][slot]].set(r.join(), r); }));
    const rec = [];
    let usable = true, guessed = 0;
    for (let c = 0; c < C.length && usable; c++) {
      const have = [...matched[c].values()];
      if (have.length > 1) { usable = false; break; }       // two different exact values inside one window: too loose
      if (have.length === 1 && Math.abs(recipeValue(have[0]) - C[c]) <= w) { rec[c] = have[0]; continue; }
      const cands = candidatesNear(C[c], w, SNAP_DEFAULTS.maxD, SNAP_DEFAULTS.maxN);
      if (!cands.length) { usable = false; break; }
      cands.sort((a, b) => a.recipe[2] - b.recipe[2] || Math.abs(a.recipe[1]) - Math.abs(b.recipe[1]) || a.dist - b.dist);
      rec[c] = cands[0].recipe; guessed++;
    }
    if (!usable) { if (!C.length) break; continue; }
    const exact = V.map((_, i) => [rec[VC[i][0]], rec[VC[i][1]]]);
    const vertices = exact.map(([rx, ry]) => [recipeValue(rx), recipeValue(ry)]);
    const edges = [], segments = [];
    let onGrid = true;
    for (const [a, b, type] of graph.edges) {
      const dx = vertices[b][0] - vertices[a][0], dy = vertices[b][1] - vertices[a][1];
      if (Math.hypot(dx, dy) < 1e-12) continue;             // collapsed onto one point
      const units = Math.atan2(dy, dx) / (Math.PI / 8);
      if (Math.abs(units - Math.round(units)) > 1e-9) { onGrid = false; break; }
      edges.push([a, b, type]);
      segments.push({ type, x1: vertices[a][0], y1: vertices[a][1], x2: vertices[b][0], y2: vertices[b][1] });
    }
    if (!onGrid || !guessed) continue;                      // (nothing was guessed: snap.js's own result stands)
    if (preparePattern(segments, "fold").problems.length) continue;
    const moved = [];
    V.forEach((v, i) => { const d = Math.hypot(vertices[i][0] - v[0], vertices[i][1] - v[1]); if (d > 1e-9) moved.push({ vertex: i, distance: d }); });
    return {
      ok: true, method: "snap", window: w, noise: w, maxD: SNAP_DEFAULTS.maxD, exact, vertices, edges, moved,
      maxMoved: moved.reduce((m, o) => Math.max(m, o.distance), 0), partial: false, unresolved: [], offGridEdges: [],
      mergedVertices: 0, crossings: 0, fixedBySolving: 0, fixedBySnapping: guessed, segments,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Kawasaki-Justin: at a flat-foldable vertex the wedges between the creases, taken in turn around the vertex, add
// up to 180 degrees on the even ones and on the odd ones; that is, their alternating sum is zero. A wiggle that
// breaks it at a vertex that had it before has put that vertex in the wrong place, so it is no good.
// Only vertices inside the paper count (a border vertex is not folded flat on its own). A vertex with an odd number
// of creases can never be flat-foldable.
// ---------------------------------------------------------------------------
// -> the indices of the interior vertices where Kawasaki-Justin does not hold (alternating sum off by more than tol, radians)
export function kawasakiFailures(vertices, edges, tol) {
  const around = vertices.map(() => []);
  const onBorder = vertices.map(() => false);
  for (const [a, b, type] of edges) {
    if (a === b) continue;
    around[a].push(Math.atan2(vertices[b][1] - vertices[a][1], vertices[b][0] - vertices[a][0]));
    around[b].push(Math.atan2(vertices[a][1] - vertices[b][1], vertices[a][0] - vertices[b][0]));
    if (type === "b") onBorder[a] = onBorder[b] = true;
  }
  const bad = [];
  around.forEach((angles, v) => {
    if (onBorder[v] || angles.length === 0) return;
    if (angles.length % 2) { bad.push(v); return; }
    angles.sort((p, q) => p - q);
    let alt = 0;
    angles.forEach((a, i) => { const next = i + 1 < angles.length ? angles[i + 1] : angles[0] + 2 * Math.PI; alt += (i % 2 ? -1 : 1) * (next - a); });
    if (Math.abs(alt) > tol) bad.push(v);
  });
  return bad;
}

// The wiggle must not break Kawasaki-Justin anywhere it held in the file: a vertex that already failed (the pattern
// is not flat-foldable there; its angles are off by a whole 22.5-degree step or more, far above the noise) is not
// held against it. -> the result's vertices (indices into result.vertices) that are newly broken
export function newKawasakiBreaks(graph, result) {
  const NOISE = 0.05;                                         // radians: ~3 degrees; real failures are 22.5 degrees or more
  const before = new Set(kawasakiFailures(graph.vertices, graph.edges, NOISE));
  const after = kawasakiFailures(result.vertices, result.edges, 1e-9);
  const V = graph.vertices;
  return after.filter(v => {
    let best = -1, bestD = Infinity;                          // the vertex of the file this one came from
    V.forEach((p, i) => { const d = Math.hypot(p[0] - result.vertices[v][0], p[1] - result.vertices[v][1]); if (d < bestD) { bestD = d; best = i; } });
    return best >= 0 && !before.has(best);
  });
}

// Stage 1 (loosened snapping), then stage 2: exact arithmetic along the lines, small denominators first (real
// patterns use them, and with fewer candidates a guess is less likely to be wrong), then the full library.
export function wiggle(graph, snapped, options = {}) {
  const loose = options.maxD ? null : snapLoosened(graph, snapped);
  if (loose) {
    const broken = newKawasakiBreaks(graph, loose);
    if (!broken.length) { loose.warnings = []; return loose; }       // (otherwise: try the second way)
  }
  const result = wiggleOnce(graph, snapped, options);
  if (result.ok) {
    const broken = newKawasakiBreaks(graph, result);
    if (broken.length) {
      return { ok: false, reason: T.kawasakiBroken?.(broken.length, broken) ?? `Wiggling would break Kawasaki-Justin at ${broken.length} vertex(es) that satisfied it in the file, so the result was thrown away.` };
    }
    result.warnings = [];
    if (result.maxMoved > 2e-5) result.warnings.push(T.largestMove(result.maxMoved));
  }
  return result;
}

// ---------------------------------------------------------------------------
// the wiggled pattern as a file, scaled to [-200, 200]
// ---------------------------------------------------------------------------
const SCALE = 200;
const CP_CODE = { b: 1, m: 2, v: 3, a: 4 };
const FOLD_LETTER = { b: "B", m: "M", v: "V", a: "F" };

// .cp has y pointing down (the loader flips it), so it is flipped back here. g = { vertices, edges: [[a, b, type]] }
export function toCpText(g) {
  return g.edges.map(([a, b, type]) => {
    const [x1, y1] = g.vertices[a], [x2, y2] = g.vertices[b];
    return `${CP_CODE[type] ?? 4} ${x1 * SCALE} ${-y1 * SCALE} ${x2 * SCALE} ${-y2 * SCALE}`;
  }).join("\n") + "\n";
}
export function toFoldText(g) {
  return JSON.stringify({
    file_spec: 1.1,
    file_creator: "Crease Pattern Lab (wiggled)",
    file_classes: ["singleModel"],
    frame_classes: ["creasePattern"],
    vertices_coords: g.vertices.map(([x, y]) => [x * SCALE, y * SCALE]),
    edges_vertices: g.edges.map(([a, b]) => [a, b]),
    edges_assignment: g.edges.map(([, , t]) => FOLD_LETTER[t] ?? "U"),
  }, null, 1);
}