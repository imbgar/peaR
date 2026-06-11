// Entry for the review-map THEATER window (map.html) — the WebGL review galaxy at
// full size. Deliberately IPC-free: the doc arrives via localStorage (same origin as
// the main window), refresh nudges come as a `pear-map-refresh` event or a cross-window
// `storage` event, and jump/ask actions return to the main window over a
// BroadcastChannel — the main window owns the diff panel + terminals.

import "./styles.css";
import { renderReviewMap } from "./reviewmap";
import type { ReviewDoc } from "./protocol";

export const MAP_DOC_KEY = "pear.reviewmap.doc";
const chan = new BroadcastChannel("pear-map");

function render() {
  const host = document.getElementById("map-root")!;
  const raw = localStorage.getItem(MAP_DOC_KEY);
  if (!raw) {
    host.innerHTML = `<div class="map-empty">no review loaded — hit ⊞ Map in peaR</div>`;
    return;
  }
  let doc: ReviewDoc;
  let warnings: string[];
  try {
    const parsed = JSON.parse(raw) as { doc: ReviewDoc; warnings?: string[] };
    doc = parsed.doc;
    warnings = parsed.warnings ?? [];
  } catch {
    host.innerHTML = `<div class="map-empty">stored review doc is unreadable</div>`;
    return;
  }
  document.title = `peaR · review map — ${doc.subjects.map((s) => s.ref).join(" + ")}`;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  renderReviewMap(host, doc, warnings, {
    reduceMotion,
    // Fill the window: everything that isn't the canvas (verdict strip, purpose,
    // footer) takes ~230px; keep a sane floor.
    stageHeight: Math.max(window.innerHeight - 240, 420),
    onJump: (path, line) => chan.postMessage({ kind: "jump", path, line }),
    onAsk: (f, text) => chan.postMessage({ kind: "ask", finding: f, text }),
  });
}

render();
// Main window rewrote the doc (new review / re-load) → re-render.
window.addEventListener("pear-map-refresh", render);
window.addEventListener("storage", (e) => {
  if (e.key === MAP_DOC_KEY) render();
});
// Height is captured at render time; follow window resizes.
let resizeT = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = window.setTimeout(render, 180);
});
