import { TEXT as T } from "./text.js";
// parse.js -- turns the text of a .cp or .fold file into a clean graph of
// floating-point vertices and edges, ready for exact snapping (snap.js).
//
// Pipeline (each stage is one exported function, so you can test it alone):
//
//   text --parsePattern--> segments --(clean.js: rescaleToBox)--> segments
//        --nodeSegments--> { vertices, edges, problems }
//
// DATA SHAPES
//   Segment : { type, x1, y1, x2, y2 }          floats; type is one of:
//             'b' border, 'm' mountain, 'v' valley, 'a' auxiliary/unassigned
//             (the engine's own letters; it uses 'h' for hinge later, so we
//             keep 'a' distinct for "came in as aux")
//   Graph   : { vertices: [[x, y], ...],         floats, inside [-1, 1]
//               edges:    [[i, j, type], ...],   i, j index into vertices
//               problems: [string, ...] }        things we refused to fix

// ---------------------------------------------------------------------------
// STAGE 1: text -> segments
// ---------------------------------------------------------------------------

const tolerance = 10 ** -9;

// .cp type codes -> engine letters.  (Verified: 1 border, 2 mountain,
// 3 valley, 4 aux.)
const CP_TYPES = { 1: "b", 2: "m", 3: "v", 4: "a" };

function parseCp(text) {
  const segments = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; ++n) {
    const line = lines[n].trim();
    if (line === "") continue;

    const pieces = line.split(/\s+/);

    if (pieces.length !== 5) {
        throw new Error(T.lineFive(n + 1, pieces.length));
    }

    const [code, x1, y1, x2, y2] = pieces.map(Number);   // strings -> numbers
    if ([code, x1, y1, x2, y2].some(Number.isNaN)) {
        throw new Error(T.lineNotNumber(n + 1));
    }

    const type = CP_TYPES[code];    
    if (type === undefined) {
        throw new Error(T.lineUnknown(n + 1, code));
    }

    if (Math.abs(x1 - x2) < tolerance && Math.abs(y1 - y2) < tolerance) continue;

    segments.push({ type, x1, y1, x2, y2 });
  }
  return segments;
}

// .fold assignment letters -> engine letters.
// B border, M mountain, V valley, F flat, U unassigned, (C cut, J join exist
// in the spec; decide whether to reject them -- probably reject).
const FOLD_TYPES = { B: "b", M: "m", V: "v", F: "a", U: "a" };

function parseFold(text) {
  const fold = JSON.parse(text); // main.js already reports bad JSON nicely
  const segments = [];

  const coords = fold.vertices_coords;
  const edges = fold.edges_vertices;
  if (!Array.isArray(coords) || !Array.isArray(edges)) {
    throw new Error(T.foldMissing);
  }
  const assignments = fold.edges_assignment || [];

  coords.forEach((v, i) => {
    if (v.length < 2 || v.length > 3) {
      throw new Error(T.foldCoords(i, v.length));
    }
    if (v.length === 3 && v[2] !== 0) {
      throw new Error(T.foldNotFlat(i, v[2]));
    }
  });

  edges.forEach(([a, b], i) => {
    if (coords[a] === undefined || coords[b] === undefined) {
      throw new Error(T.foldBadEdge(i));
    }
    const [x1, y1] = coords[a];
    const [x2, y2] = coords[b];

    const letter = assignments[i] ?? "U";            // missing -> unassigned
    const type = FOLD_TYPES[letter];
    if (type === undefined) {
      throw new Error(T.foldBadLetter(i, letter));
    }

    if (x1 === x2 && y1 === y2) return;              // zero-length: skip
    segments.push({ type, x1, y1, x2, y2 });
  });
  return segments;
}

export function parsePattern({ type, text }) {
  if (type === "cp") return parseCp(text);
  if (type === "fold") return parseFold(text);
  throw new Error(T.unsupportedKind(type));
}

// ---------------------------------------------------------------------------
// STAGE 2: node the segments into a proper graph
// ---------------------------------------------------------------------------

// tol is in the rescaled units ([-1, 1]); something like 1e-6 is a starting
// point, but it should relate to how many decimals the file actually has.
export function nodeSegments(segments, { tol = tolerance } = {}) {
  const vertices = [];
  const edges = [];
  const problems = [];

    const findOrAdd = (x, y) => {
        for (let j = 0; j < vertices.length; j++) {
            if (Math.hypot(vertices[j][0] - x, vertices[j][1] - y) < tol) {
                return j;                      // an existing vertex is close enough
            }
        }
        vertices.push([x, y]);                 // none close: this is a new vertex
        return vertices.length - 1;
    };

    for (const s of segments) {
        const a = findOrAdd(s.x1, s.y1);
        const b = findOrAdd(s.x2, s.y2);
        if (a !== b) edges.push([a, b, s.type]);   // skip segments that collapsed to a point
    }

    function pointOnSegment(pX, pY, x1, y1, x2, y2, tol = tolerance) {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (len === 0) return false;

        // how far along the segment from A, and how far sideways from the line
        const along = ((pX - x1) * dx + (pY - y1) * dy) / len;
        const off   = Math.abs((pX - x1) * dy - (pY - y1) * dx) / len;

        // within tol of the line, and strictly between the two endpoints
        return off < tol && along > tol && along < len - tol;
    }

    for (let k = 0; k < vertices.length; k++) {
        const [px, py] = vertices[k];
        for (let e = 0; e < edges.length; e++) {
            const [a, b, type] = edges[e];
            if (k === a || k === b) continue;          // v is already one of its ends
            const [x1, y1] = vertices[a];
            const [x2, y2] = vertices[b];
            if (pointOnSegment(px, py, x1, y1, x2, y2)) {
                edges[e] = [a, k, type];               // first half replaces the old edge
                edges.push([k, b, type]);              // second half is added
            }
        }
    }

    // Source - https://stackoverflow.com/a/24392281
    // Posted by Dan Fox, modified by community. See post 'Timeline' for change history
    // Retrieved 2026-10-12, License - CC BY-SA 4.0

    // returns true if the line from (a,b)->(c,d) intersects with (p,q)->(r,s)
    function intersects(a,b,c,d,p,q,r,s) {

    if (
        (Math.abs(a - p)<tol && Math.abs(b - q)<tol) ||
        (Math.abs(a - r)<tol && Math.abs(b - s)<tol) ||
        (Math.abs(c - p)<tol && Math.abs(d - q)<tol) ||
        (Math.abs(c - r)<tol && Math.abs(d - s)<tol)
    ) {
        return false;
    }

    var det, gamma, lambda;
    det = (c - a) * (s - q) - (r - p) * (d - b);
    if (det === 0) {
        return false;
    } else {
        lambda = ((s - q) * (r - a) + (p - r) * (s - b)) / det;
        gamma = ((b - d) * (r - a) + (c - a) * (s - b)) / det;
        return (0 < lambda && lambda < 1) && (0 < gamma && gamma < 1);
    }
    };

    const rank = { b: 3, m: 2, v: 2, a: 1 };
    const seen = new Map();                 // "i-j" -> index into deduped
    const deduped = [];
    for (const [a, b, type] of edges) {
        const key = Math.min(a, b) + "-" + Math.max(a, b);
        if (!seen.has(key)) {
            seen.set(key, deduped.length);
            deduped.push([a, b, type]);
            continue;
        }
        const existing = deduped[seen.get(key)];
        if (existing[2] === type) continue;                       // same type: merge
        if (rank[existing[2]] === rank[type]) {                   // m vs v
            problems.push(T.edgeTwice(a, b, existing[2], type));
        } else if (rank[type] > rank[existing[2]]) {
            existing[2] = type;                                   // more specific type wins
        }
    }

    for (let e = 0; e < edges.length; e++) {
        for (let f = e + 1; f < edges.length; f++) {
            const [x1, y1] = vertices[edges[e][0]];
            const [x2, y2] = vertices[edges[e][1]];
            const [x3, y3] = vertices[edges[f][0]];
            const [x4, y4] = vertices[edges[f][1]];

            if (intersects(x1, y1, x2, y2, x3, y3, x4, y4)) {
                problems.push(T.edgesCross(e, f, [x1, y1, x2, y2, x3, y3, x4, y4]));
            }
        }
    }

  return { vertices, edges, problems };
}