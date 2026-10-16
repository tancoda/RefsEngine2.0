// refs.js -- the References panel: how to fold a vertex of the crease pattern, step by step.
// The server (server.py) finds the sequence of creases that makes a vertex in the reference database; this file asks
// for it and draws one little diagram per step.
//
// A step is { function_name, new_crease_v1, new_crease_v2, refs }, in the unit square [0, 1]^2:
//   function_name : vertex_pair | angle_bisector | parallel_bisector | perp_through_vertex
//   refs          : the points / lines that step folds to ({ type: vertex|crease|edge, v | v1, v2 })


const SVG_NS = "http://www.w3.org/2000/svg";
// This site first; opened some other way on this computer (VS Code's Live Server has no /refs), the local server.
import { TEXT as T } from "./text.js";
const BASES = ["", "http://127.0.0.1:5000"];
let base = 0;

// Ask for the references of some vertices. rows = [[mx, nx, dx, my, ny, dy], ...] (exact recipes, page coordinates).
// Returns { 0: [step, ...], 3: [...] }: the vertices the database knows, by position in rows.
export async function requestRefs(rows) {
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vertices: rows }) };
  let answer = null;
  for (; base < BASES.length && !answer; base++) {
    try { answer = await (await fetch(`${BASES[base]}/refs`, init)).json(); } catch { /* not there: try the next */ }
  }
  if (!answer) { base = 0; throw new Error(T.serverUnreachable); }
  base--;                                  // (the one that answered stays first)
  if (!answer.ok) throw new Error(answer.problems.join("; "));
  return answer.results;
}

const INSTRUCTIONS = T.steps;

function instruction(fn, refs) {
  if (!fn || fn === "target") return INSTRUCTIONS.target;
  if (fn === "perp_through_vertex") return refs.some(r => r.type === "crease") ? INSTRUCTIONS.perp_diag : INSTRUCTIONS.perp_edge;
  return INSTRUCTIONS[fn] ?? fn.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase()) + ".";
}

// the server's keys (v, v1, v2) -> drawing keys (xy, xy1, xy2); a reference line is stretched to the edges of the paper
function normalizeRefs(refs) {
  const extend = (p1, p2) => {
    const EPS = 1e-9, dx = p2[0] - p1[0], dy = p2[1] - p1[1];
    if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return [p1, p2];
    const pts = [];
    const add = t => {
      const x = p1[0] + t * dx, y = p1[1] + t * dy;
      if (x >= -EPS && x <= 1 + EPS && y >= -EPS && y <= 1 + EPS && !pts.some(p => Math.hypot(p[0] - x, p[1] - y) < 1e-6)) pts.push([x, y]);
    };
    if (Math.abs(dx) > EPS) { add(-p1[0] / dx); add((1 - p1[0]) / dx); }
    if (Math.abs(dy) > EPS) { add(-p1[1] / dy); add((1 - p1[1]) / dy); }
    return pts.length >= 2 ? [pts[0], pts[1]] : [p1, p2];
  };
  return refs.map(ref => {
    if (ref.type === "vertex") return { type: "vertex", xy: ref.v };
    const [xy1, xy2] = extend(ref.v1, ref.v2);
    return { type: ref.type, xy1, xy2 };
  });
}

// Each step shows the paper as it is BEFORE that step's crease, so the creases of the earlier steps pile up.
function buildSteps(ancestry) {
  const steps = [];
  const done = [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]]];
  for (const entry of ancestry) {
    if (entry.function_name === "root") continue;
    const [a, b] = [entry.new_crease_v1, entry.new_crease_v2];
    steps.push({ fn: entry.function_name, past: [...done], crease: [a, b], refs: normalizeRefs(entry.refs) });
    done.push([a, b]);
  }
  // a last picture with everything drawn, and the vertex itself
  steps.push({ fn: "target", past: [...done], crease: null, refs: [], final: true });
  return steps;
}

const make = (tag, attrs) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};

// Colours come from the page's theme (the --ref-* variables in index.html), so the diagrams sit on the page itself.
function drawStep(svg, step, size, target) {
  const scale = size * 0.9, pad = (size - scale) / 2;
  const tx = x => pad + x * scale, ty = y => size - (pad + y * scale);       // y points up
  const line = (p, q, color, width, extra = "") => svg.appendChild(make("line", {
    x1: tx(p[0]), y1: ty(p[1]), x2: tx(q[0]), y2: ty(q[1]), "stroke-linecap": "round",
    style: `stroke:var(${color});stroke-width:${width};${extra}`,
  }));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.appendChild(make("rect", { x: tx(0), y: ty(1), width: scale, height: scale, fill: "none", style: "stroke:var(--ref-square);stroke-width:2" }));
  for (const [p, q] of step.past.slice(4)) line(p, q, "--ref-past", 1.2);          // (the first four are the square itself)
  if (!step.final) {
    // what the step folds onto: highlighted
    for (const r of step.refs) if (r.type !== "vertex") line(r.xy1, r.xy2, "--ref-line", 3, "filter:var(--ref-glow)");
    if (step.crease) line(step.crease[0], step.crease[1], "--ref-new", 4);
    for (const r of step.refs) if (r.type === "vertex") {
      svg.appendChild(make("circle", { cx: tx(r.xy[0]), cy: ty(r.xy[1]), r: 7, fill: "none", style: "stroke:var(--ref-circle);stroke-width:2" }));
    }
  } else if (target) {
    svg.appendChild(make("circle", { cx: tx(target[0]), cy: ty(target[1]), r: 5, style: "fill:var(--ref-target)" }));
  }
}

// Fill `box` with the steps. ancestry = the server's list of steps (root first), target = the vertex in [0, 1] coordinates.
export function renderReferences(box, ancestry, target = null) {
  box.replaceChildren();
  buildSteps(ancestry).forEach((step, i) => {
    const cell = document.createElement("div");
    cell.className = "step";
    const svg = make("svg", { width: 220, height: 220 });
    drawStep(svg, step, 220, target);
    const caption = document.createElement("div");
    caption.className = "caption";
    caption.textContent = T.stepCaption(i + 1, instruction(step.fn, step.refs));
    cell.append(svg, caption);
    box.appendChild(cell);
  });
}