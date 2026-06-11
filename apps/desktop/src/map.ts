// Entry for the review-map THEATER window (map.html) — the WebGL review galaxy at
// full size, plus the narrated interactive JOURNEY through it. Deliberately IPC-free:
// the doc (and the PR's unified diff, for inline excerpts) arrive via localStorage
// (same origin as the main window), refresh nudges come as a `pear-map-refresh` event
// or a cross-window `storage` event, and jump/ask/draft actions return to the main
// window over a BroadcastChannel — the main window owns the diff panel + terminals.

import "./styles.css";
import { renderReviewMap, type MapHandle } from "./reviewmap";
import { startJourney, type JourneyHandle } from "./journey";
import type { RdFinding, ReviewDoc } from "./protocol";

export const MAP_DOC_KEY = "pear.reviewmap.doc";
export const MAP_DIFF_KEY = "pear.reviewmap.diff";
const chan = new BroadcastChannel("pear-map");

let handle: MapHandle | null = null;
let currentDoc: ReviewDoc | null = null;
let journey: JourneyHandle | null = null;
let exitJourney: (() => void) | null = null;

// Narration WAVs synthesized by the backend arrive via the main window.
chan.addEventListener("message", (ev) => {
  const m = ev.data as { kind: string; id?: string; b64?: string };
  if (m.kind === "speech" && m.id !== undefined) journey?.handleSpeech(m.id, m.b64 ?? "");
});

const onAsk = (f: RdFinding, text: string) => chan.postMessage({ kind: "ask", finding: f, text });

function render() {
  exitJourney?.();
  exitJourney = null;
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
  currentDoc = doc;
  document.title = `peaR · review map — ${doc.subjects.map((s) => s.ref).join(" + ")}`;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  handle = renderReviewMap(host, doc, warnings, {
    reduceMotion,
    // Fill the window: everything that isn't the canvas (verdict strip, purpose,
    // footer) takes ~230px; keep a sane floor.
    stageHeight: Math.max(window.innerHeight - 240, 420),
    onJump: (path, line) => chan.postMessage({ kind: "jump", path, line }),
    onAsk,
  });
  mountJourneyButton(host);
}

function mountJourneyButton(host: HTMLElement) {
  const stage = host.querySelector<HTMLElement>(".rmap-stage");
  if (!stage) return;
  const btn = document.createElement("button");
  btn.className = "jr-launch";
  btn.textContent = "▶ journey";
  btn.title = "Narrated interactive flight through the review (esc exits)";
  btn.addEventListener("click", () => {
    if (!handle || !currentDoc) return;
    btn.classList.add("hidden");
    journey = startJourney(stage, handle, currentDoc, {
      getDiff: () => localStorage.getItem(MAP_DIFF_KEY),
      requestDiff: () => chan.postMessage({ kind: "need-diff" }),
      requestTts: (id, text) => chan.postMessage({ kind: "tts", id, text }),
      onAsk,
      onExport: (markdown, count) => {
        void navigator.clipboard.writeText(markdown).catch(() => {});
        chan.postMessage({ kind: "draft", markdown, count });
      },
    });
    exitJourney = () => {
      journey?.exit();
      journey = null;
      btn.classList.remove("hidden");
      exitJourney = null;
    };
    // startJourney's own exit (esc/✕) must also restore the launch button.
    const obs = new MutationObserver(() => {
      if (!stage.querySelector(".jr")) {
        btn.classList.remove("hidden");
        journey = null;
        exitJourney = null;
        obs.disconnect();
      }
    });
    obs.observe(stage, { childList: true });
  });
  stage.appendChild(btn);
}

render();
// Main window rewrote the doc (new review / re-load) → re-render.
window.addEventListener("pear-map-refresh", render);
window.addEventListener("storage", (e) => {
  if (e.key === MAP_DOC_KEY) render();
  // A diff arriving mid-journey: no re-render (that would eject the reviewer) — the
  // next finding step picks it up via getDiff().
});
// Height is captured at render time; follow window resizes (but never mid-journey).
let resizeT = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = window.setTimeout(() => {
    if (!document.querySelector(".jr")) render();
  }, 180);
});
