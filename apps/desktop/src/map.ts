// Entry for the review-map THEATER window (map.html) — the animated-ASCII review
// map at full size, plus the narrated interactive JOURNEY through it. The doc (and the PR's
// unified diff, for inline excerpts) arrive via localStorage (the WKWebView data store
// IS shared between windows); live messaging (jump/ask/draft/tts) rides Tauri events
// through the Rust core — BroadcastChannel does NOT cross WKWebView windows.

import "./styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { renderReviewMap, type MapHandle } from "./asciimap";
import { startDeck, type DeckHandle } from "./deck";
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

// main window → theater: narration WAV chunks synthesized by the backend.
void listen<{ kind: string; id?: string; b64?: string; more?: boolean }>("pear-map-back", (ev) => {
  const m = ev.payload;
  if (m.kind === "speech" && m.id !== undefined)
    journey?.handleSpeech(m.id, m.b64 ?? "", m.more ?? false);
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
    // Split layout: the rail carries all the text — the canvas gets the full height.
    stageHeight: Math.max(window.innerHeight, 420),
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
  // (created up here so the journey handlers can hide/show it; wired + appended below)
  const deckBtn = document.createElement("button");
  deckBtn.className = "jr-launch deck-launch";
  deckBtn.textContent = "🃏 deck";
  deckBtn.title = "Flip through the findings as cards — add the keepers to your review (esc exits)";
  btn.addEventListener("click", () => {
    if (!handle || !currentDoc) return;
    btn.classList.add("hidden");
    deckBtn.classList.add("hidden");
    journey = startJourney(stage, handle, currentDoc, {
      getDiff: () => localStorage.getItem(MAP_DIFF_KEY),
      requestDiff: () => post({ kind: "need-diff" }),
      requestTts: (id, text) => post({ kind: "tts", id, text }),
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
        deckBtn.classList.remove("hidden");
        journey = null;
        exitJourney = null;
        obs.disconnect();
      }
    });
    obs.observe(stage, { childList: true });
  });
  stage.appendChild(btn);

  // The DECK — the same review as flip-through finding cards ("add to review" on the
  // keepers); selection + compiled-draft format are SHARED with the journey, so picks
  // made in either mode compile into the same review.
  let deck: DeckHandle | null = null;
  deckBtn.addEventListener("click", () => {
    if (deck || !currentDoc) return;
    btn.classList.add("hidden");
    deckBtn.classList.add("hidden");
    deck = startDeck(stage, currentDoc, {
      onJump: (path, line) => post({ kind: "jump", path, line }),
      onExport: (markdown, count) => {
        void navigator.clipboard.writeText(markdown).catch(() => {});
        post({ kind: "draft", markdown, count });
      },
      onExit: () => {
        deck = null;
        btn.classList.remove("hidden");
        deckBtn.classList.remove("hidden");
      },
    });
  });
  stage.appendChild(deckBtn);
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
