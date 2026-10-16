// main.js -- wires the page together: file -> parse / clean / snap (and Wiggle if that fails) -> draw, and the
// References panel (how to fold each vertex of the pattern, from the server's database).

import { wiggle, toCpText, toFoldText } from "./wiggle.js";
import { parsePattern } from "./parse.js";
import { preparePattern } from "./pipeline.js";
import { TEXT as T } from "./text.js";
import { findIslands } from "./islands.js";
import { COLORS } from "./colors.js";
import { drawPattern, formatRecipe, unitRecipe } from "./draw.js";
import { requestRefs, renderReferences } from "./refs.js";
import { makeZoomable, resetZoom } from "./zoom.js";

const $ = id => document.getElementById(id);
for (const [id, t] of Object.entries(T.page)) {           // the fixed texts and hover notes of index.html come from text.js
  const el = document.getElementById(id);
  if (!el) continue;
  if (t.text !== undefined) el.textContent = t.text;
  if (t.title !== undefined) el.title = t.title;
}
$("about-body").replaceChildren(...T.about.map(text => Object.assign(document.createElement("p"), { textContent: text })));
const canvas = $("cp-canvas"), tooltip = $("tooltip");
makeZoomable(canvas);
$("reset-view").addEventListener("click", () => resetZoom(canvas));

// Light / dark (index.html sets the first one before the page is drawn)
const syncTheme = () => { $("theme-toggle").textContent = document.documentElement.dataset.theme === "dark" ? T.lightMode : T.darkMode; };
$("theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch { /* private window: just for this visit */ }
  syncTheme();
});
syncTheme();

// The text at the top lives in an "Info" dropdown; it lights up when something is wrong, but never opens by itself.
function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").className = isError ? "error" : "";
  $("info").classList.toggle("alert", isError);
}

// A little progress bar: fraction = null (sliding, no telling how long), 0..1 (that much filled in), undefined (hidden).
function progress(id, fraction) {
  const el = $(id);
  if (fraction === undefined) { el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle("indeterminate", fraction === null);
  el.firstElementChild.style.width = fraction === null ? "" : `${Math.round(fraction * 100)}%`;
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$("cp-file").addEventListener("change", async () => {
  const file = $("cp-file").files[0];
  if (!file) return;
  $("file-name").textContent = file.name;
  const type = file.name.split(".").pop().toLowerCase();               // "pattern.CP" -> "cp"
  if (type !== "cp" && type !== "fold") { setStatus(T.unsupportedType(type), true); return; }
  let segments;
  try { segments = parsePattern({ type, text: await file.text() }); }
  catch (err) { setStatus(T.couldNotRead(err.message), true); return; }
  let found = { islands: [], loose: 0 };
  try { found = findIslands(segments); } catch (err) { console.warn("island scan failed:", err); }
  if (found.islands.length < 2) { showIslands([], type, null); handlePattern({ name: file.name, type, segments }); return; }
  const pick = i => {                                    // load one piece (the biggest to begin with)
    showIslands(found, type, i, pick);
    handlePattern({ name: `${file.name} (${T.islandName(i + 1).toLowerCase()})`, type, segments: found.islands[i].segments });
  };
  pick(0);
});

// the pieces of a file with several patterns: a small picture of each (about an inch), click one to work on it
function showIslands(found, type, picked, pick) {
  const box = $("islands"), list = $("islands-list");
  box.hidden = !found.islands?.length;
  list.replaceChildren();
  if (box.hidden) return;
  $("islands-label").textContent = T.islandsLabel(found.islands.length) + (found.loose ? "  " + T.islandsLoose(found.loose) : "");
  const NS = "http://www.w3.org/2000/svg";
  found.islands.forEach((island, i) => {
    const flip = type === "cp" ? 1 : -1;                  // (.cp has y pointing down, like the screen; .fold has it up)
    const [x1, y1, x2, y2] = island.bbox, top = flip > 0 ? y1 : -y2, bottom = flip > 0 ? y2 : -y1;
    const size = Math.max(x2 - x1, bottom - top) || 1, pad = size * 0.06;
    const left = (x1 + x2) / 2 - size / 2 - pad, upper = (top + bottom) / 2 - size / 2 - pad;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `${left} ${upper} ${size + 2 * pad} ${size + 2 * pad}`);
    const at = (x, y) => [x, y * flip];
    const bg = document.createElementNS(NS, "rect");
    Object.entries({ x: left, y: upper, width: size + 2 * pad, height: size + 2 * pad, fill: COLORS.paper }).forEach(([k, v]) => bg.setAttribute(k, v));
    svg.append(bg);
    for (const s of island.segments) {
      const line = document.createElementNS(NS, "line"), [ax, ay] = at(s.x1, s.y1), [bx, by] = at(s.x2, s.y2);
      Object.entries({ x1: ax, y1: ay, x2: bx, y2: by, stroke: COLORS[s.type === "b" ? "edge" : s.type === "v" ? "valley" : "mountain"], "stroke-width": 1.5, "vector-effect": "non-scaling-stroke" }).forEach(([k, v]) => line.setAttribute(k, v));
      svg.append(line);
    }
    const button = Object.assign(document.createElement("button"), { type: "button", className: i === picked ? "picked" : "" });
    button.append(svg, Object.assign(document.createElement("span"), { textContent: `${T.islandName(i + 1)} · ${T.islandCaption(island.creases)}` }));
    button.addEventListener("click", () => pick(i));
    list.append(button);
  });
}
// Clear the input when the file dialog opens, so picking the same file again still counts as a change.
$("cp-file").addEventListener("click", () => { $("cp-file").value = ""; });

// parse -> clean -> node -> snap -> draw, then the references
async function handlePattern({ name, type, segments, wiggled = null }) {
  try {
    const { box, graph, snapped, view, problems, original } = preparePattern(segments, type);
    resetZoom(canvas);
    refsState = { graph, view, original, square: box.square };
    $("refs-target").textContent = "";
    refsRequest++; refFound = null; refPick = null; refOrder = []; refCursor = null;
    $("refsWorkspace").replaceChildren();
    $("refs-status").textContent = "";
    updateRefsUI();
    drawCp();

    $("problem-list").textContent = problems.join("\n");
    $("problem-list").parentElement.hidden = problems.length === 0;
    if (problems.length > 0) console.warn(`${problems.length} problem(s):`, problems);
    showWiggle({ name, graph, snapped, view, problems, wiggled });
    showTldr({ box, snapped, view });
    const lines = [T.loaded(name, type),
      T.matched(snapped.stats.matched, snapped.stats.coordCount, snapped.stats.maxD)];
    if (!box.square) lines.push(T.notSquareNoRefs(box.width, box.height));
    if (problems.length > 0) lines.push("", T.problemCount(problems.length));
    setStatus(lines.join("\n"), problems.length > 0);
    await computeRefs();
  } catch (err) {
    console.error(err);
    progress("refs-progress");
    $("refs-status").textContent = T.refsError(err.message);
    setStatus(T.fileError(name, err.message), true);
  }
}

// ---------------------------------------------------------------------------
// Wiggle (wiggle.js): a pattern with problems whose edges are on the 22.5-degree grid but whose coordinates are a
// little off gets exact ones. If that works the pattern is shown again (as "... (wiggled)") and can be downloaded
// as .cp or .fold, scaled to -200..200.
// ---------------------------------------------------------------------------
let wiggleSource = null;                 // what the Wiggle button works on: { name, graph, snapped, before }
let wiggleResult = null;                 // the result being shown, for the downloads
const metrics = (problems, snapped, view) =>
  ({ problems: problems.length, unmatched: snapped.stats.coordCount - snapped.stats.matched, offGrid: view.badEdges.length });

function showWiggle({ name, graph, snapped, view, problems, wiggled }) {
  wiggleSource = { name, graph, snapped, before: metrics(problems, snapped, view) };
  wiggleResult = wiggled;
  $("wiggle-box").hidden = problems.length === 0 && !wiggled;
  $("wiggle-btn").hidden = problems.length === 0 || !!wiggled;
  $("wiggle-cp").hidden = $("wiggle-fold").hidden = !wiggled;
  $("wiggle-msg").replaceChildren();
  if (!wiggled) return;
  const { before, after } = wiggled.report;
  const table = document.createElement("table");
  table.className = "wiggle-report";
  const row = (label, a, b, head = false) => {
    const tr = table.insertRow();
    [label, a, b].forEach(text => { const cell = tr.insertCell(); cell.textContent = text; if (head) cell.className = "wiggle-head"; });
  };
  row("", T.reportBefore, T.reportAfter, true);
  row(T.reportProblems, before.problems, after.problems);
  row(T.reportNoExact, before.unmatched, after.unmatched);
  row(T.reportAlmostOnGrid, before.offGrid, after.offGrid);
  const bits = [T.movedSummary(wiggled.moved.length, wiggled.maxMoved)];
  if (wiggled.method === "snap") bits.push(T.snappedEach(wiggled.window));
  if (wiggled.mergedVertices) bits.push(T.merged(wiggled.mergedVertices));
  if (wiggled.crossings) bits.push(T.crossings(wiggled.crossings));
  if (wiggled.removed) bits.push(T.removed(wiggled.removed));
  const notes = [table, Object.assign(document.createElement("div"), { textContent: `${bits.join(", ")}.` })];
  if (wiggled.partial) {
    const off = wiggled.offGridEdges.length, un = wiggled.unresolved.length;
    notes.push(Object.assign(document.createElement("div"), { textContent: T.offGridStay(off, un) }));
  }
  if (wiggled.warnings.length) notes.push(Object.assign(document.createElement("div"), { textContent: wiggled.warnings.join(" ") }));
  $("wiggle-msg").append(...notes);
}

const baseName = () => (wiggleSource?.name ?? "pattern").replace(/\.[^.]*$/, "").replace(/ \(wiggled\)$/, "");
$("wiggle-cp").addEventListener("click", () => wiggleResult && download(`${baseName()}_wiggled.cp`, toCpText(wiggleResult.clean), "text/plain"));
$("wiggle-fold").addEventListener("click", () => wiggleResult && download(`${baseName()}_wiggled.fold`, toFoldText(wiggleResult.clean), "application/json"));
$("wiggle-btn").addEventListener("click", async event => {
  event.preventDefault();                              // (the button sits in the Info bar: don't let the click fold the panel)
  $("info").open = true;
  if (!wiggleSource) return;
  const { name, graph, snapped, before } = wiggleSource;
  const msg = $("wiggle-msg");
  msg.textContent = T.wiggling;
  await new Promise(resolve => setTimeout(resolve, 30));         // let the message show first
  let result;
  try { result = wiggle(graph, snapped); } catch (err) { result = { ok: false, reason: err.message }; }
  if (!result.ok) { msg.textContent = T.couldNotWiggle(result.reason); return; }
  const check = preparePattern(result.segments, "fold");
  if (!result.partial && check.problems.length) {
    msg.textContent = T.wiggledButProblems(check.problems.length, String(check.problems[0]).split("\n")[0]);
    return;
  }
  result.clean = check.graph;                         // what is saved: the cleaned pattern (straight-through vertices removed)
  result.removed = check.graph.merged;
  result.report = { before, after: metrics(check.problems, check.snapped, check.view) };
  await handlePattern({ name: T.wiggledName(name.replace(/\.[^.]*$/, "")), type: "fold", segments: result.segments, wiggled: result });
});

// The short version of what is wrong, as icons next to "Info" (web/icons; if a picture is missing, the symbol shows).
const TLDR_ICONS = { square: "icons/not-square.svg", angles: "icons/angles.svg", points: "icons/points.svg" };
const TLDR_SYMBOLS = { square: "▭", angles: "∠", points: "⋯" };
function showTldr({ box, snapped, view }) {
  const items = [];
  if (!box.square) items.push(["square", T.tldrNotSquare(box.width, box.height)]);
  const off = view.badEdges.length;
  if (off) items.push(["angles", T.tldrAlmostOnGrid(off)]);
  const unmatched = snapped.stats.coordCount - snapped.stats.matched;
  if (unmatched) items.push(["points", T.tldrNoExact(unmatched, snapped.stats.coordCount)]);
  $("tldr").replaceChildren(...items.map(([kind, tip]) => {
    const img = Object.assign(document.createElement("img"), { className: "tldr-icon", src: TLDR_ICONS[kind], alt: tip, title: tip });
    img.addEventListener("error", () => img.replaceWith(Object.assign(document.createElement("span"), { className: "tldr-icon", textContent: TLDR_SYMBOLS[kind], title: tip })));
    return img;
  }));
}

// ---------------------------------------------------------------------------
// References: how to fold each vertex of the pattern, step by step. Every vertex with exact coordinates is looked up;
// only the ones the database knows are drawn as black dots; click one to see its sequence. The suggestion: of the
// vertices off the paper's edge, the one with the most creases, then the fewest folds.
// ---------------------------------------------------------------------------
const refsSeen = new Map();            // what the database says about a vertex (by its exact coordinates): steps, or null. Never changes.
let refsState = null;                  // { graph, view, original, square } of the pattern on screen
let refCands = [];                     // the vertices looked up: { xy, row: [mx, nx, dx, my, ny, dy], deg }
let refResults = {};                   // candidate index -> steps
let refFound = null;                   // [{ index, xy, folds, label }] once looked up
let refPick = null;                    // the candidate whose sequence is showing
let refOrder = [];                     // the found vertices, simplest first
let refRecommended = null;
let refCursor = null;                  // where the counter buttons are in refOrder (null: not used yet)
let refsRequest = 0;                   // newest request wins

function drawCp() {
  if (!refsState) return;
  drawPattern(canvas, tooltip, refsState.graph, refsState.view,
    { original: refsState.original, refFound, refPoint: refPick == null ? null : refCands[refPick]?.xy, onVertexClick: pickDot });
}

// every vertex with exact coordinates, and how many creases end at it
function refCandidates() {
  const { graph, view } = refsState;
  const degree = graph.vertices.map(() => 0);
  graph.edges.forEach(([a, b]) => { degree[a]++; degree[b]++; });
  const cands = [];
  graph.vertices.forEach((xy, i) => {
    const [rx, ry] = view.exact[i];
    if (rx && ry) cands.push({ xy, row: [...rx, ...ry], deg: degree[i], vertex: i });
  });
  return cands;
}

// Ask the server about the vertices it has not been asked about yet (in chunks, with a progress bar), then show them.
async function computeRefs() {
  const ask = ++refsRequest;
  if (!refsState?.square) { progress("refs-progress"); applyRefs(); return; }
  refCands = refCandidates();
  const rows = refCands.map(c => c.row), keys = rows.map(r => r.join(","));
  const missing = keys.map((_, i) => i).filter(i => !refsSeen.has(keys[i]));
  
  progress("refs-progress");
  $("refs-status").textContent = T.refsLookingUp;
  const CHUNK = 60;
  try {
    for (let from = 0; from < missing.length; from += CHUNK) {
      if (ask !== refsRequest) return;                  // a newer lookup took over
      progress("refs-progress", from / missing.length);
      const part = missing.slice(from, from + CHUNK);
      const answer = await requestRefs(part.map(i => rows[i]));
      part.forEach((i, j) => refsSeen.set(keys[i], answer[j] ?? null));
    }
  } catch (err) {
    if (ask === refsRequest) { progress("refs-progress"); $("refs-status").textContent = err.message; }
    return;
  }
  if (ask !== refsRequest) return;
 
  progress("refs-progress");
  applyRefs();
}

// Inside an iframe the page keeps its height whatever sequence is showing: room is reserved for the longest one expected. A hidden grid of
// REFS_MAX_TILES diagrams (the same kind of tiles, with the longest caption) is measured at the current width.
const REFS_MAX_FOLDS = 8;               // the longest sequence there is
const REFS_MAX_TILES = REFS_MAX_FOLDS + 1;   // one diagram per fold, plus the last one with the target
function reserveRefsHeight() {
  const box = $("refsWorkspace");
  if (!("embedded" in document.documentElement.dataset) || !box.clientWidth) return;     // (only inside an iframe)
  const probe = document.createElement("div");
  probe.id = "refsWorkspace";           // (same id: the same styles)
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = `position:absolute;visibility:hidden;pointer-events:none;width:${box.clientWidth}px;margin:0`;
  const longest = Object.values(T.steps).reduce((a, b) => (b.length > a.length ? b : a), "");
  probe.innerHTML = `<div class="step"><svg viewBox="0 0 220 220"></svg><div class="caption">${longest}</div></div>`.repeat(REFS_MAX_TILES);
  box.after(probe);
  const card = $("refs-view");           // the invisible slot around the card gets the room; the card itself stays as tall as its content
  $("refs-slot").style.minHeight = `${probe.offsetHeight + card.offsetHeight - box.offsetHeight}px`;
  probe.remove();
}
let reserveTimer = null, reservedFor = 0;
new ResizeObserver(() => {                         // (the width decides how many diagrams fit in a row; it settles after loading too)
  const width = $("refsWorkspace").clientWidth;
  if (width === reservedFor) return;
  reservedFor = width;
  clearTimeout(reserveTimer);
  reserveTimer = setTimeout(() => { if (refFound?.length) reserveRefsHeight(); }, 100);
}).observe($("refsWorkspace"));

function applyRefs() {
  $("refs-target").textContent = "";
  $("refs-slot").style.minHeight = "";
  refPick = null; refFound = null; refResults = {}; refOrder = []; refRecommended = null; refCursor = null;
  $("refsWorkspace").replaceChildren();
  if (!refsState) { updateRefsUI(); return; }
  if (!refsState.square) { $("refs-status").textContent = T.refsNeedSquare; updateRefsUI(); return; }
  refCands.forEach((c, i) => { const steps = refsSeen.get(c.row.join(",")); if (steps) refResults[i] = steps; });
  // (a vertex already on the starting square, with just the root step, has nothing to fold)
  refFound = Object.entries(refResults).filter(([, steps]) => steps.length >= 2).map(([k, steps]) => ({
    index: Number(k), xy: refCands[k].xy, folds: steps.length - 1, label: `${T.vertexTip(refCands[k].vertex)}\n${T.folds(steps.length - 1)}` }));
  if (refFound.length === 0) {
    $("refs-status").textContent = T.refsNone;
  } else {
    reserveRefsHeight();
    const deg = f => refCands[f.index].deg;
    // the list: fewest folds first; within the same number of folds, the vertex with the most creases first
    refOrder = [...refFound].sort((a, b) => a.folds - b.folds || deg(b) - deg(a) || a.index - b.index);
    // the suggestion: each vertex scores up to 100, and the score closest to 100 wins. Creases at the vertex are worth twice
    // as much as the number of folds:
    //   creases: 1 = 0 points, 16 = 2/3 of 100      folds: 1 = 1/3 of 100, 7 = 0       (straight lines between)
    const WEIGHT_CREASES = 2 / 3, WEIGHT_FOLDS = 1 / 3;
    const clamp = x => Math.max(0, Math.min(1, x));
    const score = f => 100 * (WEIGHT_CREASES * clamp((deg(f) - 1) / 15) + WEIGHT_FOLDS * clamp((7 - f.folds) / 6));
    refRecommended = refFound.reduce((a, b) => {
      const da = Math.abs(100 - score(a)), db = Math.abs(100 - score(b));
      return db < da - 1e-9 || (Math.abs(db - da) <= 1e-9 && b.folds < a.folds) ? b : a;
    }).index;
    showRef(refRecommended);
    return;
  }
  updateRefsUI();
  drawCp();
}

function showRef(index) {
  const steps = refResults[index];
  if (!steps || steps.length < 2) return;
  refPick = index;
  refCursor = refOrder.findIndex(f => f.index === index);      // (next / previous go on from wherever this one is)
  const [x, y] = refCands[index].xy;
  renderReferences($("refsWorkspace"), steps, [(x + 1) / 2, (y + 1) / 2]);
  const [mx, nx, dx, my, ny, dy] = refCands[index].row;       // the page's [-1, 1] recipe; shown on the paper from 0 to 1
  $("refs-target").textContent = T.targetCoords(formatRecipe(unitRecipe([mx, nx, dx])), formatRecipe(unitRecipe([my, ny, dy])));
  $("refs-status").textContent = "";
  updateRefsUI();
  drawCp();
}
function pickDot(index) {                // clicking a dot: show it, and let the counter carry on from there
  showRef(index);
}
function stepRef(direction) {            // the counter: from the shortest sequence up (the first press goes to the shortest)
  if (!refOrder.length) return;
  refCursor = refCursor == null || refCursor < 0 ? 0 : Math.min(refOrder.length - 1, Math.max(0, refCursor + direction));
  showRef(refOrder[refCursor].index);
}
function updateRefsUI() {
  const n = refOrder.length, pos = refPick == null ? -1 : refOrder.findIndex(f => f.index === refPick);
  $("refs-recommended").disabled = n === 0;
  $("refs-first").disabled = n === 0;
  $("refs-prev").disabled = n === 0 || refCursor === 0;
  $("refs-next").disabled = n === 0 || refCursor === n - 1;
  $("refs-count").textContent = n === 0 ? "" : pos >= 0 ? T.refsCount(pos + 1, n) : T.refsFound(n);
}
$("refs-recommended").addEventListener("click", () => showRef(refRecommended));
$("refs-first").addEventListener("click", () => refOrder.length && showRef(refOrder[0].index));
$("refs-prev").addEventListener("click", () => stepRef(-1));
$("refs-next").addEventListener("click", () => stepRef(+1));