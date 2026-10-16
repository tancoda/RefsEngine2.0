// text.js -- EVERY sentence the page shows, in one place. Edit the words freely; keep the ${...} pieces (they are filled in
// with numbers / names) and the quote marks / backticks around each text.
//   * plain texts are in quotes:            "Wiggle"
//   * texts with numbers in them are small functions:  (n) => `${n} problem(s).`
// The whole page: buttons and hints first, then messages, then what the diagrams say, then error messages.

const s = n => (n === 1 ? "" : "s");          // "1 fold", "2 folds"

export const TEXT = {
  // ---------- fixed texts on the page (a title is the little note that appears when you hold the mouse over something) ----------
  page: {
    "page-title": { text: "22.5° Refs Engine 2.0" },
    "about-summary": { text: "About" },
    "theme-toggle": { title: "Light / Dark" },
    "choose-file": { text: "Choose crease pattern" },
    "file-name": { text: ".cp or .fold" },
    "info-summary": { text: "Info" },
    "status": { text: "No file loaded yet." },
    "problems-summary": { text: "Problems" },
    "wiggle-btn": { text: "Wiggle", title: "Floating point precision error; attempt to rectify" },
    "wiggle-cp": { text: "Download updated .cp", title: "The wiggled .cp" },
    "wiggle-fold": { text: "Download updated .fold", title: "The wiggled .fold" },
    "hint": { text: "Scroll over the pattern to zoom, drag to move. Click a vertex to show its reference sequence (refs without dots are not in the database)." },
    "reset-view": { text: "Reset zoom" },
    "refs-heading": { text: "References" },
    "refs-recommended": { text: "Recommended", title: "The suggested reference" },
    "refs-first": { text: "Solution 1", title: "The simplest reference" },
    "refs-prev": { title: "The previous vertex" },
    "refs-next": { title: "The next vertex" },
  },
  // ---------- the About panel: one string per paragraph. Write whatever you like (plain text). ----------
  about: [
    "Refs Engine 2.0",
    "HOW TO USE",
    "FILE UPLOAD",
    "FILE UPLOAD",
    "FILE UPLOAD",
    "FILE UPLOAD",
    "FILE UPLOAD",
    "FILE UPLOAD",
    "",
    "Each line in this list is its own paragraph.",
  ],
  islandsLabel: n => `This file has ${n} separate patterns. Pick the one to work on:`,
  islandName: i => `Piece ${i}`,
  islandCaption: creases => `${creases} crease${s(creases)}`,
  islandsLoose: n => `${n} non-square patterns were left out.`,
  lightMode: "Light mode",
  darkMode: "Dark mode",

  // ---------- messages after loading a file (the Info box) ----------
  unsupportedType: type => `Unsupported file type ".${type}". Please choose a .cp or .fold file.`,
  couldNotRead: msg => `Could not read file: ${msg}`,
  loaded: (name, type) => `Loaded ${name}`,
  matched: (matched, total, maxD) => `${matched} of ${total} distinct coordinates matched exactly (largest denominator: ${maxD})`,
  notSquareNoRefs: (w, h) => `Paper is ${w.toPrecision(6)} x ${h.toPrecision(6)}, not square: finding references is not possible for this pattern.`,
  problemCount: n => `${n} problem(s).`,
  fileError: (name, msg) => `${name}: ${msg}`,

  // ---------- the little icons next to "Info" (hold the mouse over one) ----------
  tldrNotSquare: (w, h) => `The paper is not square (${w.toPrecision(6)} x ${h.toPrecision(6)})`,
  tldrAlmostOnGrid: n => `${n} crease(s) are not quite 22.5° (red glow in the pattern). Wiggling may fix.`,
  tldrNoExact: (n, total) => `${n} of ${total} coordinates are unknown (red dots in the pattern). Wiggling may fix.`,

  // ---------- wiggling ----------
  wiggling: "Wiggling...",
  couldNotWiggle: reason => `Could not wiggle: ${reason}`,
  wiggledButProblems: (n, first) => `Wiggled to exact coordinates, but ${n} problem(s) remain: ${first}`,
  wiggledName: base => `${base} (wiggled)`,
  reportBefore: "before",
  reportAfter: "after",
  reportProblems: "problems",
  reportNoExact: "coordinates with no exact value",
  reportAlmostOnGrid: "creases not quite 22.5°",
  movedSummary: (n, largest) => `${n} vertices moved (largest ${largest.toExponential(1)}, the paper side is 2)`,
  snappedEach: window => `every coordinate snapped to its simplest exact value within ${window.toExponential(0)}`,
  merged: n => `${n} duplicate vertices merged`,
  crossings: n => `${n} crossing(s) given a vertex`,
  removed: n => `${n} redundant vertices removed`,
  offGridStay: (off, un) =>
    `${off} crease${off === 1 ? " is" : "s are"} off 22.5° and stay${off === 1 ? "s" : ""} as drawn` +
    (un ? `, and ${un} vertex(es) that touch them could not be decided and stay where they were` : "") + ". The rest is exact.",
  largestMove: m => `The largest move is ${m.toExponential(1)} (of a paper side of 2): look the result over before using it.`,

  // ---------- references ----------
  refsLookingUp: "looking up...",
  refsNeedSquare: "References need square paper.",
  refsNone: "None of this pattern's vertices are in the reference database.",
  refsError: msg => `Error: ${msg}`,
  folds: n => `${n} fold${s(n)}`,
  refsCount: (pos, n) => `${pos} of ${n}`,
  refsFound: n => `${n} found`,
  targetCoords: (x, y) => `x = ${x} \n y = ${y}`,
  serverUnreachable: "Could not reach the server. Is `python server.py` running?",

  // ---------- the diagrams: one sentence under each step ----------
  steps: {
    target: "Target vertex.",
    vertex_pair: "Crease through the circled points.",
    parallel_bisector: "Bring the highlighted creases together.",
    angle_bisector: "Crease an angle bisector.",
    perp_diag: "Crease through the circled point, perpendicular to the highlighted crease.",
    perp_edge: "Crease through the circled point, perpendicular to the edge.",
  },
  stepCaption: (i, sentence) => `${i}. ${sentence}`,

  // ---------- hovering over the pattern ----------
  edgeTip: (ei, a, b) => `Edge ${ei} (vertices ${a}-${b})`,
  vertexTip: i => `Vertex ${i}`,
  exactTip: (name, value, shown, recipe) => `${name} = ${value.toFixed(10)}  =  ${shown}   [${recipe.join(", ")}]`,
  noExactTip: (name, value) => `${name} = ${value.toFixed(10)}   (no exact match)`,

  // ---------- problems found in the file (the Problems list) ----------
  borderVertexEdges: (v, n) => `Border vertex ${v} has ${n} border edge(s); it needs exactly 2`,
  borderNotLoop: (size, start, loop) => `The border is not one closed loop (it has ${size} vertices, the loop through vertex ${start} has ${loop})`,
  borderBox: box => `The border's bounding box is [${box.map(v => v.toFixed(6)).join(", ")}]; expected it to start at (-1, -1) with its larger side reaching 1`,
  vertexOutside: v => `Vertex ${v} lies outside the border`,
  noOutline: n => `Could not find the outline of the paper (${n} outer regions found; the pattern may be in several pieces)`,
  noCreases: "The file has no creases or border",
  noArea: "The border has no area",
  coordNoMatch: (c, where, dist) => `Coordinate ${c} (${where}) did not match any exact value; nearest was ${dist.toExponential(2)} away`,
  coordAmbiguous: (c, where, recipe) => `Coordinate ${c} (${where}) matched ${recipe} but another value is almost as close`,
  whereVertices: (list, more) => `vertices ${list}${more ? ", ..." : ""}`,
  edgeOffGrid: (ei, a, b, deg) => `Edge ${ei} (vertices ${a}-${b}) is not 22.5° (off by ${deg} degrees)`,
  edgeTwice: (a, b, was, now) => `Edge between vertices ${a} and ${b} is drawn as both ${was} and ${now}`,
  edgesCross: (e, f, c) => `Edges ${e} and ${f} cross each other.\n x1: ${c[0]}; y1: ${c[1]};\n x2: ${c[2]}; y2: ${c[3]};\n x3: ${c[4]}; y3: ${c[5]};\n x4: ${c[6]}; y4: ${c[7]};`,

  // ---------- the wiggler could not do it ----------
  wiggleSome: (n, list, more) => `Could not find exact coordinates for ${n} vertex(es) (${list}${more ? ", ..." : ""}); there is not enough structure to decide them.`,
  wiggleNone: "Could not find exact coordinates for any vertex; there is not enough structure to decide them.",
  wiggleOffGrid: (n, list) => `${n} edge(s) would not be 22.5° after wiggling (vertices ${list}); the pattern is too far off.`,

  // ---------- problems reading the file ----------
  lineFive: (n, found) => `Line ${n}: expected 5 values, found ${found}`,
  lineNotNumber: n => `Line ${n}: contains something that isn't a number`,
  lineUnknown: (n, code) => `Line ${n}: unknown line type ${code}`,
  foldMissing: "File is missing vertices_coords or edges_vertices",
  foldCoords: (i, n) => `Vertex ${i} has ${n} coordinates`,
  foldNotFlat: (i, z) => `Vertex ${i} is not flat (z = ${z})`,
  foldBadEdge: i => `Edge ${i} refers to a missing vertex`,
  foldBadLetter: (i, letter) => `Edge ${i} has unsupported assignment "${letter}"`,
  unsupportedKind: type => `Unsupported type: ${type}`,
};
