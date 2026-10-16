// islands.js -- finds the separate pieces ("islands") of a file: patterns that do not touch each other.
// A file can hold several crease patterns side by side; this tells them apart so one can be picked.
//
// findIslands(segments) -> [{ segments, bbox: [x1, y1, x2, y2], creases }, ...], biggest first.
// A piece counts if its lines close up into a shape (a loose line or a bare branch is not a pattern). A drawn border
// is not needed: the outline of the creases is the paper. Segments in, segments out: the
// pieces are made of the file's own lines (cut where they cross), in the file's own coordinates.

import { nodeSegments } from "./parse.js";
import { simplifySegments } from "./clean.js";

// a line is outline (not a crease) when it is drawn as border, or runs along the edge of the piece's bounding box
function onOutline(s, px, py) {
  if (s.type === "b") return true;
  const tol = 1e-6 * (Math.max(...px) - Math.min(...px) + Math.max(...py) - Math.min(...py));
  const near = (a, b) => Math.abs(a - b) <= tol;
  if (near(s.x1, s.x2)) return near(s.x1, Math.min(...px)) || near(s.x1, Math.max(...px));
  if (near(s.y1, s.y2)) return near(s.y1, Math.min(...py)) || near(s.y1, Math.max(...py));
  return false;
}

export function findIslands(segments) {
  const simple = simplifySegments(segments);
  if (simple.length === 0) return { islands: [], loose: 0 };
  const xs = simple.flatMap(s => [s.x1, s.x2]), ys = simple.flatMap(s => [s.y1, s.y2]);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) || 1;
  const graph = nodeSegments(simple, { tol: 1e-6 * extent });

  const parent = graph.vertices.map((_, i) => i);                  // union-find: vertices joined by an edge are one piece
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const [a, b] of graph.edges) parent[find(a)] = find(b);

  const pieces = new Map();
  for (const [a, b, type] of graph.edges) {
    const root = find(a);
    if (!pieces.has(root)) pieces.set(root, []);
    const [x1, y1] = graph.vertices[a], [x2, y2] = graph.vertices[b];
    pieces.get(root).push({ type, x1, y1, x2, y2 });
  }
  const verts = new Map();                                         // vertices per piece
  for (const [a] of graph.edges) verts.set(find(a), new Set());
  for (const [a, b] of graph.edges) { verts.get(find(a)).add(a); verts.get(find(a)).add(b); }
  const all = [...pieces.entries()];
  const islands = all.filter(([root, list]) => list.length >= verts.get(root).size && list.length >= 3).map(([, list]) => {
    const px = list.flatMap(s => [s.x1, s.x2]), py = list.flatMap(s => [s.y1, s.y2]);
    return { segments: list, bbox: [Math.min(...px), Math.min(...py), Math.max(...px), Math.max(...py)], creases: list.filter(s => !onOutline(s, px, py)).length };
  }).sort((p, q) => q.segments.length - p.segments.length);
  return { islands, loose: all.length - islands.length };
}