// Entry for the review-map THEATER window (map.html) — the WebGL review galaxy at
// full size, plus the narrated interactive JOURNEY through it. The doc (and the PR's
// unified diff, for inline excerpts) arrive via localStorage (the WKWebView data store
// IS shared between windows); live messaging (jump/ask/draft/tts) rides Tauri events
// through the Rust core — BroadcastChannel does NOT cross WKWebView windows.

import "./styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { renderReviewMap, type MapHandle } from "./reviewmap";
import { startJourney, type JourneyHandle } from "./journey";
import type { RdFinding, ReviewDoc } from "./protocol";

export const MAP_DOC_KEY = "pear.reviewmap.doc";
export const MAP_DIFF_KEY = "pear.reviewmap.diff";
/** theater → main window (jump/ask/draft/need-diff/tts). */
const post = (payload: unknown) => void emit("pear-map", payload);

let handle: MapHandle | null = null;
let currentDoc: ReviewDoc | null = null;
let journey: JourneyHandle | null = null;
let exitJourney: (() => void) | null = null;

// main window → theater: narration WAVs synthesized by the backend.
void listen<{ kind: string; id?: string; b64?: string }>("pear-map-back", (ev) => {
  const m = ev.payload;
  if (m.kind === "speech" && m.id !== undefined) journey?.handleSpeech(m.id, m.b64 ?? "");
});

const onAsk = (f: RdFinding, text: string) => post({ kind: "ask", finding: f, text });

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
    onJump: (path, line) => post({ kind: "jump", path, line }),
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
      requestDiff: () => post({ kind: "need-diff" }),
      requestTts: (id, text, backend, intensity) =>
        post({ kind: "tts", id, text, backend, intensity }),
      onAsk,
      onExport: (markdown, count) => {
        void navigator.clipboard.writeText(markdown).catch(() => {});
        post({ kind: "draft", markdown, count });
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
