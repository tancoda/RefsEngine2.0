// pipeline.js -- the cleaning steps every pattern goes through before it can be folded:
//   segments -> drop aux -> rescale -> node -> pick the border -> snap to exact values
// Used by main.js.

import { nodeSegments } from "./parse.js";
import { snapGraph } from "./snap.js";
import { simplifySegments, rescaleToBox, assignBorder, mergeDegree2, checkBorder } from "./clean.js";

// A sheet that is a diamond (a square turned 45 degrees: its four corners at the middle of the sides of its bounding box,
// every crease inside it) is a pattern that was saved turned. Returns the segments turned 45 degrees counterclockwise
// as they look on screen, or null if the sheet is not a diamond. (cp files have y pointing down, fold files up.)
// (a little imprecision is fine: files drawn by hand are off by about a millionth)
const TOL = 1e-4;
export function turnDiamond(segments, simple, type) {
  const pts = simple.flatMap(s => [[s.x1, s.y1], [s.x2, s.y2]]);
  if (pts.length < 4) return null;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  if (!(hw > 0) || Math.abs(hw - hh) > TOL * hw) return null;
  const tol = TOL * hw;
  if (!pts.every(([x, y]) => Math.abs(x - cx) + Math.abs(y - cy) <= hw + tol)) return null;          // nothing outside the diamond
  const at = (x, y) => pts.some(p => Math.abs(p[0] - x) <= tol && Math.abs(p[1] - y) <= tol);
  if (!(at(x0, cy) && at(x1, cy) && at(cx, y0) && at(cx, y1))) return null;                          // its four corners
  // creases along all four sides (so it is the paper's outline, not a pattern that happens to fit in a diamond)
  const onSide = s => Math.abs(Math.abs(s.x1 - cx) + Math.abs(s.y1 - cy) - hw) <= tol && Math.abs(Math.abs(s.x2 - cx) + Math.abs(s.y2 - cy) - hw) <= tol;
  const sides = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([qx, qy]) =>
    simple.some(s => onSide(s) && (s.x1 - cx) * qx + (s.x2 - cx) * qx >= -tol && (s.y1 - cy) * qy + (s.y2 - cy) * qy >= -tol));
  if (!sides.every(Boolean)) return null;
  const c = Math.SQRT1_2, down = type === "cp";
  const turn = (x, y) => { const dx = x - cx, dy = y - cy; return down ? [cx + c * dx + c * dy, cy - c * dx + c * dy] : [cx + c * dx - c * dy, cy + c * dx + c * dy]; };
  return segments.map(s => { const [a, b] = turn(s.x1, s.y1), [d, e] = turn(s.x2, s.y2); return { ...s, x1: a, y1: b, x2: d, y2: e }; });
}

// type: "cp" | "fold" (cp files have y pointing down, so they are flipped).
// Returns { segments, box, graph, snapped, problems, original, turned }. May throw (e.g. no border at all).
// `turned` is true when the sheet was a diamond and has been turned 45 degrees counterclockwise (`segments` are the turned ones).
export function preparePattern(segments, type) {
  let simple = simplifySegments(segments);
  const turnedSegments = turnDiamond(segments, simple, type);
  if (turnedSegments) { segments = turnedSegments; simple = simplifySegments(segments); }
  const box = rescaleToBox(simple, { flipY: type === "cp", squareTol: 1e-6 });
  const graph = mergeDegree2(assignBorder(nodeSegments(box.segments)));
  const snapped = snapGraph(graph);
  const problems = [...graph.problems, ...checkBorder(graph), ...snapped.problems];
  return {
    turned: !!turnedSegments,
    segments, box, graph, snapped, problems,
    original: segments.map(box.apply),
  };
}