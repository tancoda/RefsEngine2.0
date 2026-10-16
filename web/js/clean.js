import { TEXT as T } from "./text.js";
// clean.js -- preprocessing for the x-ray pipeline. We only care about
// Kawasaki-Justin, so M/V and aux lines carry no information:
//
//   parse --> simplifySegments --> rescale --> node --> mergeDegree2 --> snap
//
// Doing the aux deletion BEFORE noding matters: an aux line crossing a crease
// would otherwise split that crease at the crossing (the degree-2 vertices you
// mentioned) and be reported as a crossing problem.

// Segments in, segments out. Aux ('a') segments are deleted; border stays 'b';
// mountain ('m') and valley ('v') keep their assignment.
export function simplifySegments(segments) {
  const out = [];
  for (const s of segments) {
    if (s.type === "a") continue;
    out.push({ ...s, type: s.type === "b" || s.type === "v" ? s.type : "m" });
  }
  return out;
}

const edgeKey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);

// Graph in, graph out ({ vertices, edges, problems }, plus a `merged` count).
// A vertex is merged away when it has exactly two edges, of the same type, that
// continue each other in a straight line (opposite directions). Square corners
// and genuine bends are left alone: a corner of the border is not a split
// crease, and a bent degree-2 interior vertex should fail Kawasaki loudly
// rather than be hidden.
export function mergeDegree2(graph, { sinTol = 1e-7 } = {}) {
  const { vertices } = graph;
  const edges = graph.edges.map(e => [...e]);          // working copy; merges append
  const alive = edges.map(() => true);
  const vertexAlive = vertices.map(() => true);
  const incident = vertices.map(() => new Set());       // edge indices at each vertex
  const present = new Set();                            // "a,b" for each live edge
  edges.forEach(([a, b], ei) => {
    incident[a].add(ei);
    incident[b].add(ei);
    present.add(edgeKey(a, b));
  });

  let merged = 0;
  for (let v = 0; v < vertices.length; v++) {
    if (incident[v].size !== 2) continue;
    const [e1, e2] = [...incident[v]];
    if (edges[e1][2] !== edges[e2][2]) continue;
    const a = edges[e1][0] === v ? edges[e1][1] : edges[e1][0];
    const b = edges[e2][0] === v ? edges[e2][1] : edges[e2][0];
    if (a === b || present.has(edgeKey(a, b))) continue;   // would create a duplicate edge

    const ux = vertices[a][0] - vertices[v][0], uy = vertices[a][1] - vertices[v][1];
    const wx = vertices[b][0] - vertices[v][0], wy = vertices[b][1] - vertices[v][1];
    const lengths = Math.hypot(ux, uy) * Math.hypot(wx, wy);
    if (lengths === 0) continue;
    const straight = (ux * wx + uy * wy) < 0 && Math.abs(ux * wy - uy * wx) / lengths <= sinTol;
    if (!straight) continue;

    // Replace a-v-b by a single a-b edge.
    alive[e1] = alive[e2] = false;
    vertexAlive[v] = false;
    present.delete(edgeKey(a, v));
    present.delete(edgeKey(v, b));
    const ne = edges.length;
    edges.push([a, b, edges[e1][2]]);
    alive.push(true);
    incident[a].delete(e1); incident[a].add(ne);
    incident[b].delete(e2); incident[b].add(ne);
    present.add(edgeKey(a, b));
    merged++;
  }

  // Compact: drop dead vertices/edges and renumber.
  const newIndex = new Array(vertices.length).fill(-1);
  const newVertices = [];
  vertices.forEach((p, i) => { if (vertexAlive[i]) { newIndex[i] = newVertices.length; newVertices.push(p); } });
  const newEdges = [];
  edges.forEach(([a, b, t], ei) => { if (alive[ei]) newEdges.push([newIndex[a], newIndex[b], t]); });

  return { ...graph, vertices: newVertices, edges: newEdges, merged };
}

// Indices of edges that are ALMOST at a multiple of 22.5 degrees but not quite: probably a mistake (or rounding noise
// that Wiggle can fix). An edge far from the grid is an ordinary crease and is not reported. Judged from the FLOAT
// coordinates. Units of 22.5 degrees: closer than tolUnits is exact enough, farther than nearUnits is deliberate.
export function offGridEdges(graph, tolUnits = 1e-6, nearUnits = 0.05) {
  const bad = [];
  graph.edges.forEach(([a, b], ei) => {
    const dx = graph.vertices[b][0] - graph.vertices[a][0];
    const dy = graph.vertices[b][1] - graph.vertices[a][1];
    const units = Math.atan2(dy, dx) / (Math.PI / 8);
    const off = Math.abs(units - Math.round(units));
    if (off > tolUnits && off <= nearUnits) bad.push(ei);
  });
  return bad;
}

// ---------------------------------------------------------------------------
// Border check that does NOT assume the paper is the whole square.
// Only the BOUNDING BOX of the border has to be the square [-1,1]^2; the
// border itself can cut off corners (or anything else), as long as it is one
// closed loop. Returns a list of problem strings (empty = fine).
//
//  1. every vertex has 0 or 2 border edges        (so border edges form loops)
//  2. the border edges form ONE connected loop
//  3. the loop's bounding box starts at (-1,-1) and its larger side reaches +1
//  4. every non-border vertex is strictly inside the loop
// ---------------------------------------------------------------------------
export function checkBorder(graph, tol = 1e-9) {
  const problems = [];
  const { vertices, edges } = graph;
  const border = edges.filter(e => e[2] === "b");
  if (border.length === 0) return ["There is no border"];

  const next = new Map();                                   // vertex -> its border neighbours
  for (const [a, b] of border) {
    if (!next.has(a)) next.set(a, []);
    if (!next.has(b)) next.set(b, []);
    next.get(a).push(b);
    next.get(b).push(a);
  }
  for (const [v, ns] of next) {
    if (ns.length !== 2) problems.push(T.borderVertexEdges(v, ns.length));
  }
  if (problems.length > 0) return problems;

  // Walk the loop from any border vertex.
  const start = next.keys().next().value;
  const loop = [start];
  let prev = -1, cur = start;
  for (;;) {
    const [n1, n2] = next.get(cur);
    const nxt = n1 !== prev ? n1 : n2;
    if (nxt === start) break;
    loop.push(nxt);
    prev = cur;
    cur = nxt;
    if (loop.length > next.size) break;                     // safety net
  }
  if (loop.length !== next.size) {
    return [T.borderNotLoop(next.size, start, loop.length)];
  }

  const xs = loop.map(v => vertices[v][0]), ys = loop.map(v => vertices[v][1]);
  const box = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  // The paper starts at (-1, -1) and its LARGER side reaches +1 (the other
  // side may stop short of it, for a non-square sheet).
  const startsAtCorner = Math.abs(box[0] + 1) <= tol && Math.abs(box[2] + 1) <= tol;
  const bigSideReaches = Math.abs(Math.max(box[1], box[3]) - 1) <= tol;
  const inside = box[1] <= 1 + tol && box[3] <= 1 + tol;
  if (!(startsAtCorner && bigSideReaches && inside)) {
    problems.push(T.borderBox(box));
  }

  // Point-in-polygon (ray casting) for every vertex not on the border.
  const onLoop = new Set(loop);
  vertices.forEach(([px, py], v) => {
    if (onLoop.has(v)) return;
    let inside = false;
    for (let i = 0; i < loop.length; i++) {
      const [x1, y1] = vertices[loop[i]];
      const [x2, y2] = vertices[loop[(i + 1) % loop.length]];
      if ((y1 > py) !== (y2 > py) && px < x1 + ((py - y1) * (x2 - x1)) / (y2 - y1)) inside = !inside;
    }
    if (!inside) problems.push(T.vertexOutside(v));
  });
  return problems;
}

// The border as an ordered list of vertex numbers going around the paper, or
// null if the border edges don't form exactly one closed loop (checkBorder
// explains why). Used to fill the paper in.
export function borderLoop(graph) {
  const next = new Map();
  for (const [a, b, type] of graph.edges) {
    if (type !== "b") continue;
    if (!next.has(a)) next.set(a, []);
    if (!next.has(b)) next.set(b, []);
    next.get(a).push(b);
    next.get(b).push(a);
  }
  if (next.size === 0 || [...next.values()].some(ns => ns.length !== 2)) return null;
  const start = next.keys().next().value;
  const loop = [start];
  let prev = -1, cur = start;
  for (;;) {
    const [n1, n2] = next.get(cur);
    const nxt = n1 !== prev ? n1 : n2;
    if (nxt === start) break;
    loop.push(nxt);
    prev = cur;
    cur = nxt;
    if (loop.length > next.size) return null;
  }
  return loop.length === next.size ? loop : null;
}


// ---------------------------------------------------------------------------
// Rescaling that accepts paper of any rectangular bounding box.
//
// The LARGER side of the pattern's bounding box is scaled to run from -1 to 1,
// and the paper is pushed into the bottom-left corner, so (-1, -1) is always
// the paper's lower-left corner. A square sheet fills [-1, 1]^2 exactly as
// before; a 3 x 2 sheet fills [-1, 1] x [-1, 1/3]. One uniform scale factor
// means every coordinate stays in Q(sqrt 2) if it was before.
//
// Returns { segments, square, width, height, scale }:
//   width, height : the border's bounding box in the file's own units
//   square        : false when width and height differ, which rules out
//                   reference-finding later (it needs a square sheet)
// flipY mirrors the pattern top-to-bottom first (for files with y pointing down).
// ---------------------------------------------------------------------------
export function rescaleToBox(segments, { flipY = false, squareTol = 1e-9 } = {}) {
  // The paper is whatever the remaining creases span. (Border types in the file
  // are not trusted: some programs leave parts of the outline marked as creases.)
  if (segments.length === 0) throw new Error(T.noCreases);
  const xs = segments.flatMap(s => [s.x1, s.x2]);
  const ys = segments.flatMap(s => [s.y1, s.y2]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  const width = xmax - xmin, height = ymax - ymin;
  if (!(width > 0 && height > 0)) throw new Error(T.noArea);

  const big = Math.max(width, height);
  const scale = 2 / big;
  const px = x => -1 + (x - xmin) * scale;
  const py = y => -1 + ((flipY ? ymin + ymax - y : y) - ymin) * scale;
  return {
    segments: segments.map(s => ({ ...s, x1: px(s.x1), y1: py(s.y1), x2: px(s.x2), y2: py(s.y2) })),
    square: Math.abs(width - height) <= squareTol * big,
    width, height, scale,
    // the same move for any other segments (e.g. the aux creases that were removed)
    apply: s => ({ ...s, x1: px(s.x1), y1: py(s.y1), x2: px(s.x2), y2: py(s.y2) }),
  };
}


// ---------------------------------------------------------------------------
// The perimeter is whatever surrounds the pattern -- not whatever the file
// called a border. Programs differ: some export the outline with a different
// type, or leave part of it as ordinary creases.
//
// Walks around every face of the drawing (the standard "half-edge" trick: at
// each vertex, arrive along one edge, leave along the next one clockwise). Faces
// that go round counter-clockwise are paper regions; the one face that goes
// round clockwise is the outside. Every edge touching the outside becomes 'b',
// every other edge becomes 'm'.
//
// Graph in, graph out ({ vertices, edges, problems }, with types reassigned).
// ---------------------------------------------------------------------------
export function assignBorder(graph) {
  const { vertices, edges } = graph;
  const problems = [...(graph.problems ?? [])];

  // neighbours of each vertex, sorted counter-clockwise
  const around = vertices.map(() => []);
  edges.forEach(([a, b]) => {
    around[a].push(b);
    around[b].push(a);
  });
  around.forEach((list, v) => {
    list.sort((p, q) =>
      Math.atan2(vertices[p][1] - vertices[v][1], vertices[p][0] - vertices[v][0]) -
      Math.atan2(vertices[q][1] - vertices[v][1], vertices[q][0] - vertices[v][0]));
  });

  // half-edge u->v keyed "u,v"; next half-edge of its face is v->w, where w is
  // the neighbour of v just clockwise of u
  const faceOf = new Map();
  const faces = [];
  for (const [a, b] of edges) {
    for (const [start, end] of [[a, b], [b, a]]) {
      if (faceOf.has(`${start},${end}`)) continue;
      const faceIndex = faces.length;
      const halfEdges = [];
      let u = start, v = end;
      while (!faceOf.has(`${u},${v}`)) {
        faceOf.set(`${u},${v}`, faceIndex);
        halfEdges.push([u, v]);
        const list = around[v];
        const w = list[(list.indexOf(u) - 1 + list.length) % list.length];
        u = v;
        v = w;
      }
      faces.push(halfEdges);
    }
  }

  // signed area of each face: counter-clockwise > 0, the outside is < 0
  const areas = faces.map(halfEdges =>
    halfEdges.reduce((sum, [u, v]) =>
      sum + (vertices[u][0] * vertices[v][1] - vertices[v][0] * vertices[u][1]) / 2, 0));
  const outside = areas.flatMap((area, i) => (area < 0 ? [i] : []));
  if (outside.length !== 1) {
    problems.push(T.noOutline(outside.length));
    return { ...graph, problems };
  }

  const newEdges = edges.map(([a, b, type]) => {
    const onOutside = faceOf.get(`${a},${b}`) === outside[0] || faceOf.get(`${b},${a}`) === outside[0];
    return [a, b, onOutside ? "b" : type === "v" ? "v" : "m"];   // (an assignment is never changed, except the outline is the border)
  });
  return { ...graph, edges: newEdges, problems };
}