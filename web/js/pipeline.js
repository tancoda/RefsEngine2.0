// pipeline.js -- the cleaning steps every pattern goes through before it can be folded:
//   segments -> drop aux -> rescale -> node -> pick the border -> snap to exact values
// Used by main.js.

import { nodeSegments } from "./parse.js";
import { snapGraph } from "./snap.js";
import { simplifySegments, rescaleToBox, assignBorder, mergeDegree2, offGridEdges, checkBorder } from "./clean.js";

// type: "cp" | "fold" (cp files have y pointing down, so they are flipped).
// Returns { segments, box, graph, snapped, view, problems, original }. May throw (e.g. no border at all).
export function preparePattern(segments, type) {
  const simple = simplifySegments(segments);
  const box = rescaleToBox(simple, { flipY: type === "cp", squareTol: 1e-6 });
  const graph = mergeDegree2(assignBorder(nodeSegments(box.segments)));
  const snapped = snapGraph(graph);
  const view = { ...snapped, badEdges: offGridEdges(graph) };
  const problems = [...graph.problems, ...checkBorder(graph), ...snapped.problems];
  return {
    segments, box, graph, snapped, view, problems,
    original: segments.map(box.apply),
  };
}