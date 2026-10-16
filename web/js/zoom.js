// zoom.js -- scroll to zoom an svg view (towards the pointer), drag to move around once zoomed, "Reset view" to go back.
// The views are redrawn all the time (every click, every new fold) and each redraw sets the svg's viewBox again,
// so this watches the viewBox: whatever a drawing sets is the "full" view, and the zoom is applied on top of it.
//
//   makeZoomable(svg, { dragPan })   dragPan: a plain drag moves the zoomed view (the tree editor keeps plain drags
//                                    for its nodes: there it takes shift+drag or the middle button)
//   resetZoom(element)               back to the full view (an svg, or every svg inside the element)

const zooms = new WeakMap();

// Dots (and their hover areas) keep their size on the SCREEN while the view zooms: a circle drawn with data-r
// (its radius at no zoom) gets r = data-r / zoom. Lines already use non-scaling strokes.
function rescale(svg, k) {
  for (const el of svg.querySelectorAll("circle[data-r]")) {
    el.setAttribute("r", Number(el.dataset.r) / k);
    if (el.dataset.sw) el.setAttribute("stroke-width", Number(el.dataset.sw) / k);
  }
}
// change a dot's radius (hover) without losing that
export function setRadius(el, r0) {
  el.dataset.r = r0;
  el.setAttribute("r", r0 / (zooms.get(el.ownerSVGElement)?.k ?? 1));
}
// a circle's attributes, remembering the radius and stroke width the zoom has to scale
export function tagCircle(attrs) {
  const tags = {};
  if (attrs.r !== undefined) tags["data-r"] = attrs.r;
  if (attrs["stroke-width"] !== undefined && attrs["vector-effect"] === undefined) tags["data-sw"] = attrs["stroke-width"];
  return tags;
}
const MAX = 40;
const parse = text => text.trim().split(/[\s,]+/).map(Number);

export function makeZoomable(svg, { dragPan = true } = {}) {
  if (!svg || zooms.has(svg)) return;
  const z = { k: 1, ox: 0, oy: 0, base: null, own: null };
  zooms.set(svg, z);

  const apply = () => {
    if (!z.base) return;
    const [x, y, w, h] = z.base;
    z.ox = Math.min(Math.max(z.ox, 0), w - w / z.k);
    z.oy = Math.min(Math.max(z.oy, 0), h - h / z.k);
    z.own = z.k === 1 ? z.base.join(" ") : `${x + z.ox} ${y + z.oy} ${w / z.k} ${h / z.k}`;
    svg.setAttribute("viewBox", z.own);
    rescale(svg, z.k);
  };
  const read = () => {
    const text = svg.getAttribute("viewBox");
    if (!text || text === z.own) return;
    z.base = parse(text);
    apply();
  };
  new MutationObserver(read).observe(svg, { attributes: true, attributeFilter: ["viewBox"] });
  new MutationObserver(() => rescale(svg, z.k)).observe(svg, { childList: true });     // a redraw: new dots
  read();
  z.reset = () => { z.k = 1; z.ox = z.oy = 0; apply(); };

  const toUnits = event => {
    const m = svg.getScreenCTM();
    if (!m) return null;
    const p = svg.createSVGPoint();
    p.x = event.clientX; p.y = event.clientY;
    return p.matrixTransform(m.inverse());
  };

  svg.addEventListener("wheel", event => {
    if (!z.base) return;
    event.preventDefault();
    const at = toUnits(event);
    if (!at) return;
    const [bx, by] = z.base;
    const [vx, vy] = [bx + z.ox, by + z.oy];
    const k = Math.min(MAX, Math.max(1, z.k * Math.exp(-event.deltaY * 0.0015)));
    const f = k / z.k;
    // keep the point under the pointer where it is
    z.ox = at.x - (at.x - vx) / f - bx;
    z.oy = at.y - (at.y - vy) / f - by;
    z.k = k;
    apply();
  }, { passive: false });

  // moving the zoomed view
  let drag = null, moved = false;
  svg.addEventListener("pointerdown", event => {
    const wanted = event.button === 1 || event.shiftKey || (dragPan && event.button === 0 && z.k > 1);
    if (!wanted || !z.base) return;
    const m = svg.getScreenCTM();
    drag = { x: event.clientX, y: event.clientY, scale: m ? m.a : 1, shifted: event.button === 1 || event.shiftKey };
    moved = false;
    if (drag.shifted) { event.stopPropagation(); event.preventDefault(); }
  }, { capture: true });
  window.addEventListener("pointermove", event => {
    if (!drag) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!moved && Math.hypot(dx, dy) < 4) return;
    moved = true;
    z.ox -= dx / drag.scale; z.oy -= dy / drag.scale;
    drag.x = event.clientX; drag.y = event.clientY;
    apply();
  });
  window.addEventListener("pointerup", () => { drag = null; });
  // a drag that moved the view must not also count as a click on whatever is under the pointer
  svg.addEventListener("click", event => { if (moved) { event.stopPropagation(); event.preventDefault(); moved = false; } }, { capture: true });
}

export function resetZoom(element) {
  if (!element) return;
  const svgs = element.tagName?.toLowerCase() === "svg" ? [element] : [...element.querySelectorAll("svg")];
  svgs.forEach(svg => zooms.get(svg)?.reset());
}
