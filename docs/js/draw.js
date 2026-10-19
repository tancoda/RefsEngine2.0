// draw.js -- draws the pattern as uploaded (mountain / valley / aux / edge) into the page's <svg>, with its vertices
// as dots (hover: exact coordinates). Once the reference finder has looked, the vertices it found are the bigger
// black dots; click one to see how to fold it.
//
//   graph : { vertices: [[x, y], ...], edges: [[i, j], ...] }   in [-1, 1]
//   snapped : { exact: [[recipeX, recipeY], ...] }                a recipe is [m, n, D] = (m + n*sqrt2) / D, or null
//   show  : { original, refFound, refPoint, onVertexClick }      original = the segments as uploaded;
//           refFound = [{ index, xy, label }], refPoint = the vertex showing, onVertexClick(index)

import { TEXT as T } from "./text.js";
import { COLORS, LINE_WIDTH } from "./colors.js";
import { borderLoop } from "./clean.js";
import { setRadius, tagCircle } from "./zoom.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const DOT = 0.0087, DOT_HOVER = 0.0147, REF_DOT = 0.0113, REF_PICKED = 0.0227;
const MINUS = "−";

// [m, n, D] -> "(3 - 2√2)/4", "-√2/4", "1/2", "-1 + √2", "0"
export function formatRecipe([m, n, D]) {
  if (m === 0 && n === 0) return "0";
  const radical = (Math.abs(n) === 1 ? "" : Math.abs(n)) + "√2";
  const top = n === 0 ? `${m < 0 ? MINUS : ""}${Math.abs(m)}`
    : m === 0 ? `${n < 0 ? MINUS : ""}${radical}`
    : `${m < 0 ? MINUS : ""}${Math.abs(m)} ${n < 0 ? MINUS : "+"} ${radical}`;
  return D === 1 ? top : `${m !== 0 && n !== 0 ? `(${top})` : top}/${D}`;
}

// the page's recipe [m, n, D] means (m + n*sqrt2)/D on the paper from -1 to 1; on the paper from 0 to 1 that is
// (m + D, n, 2D) over a common divisor
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
export function unitRecipe([m, n, D]) {
  const g = gcd(gcd(Math.abs(m + D), Math.abs(n)), 2 * D) || 1;
  return [(m + D) / g, n / g, (2 * D) / g];
}

// what the hover shows, with the paper's corners at (0, 0), (1, 0), (1, 1), (0, 1)
const describe = (name, value, recipe) => {
  const unit = (value + 1) / 2;
  return recipe
    ? T.exactTip(name, unit, formatRecipe(unitRecipe(recipe)), unitRecipe(recipe))
    : T.noExactTip(name, unit);
};

export function drawPattern(svg, tooltip, graph, snapped, show = {}) {
  const make = (name, attrs) => {
    const el = svg.ownerDocument.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(name === "circle" ? { ...attrs, ...tagCircle(attrs) } : attrs)) el.setAttribute(key, String(value));
    return el;
  };
  const sy = y => -y;                                         // the pattern's y points up, the svg's down
  const segment = ([[x1, y1], [x2, y2]], attrs) => make("line", { x1, y1: sy(y1), x2, y2: sy(y2), "vector-effect": "non-scaling-stroke", ...attrs });
  const move = event => { tooltip.style.left = `${event.clientX + 14}px`; tooltip.style.top = `${event.clientY + 14}px`; };
  const place = (dot, r0, text) => {
    dot.addEventListener("mouseover", event => { setRadius(dot, Math.max(r0, DOT_HOVER)); tooltip.textContent = text; tooltip.hidden = false; move(event); });
    dot.addEventListener("mousemove", move);
    dot.addEventListener("mouseout", () => { setRadius(dot, r0); tooltip.hidden = true; });
  };

  svg.replaceChildren();
  tooltip.hidden = true;
  svg.setAttribute("viewBox", "-1.1 -1.1 2.2 2.2");

  const loop = borderLoop(graph);                             // the paper (the border may cut off corners)
  if (loop) svg.appendChild(make("polygon", { points: loop.map(v => `${graph.vertices[v][0]},${sy(graph.vertices[v][1])}`).join(" "), fill: COLORS.paper, stroke: "none", "pointer-events": "none" }));

  // the pattern as uploaded, bottom to top: aux, valley, mountain, edge
  for (const [type, color] of [["a", COLORS.aux], ["v", COLORS.valley], ["m", COLORS.mountain], ["b", COLORS.edge]]) {
    for (const s of show.original ?? []) {
      if (s.type === type) svg.appendChild(segment([[s.x1, s.y1], [s.x2, s.y2]], { stroke: color, "stroke-width": LINE_WIDTH, "stroke-linecap": "round" }));
    }
  }

  graph.edges.forEach(([a, b], ei) => {                       // invisible fat lines on every edge: hover for its number
    const hit = segment([graph.vertices[a], graph.vertices[b]], { stroke: "transparent", "stroke-width": 10 });
    hit.appendChild(make("title", {})).textContent = T.edgeTip(ei, a, b);
    svg.appendChild(hit);
  });

  const same = (p, q) => p && Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7;
  for (const { index, xy, label } of show.refFound ?? []) {   // the vertices the finder knows; the one showing is yellow with a glow
    const picked = same(show.refPoint, xy), r0 = picked ? REF_PICKED : REF_DOT;
    if (picked) for (const [r, o] of [[0.063, 0.3], [0.041, 0.5]]) {
      svg.appendChild(make("circle", { "data-keep": 1, cx: xy[0], cy: sy(xy[1]), r, fill: COLORS.refPickedGlow, "fill-opacity": o, "pointer-events": "none" }));
    }
    const dot = make("circle", { cx: xy[0], cy: sy(xy[1]), r: r0, fill: picked ? COLORS.refPicked : COLORS.refDot,
      stroke: picked ? COLORS.refPickedOutline : "transparent", "stroke-width": picked ? 2 : 0.03,
      ...(picked ? { "vector-effect": "non-scaling-stroke", "data-keep": 1, style: `filter: drop-shadow(0 0 5px ${COLORS.refPickedGlow})` } : {}) });
    dot.style.cursor = "pointer";
    place(dot, r0, label);
    dot.addEventListener("click", () => show.onVertexClick?.(index));
    svg.appendChild(dot);
  }

  graph.vertices.forEach((vertex, index) => {                 // the other vertices
    const [rx, ry] = snapped.exact[index];
    const matched = rx !== null && ry !== null;
    if (show.refFound && matched) return;                     // (the finder's dots stand in for these)
    const dot = make("circle", { cx: vertex[0], cy: sy(vertex[1]), r: DOT, fill: COLORS.vertexAssigned, stroke: "transparent", "stroke-width": 0.03 });
    place(dot, DOT, [T.vertexTip(index), describe("x", vertex[0], rx), describe("y", vertex[1], ry)].join("\n"));
    svg.appendChild(dot);
  });

  // everything but the vertex showing goes in one group, so dark mode can invert the drawing without touching it
  const art = make("g", { class: "art" }), kept = [];
  for (const node of [...svg.childNodes]) {
    if (node.getAttribute?.("data-keep")) kept.push(node); else art.appendChild(node);
  }
  svg.append(art, ...kept);
}