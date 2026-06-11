// The review JOURNEY — a narrated, interactive flight through the review galaxy
// (learning-ladder level 2, docs/PEARVIEW.md + context/memory/pearview-learning-ladder.md).
//
// Sequencing is borrowed from the video-explainer skill's beat model, adapted live:
//   · every step is a BEAT: spoken-register narration + a visual cue (a camera flight)
//   · audio-first: in auto-play the journey advances when the narration finishes —
//     the timeline fits the voice, never the reverse
//   · written vs spoken register: the dialog shows labels/fragments; the voice speaks
//     full sentences (never reads the UI aloud)
// The in-app voice engine is the webview's native speechSynthesis (instant, offline);
// the skill's Qwen3/Kokoro path stays the offline-render analog.
//
// The reviewer doesn't just watch: ␣ selects/deselects the current finding into THEIR
// review, the diff around each finding renders inline, and ⏎E exports the draft.

import { parseDiff, type DFile } from "./diff";
import type { RdFinding, ReviewDoc } from "./protocol";
import type { MapHandle } from "./reviewmap";

const SEV_GLYPH: Record<string, string> = {
  blocker: "⛔",
  fix_before_merge: "🔶",
  follow_up: "⏳",
  take_or_leave: "💭",
};
const SEV_SPOKEN: Record<string, string> = {
  blocker: "A blocker",
  fix_before_merge: "A fix-before-merge",
  follow_up: "A follow-up",
  take_or_leave: "A take-it-or-leave-it",
};
const STATE_SPOKEN: Record<string, string> = {
  ready: "ready to merge",
  ready_with_nits: "ready to merge, with nits",
  needs_work: "needs work before merging",
  blocked: "blocked",
};

type Step =
  | { kind: "arrival" }
  | { kind: "chapter"; beatIdx: number; count: number }
  | { kind: "finding"; beatIdx: number; f: RdFinding }
  | { kind: "departure" };

const SEV_ORDER = ["blocker", "fix_before_merge", "follow_up", "take_or_leave"];

/** Build the beat sequence: arrival → (chapter → its findings, severity-major)* → departure. */
function buildSteps(doc: ReviewDoc): Step[] {
  const steps: Step[] = [{ kind: "arrival" }];
  const beats = doc.understanding.walkthrough;
  const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");
  const docked = new Map<number, RdFinding[]>();
  for (const f of doc.findings) {
    let best = -1;
    if (f.anchor) {
      best = beats.findIndex((b) => b.anchors.some((a) => a.path === f.anchor!.path));
      if (best < 0)
        best = beats.findIndex((b) =>
          b.anchors.some((a) => dirOf(a.path) === dirOf(f.anchor!.path)),
        );
    }
    if (best < 0) best = beats.length;
    (docked.get(best) ?? docked.set(best, []).get(best)!).push(f);
  }
  const total = beats.length + (docked.has(beats.length) || beats.length === 0 ? 1 : 0);
  for (let i = 0; i < total; i++) {
    const fs = (docked.get(i) ?? []).slice().sort(
      (a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity),
    );
    steps.push({ kind: "chapter", beatIdx: i, count: fs.length });
    for (const f of fs) steps.push({ kind: "finding", beatIdx: i, f });
  }
  steps.push({ kind: "departure" });
  return steps;
}

// ── narration (spoken register — sentences, never UI labels) ──────────────────
function narrationFor(doc: ReviewDoc, step: Step, selected: Set<string>): string {
  const subj = doc.subjects[0];
  switch (step.kind) {
    case "arrival": {
      const l = doc.verdict.ledger;
      const counts: string[] = [];
      if (l.blocker) counts.push(`${l.blocker} blocker${l.blocker > 1 ? "s" : ""}`);
      if (l.fix_before_merge) counts.push(`${l.fix_before_merge} to fix before merge`);
      if (l.follow_up) counts.push(`${l.follow_up} follow-up${l.follow_up > 1 ? "s" : ""}`);
      const state = doc.verdict.per_subject[0]?.state ?? "ready";
      return (
        `Welcome to the review of ${subj?.title || subj?.ref || "this pull request"}. ` +
        `${doc.understanding.purpose} ` +
        `The verdict: ${STATE_SPOKEN[state] ?? state}` +
        (counts.length ? `, with ${counts.join(", ")}.` : ".") +
        ` Let's fly through it.`
      );
    }
    case "chapter": {
      const b = doc.understanding.walkthrough[step.beatIdx];
      if (!b) return `Finally, the findings that don't belong to a single chapter.`;
      const risk =
        b.risk === "high"
          ? " This is the riskiest part of the change."
          : b.risk === "medium"
            ? " Worth slowing down here."
            : "";
      return `Chapter ${step.beatIdx + 1}: ${b.title}. ${b.body || ""}${risk} ${
        step.count
          ? `${step.count} finding${step.count > 1 ? "s" : ""} orbit${step.count > 1 ? "" : "s"} here.`
          : "Nothing was flagged here."
      }`;
    }
    case "finding": {
      const f = step.f;
      const conf = Math.round((f.confidence ?? 1) * 100);
      const disputed = Object.values(f.engines).includes("dispute");
      if (f.type === "praise") return `Some praise: ${f.title}.`;
      if (f.type === "question") return `An open question: ${f.title}. You can answer it from the card below.`;
      // NOTE: keep this text free of selection state — stable text = stable cache
      // (the select hint lives in the written register, on the button).
      return (
        `${SEV_SPOKEN[f.severity] ?? "A"} ${f.type.replace(/_/g, " ")} finding, at ${conf} percent confidence. ` +
        `${f.title}. ${f.evidence || ""} ` +
        (f.rule?.why ? `Why it matters: ${f.rule.why} ` : "") +
        (disputed ? "Note: the engines disagree on this one." : "")
      );
    }
    case "departure": {
      const v = doc.verdict.per_subject[0];
      return (
        `That's the whole review. The verdict stands at ${STATE_SPOKEN[v?.state ?? "ready"]}` +
        (v?.justification ? `: ${v.justification}.` : ".") +
        ` You selected ${selected.size} finding${selected.size === 1 ? "" : "s"}. ` +
        `Press E to export your review draft.`
      );
    }
  }
}

// ── the controller ─────────────────────────────────────────────────────────────
export interface JourneyOpts {
  /** Unified diff text for the subject PR (for inline excerpts), if available. */
  getDiff: () => string | null;
  /** Ask the main window to fetch the diff (it owns the GitHub client). */
  requestDiff: () => void;
  /** Ask the backend (via the main window) to synthesize narration — Kokoro or
   *  Chatterbox (emotion dial). The WAV comes back through `JourneyHandle.handleSpeech`. */
  requestTts: (id: string, text: string, backend: string, intensity: number) => void;
  onAsk: (f: RdFinding, text: string) => void;
  onExport: (markdown: string, count: number) => void;
}

export interface JourneyHandle {
  exit: () => void;
  /** Deliver a synthesized narration WAV chunk (base64; empty final = synth failed).
   *  Streaming backends send one chunk per sentence, `more` until the last. */
  handleSpeech: (id: string, b64: string, more: boolean) => void;
}

export function startJourney(
  stage: HTMLElement,
  handle: MapHandle,
  doc: ReviewDoc,
  opts: JourneyOpts,
): JourneyHandle {
  const steps = buildSteps(doc);
  const selKey = `pear.journey.sel.${doc.subjects.map((s) => s.ref).join("+")}`;
  const selected = new Set<string>(JSON.parse(localStorage.getItem(selKey) ?? "[]") as string[]);
  for (const id of selected) handle.setSelected(id, true);
  let idx = 0;
  let voiceOn = localStorage.getItem("pear.journey.voice") !== "0";
  // Narration backend: kokoro (fast, neutral) or chatterbox (the skill's v5 emotion
  // dial — severity drives the exaggeration, see intensityFor).
  let ttsBackend = localStorage.getItem("pear.journey.tts") === "chatterbox" ? "chatterbox" : "kokoro";
  let autoOn = false;
  let parsedDiff: DFile[] | null = null;

  /** The emotion dial: how theatrically a beat is narrated (chatterbox only).
   *  0.25 deadpan · 0.5 neutral · 1.0 theatrical — severity earns drama. */
  const intensityFor = (s: Step): number => {
    switch (s.kind) {
      case "arrival":
        return 0.6; // welcoming
      case "departure":
        return 0.55;
      case "chapter": {
        const r = doc.understanding.walkthrough[s.beatIdx]?.risk;
        return r === "high" ? 0.7 : r === "medium" ? 0.55 : 0.45;
      }
      case "finding":
        if (s.f.type === "praise") return 0.7; // warm
        if (s.f.type === "question") return 0.55; // curious
        return s.f.severity === "blocker"
          ? 0.92 // alarmed
          : s.f.severity === "fix_before_merge"
            ? 0.72
            : s.f.severity === "follow_up"
              ? 0.5
              : 0.38; // nits stay deadpan
    }
  };

  handle.setJourneyMode(true);
  if (!opts.getDiff()) opts.requestDiff();

  // ── HUD scaffolding ──
  const hud = document.createElement("div");
  hud.className = "jr";
  hud.innerHTML = `
    <div class="jr-top">
      <span class="jr-progress"></span>
      <span class="jr-selcount"></span>
      <span class="jr-preload hidden"><span class="jr-pre-label"></span><span class="jr-pre-track"><span class="jr-pre-fill"></span></span></span>
      <span class="jr-spacer"></span>
      <button class="jr-btn jr-voice" title="toggle narration (V)"></button>
      <button class="jr-btn jr-tts" title="narration voice: kokoro (fast) / chatterbox (emotion dial — severity earns drama) (B)"></button>
      <button class="jr-btn jr-auto" title="auto-play: advance when narration ends (A)"></button>
      <button class="jr-btn jr-keys" title="key bindings (?)">⌨ keys</button>
      <button class="jr-btn jr-exit" title="exit journey (esc)">✕ exit</button>
    </div>
    <div class="jr-dialog">
      <div class="jr-card"></div>
      <div class="jr-nav">
        <button class="jr-btn jr-prev" title="previous (←)">← prev</button>
        <span class="jr-stepname"></span>
        <button class="jr-btn jr-next primary" title="next (→)">next →</button>
      </div>
    </div>
    <div class="jr-legend hidden">
      <b>journey keys</b>
      <div class="jr-leg-grid">
        <kbd>→</kbd><span>next step</span>
        <kbd>←</kbd><span>previous step</span>
        <kbd>␣</kbd><span>select / deselect finding → your review</span>
        <kbd>V</kbd><span>voice narration on/off</span>
        <kbd>B</kbd><span>voice backend: kokoro ↔ chatterbox (emotion dial)</span>
        <kbd>A</kbd><span>auto-play (advance when narration ends)</span>
        <kbd>D</kbd><span>open the full detail card</span>
        <kbd>E</kbd><span>export your review draft</span>
        <kbd>?</kbd><span>this legend</span>
        <kbd>esc</kbd><span>exit the journey</span>
      </div>
    </div>`;
  stage.appendChild(hud);
  const $ = <T extends HTMLElement>(sel: string) => hud.querySelector<T>(sel)!;
  const card = $(".jr-card");
  const legend = $(".jr-legend");

  // ── narration engine ───────────────────────────────────────────────────────────
  // Kokoro replies with ONE wav; chatterbox is ~realtime, so it STREAMS one wav per
  // sentence — the player runs a chunk queue (start speaking after sentence one).
  // A priority scheduler keeps exactly ONE request in flight: the current step always
  // beats prefetch, and superseded wants are simply dropped (no FIFO starvation).
  let autoTimer = 0;
  let audio: HTMLAudioElement | null = null;
  interface CacheEntry {
    chunks: string[];
    done: boolean;
    failed: boolean;
  }
  const ttsCache = new Map<string, CacheEntry>(); // narration-id → chunks
  let ttsDead = false; // backend said it can't synth — stop asking
  let fallbackTimer = 0;

  // Player state: the narration currently being voiced (chunks may still stream in).
  let play: { id: string; queue: string[]; playing: boolean; done: boolean } | null = null;
  // Scheduler state.
  interface TtsReq {
    id: string;
    text: string;
    intensity: number;
  }
  let inFlight: string | null = null;
  let wantNow: TtsReq | null = null; // current step — priority
  let wantNext: TtsReq | null = null; // prefetch — best effort
  let wantBulk: TtsReq[] = []; // background preload of the whole journey (chatterbox)

  const nid = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return `n${(h >>> 0).toString(36)}`;
  };
  const reqFor = (i: number): TtsReq => {
    const text = narrationFor(doc, steps[i], selected);
    const intensity = intensityFor(steps[i]);
    return { id: nid(`${ttsBackend}:${intensity}:${text}`), text, intensity };
  };
  // Drop the galaxy to half-rate rendering while chatterbox is on the GPU.
  const syncPower = () =>
    handle.setLowPower(inFlight !== null && ttsBackend === "chatterbox");
  const pump = () => {
    if (inFlight || ttsDead) return;
    const r = wantNow ?? wantNext ?? wantBulk[0] ?? null;
    if (!r) {
      syncPower();
      return;
    }
    if (r === wantNow) wantNow = null;
    else if (r === wantNext) wantNext = null;
    else wantBulk.shift();
    if (ttsCache.get(r.id)?.done) return pump(); // already cached — next want
    inFlight = r.id;
    syncPower();
    opts.requestTts(r.id, r.text, ttsBackend, r.intensity);
  };

  // ── background preload (the whole journey's narration, chatterbox) ──
  // Departure is excluded — its narration depends on the selection count.
  const preloadable = (): number[] =>
    steps.map((s, i) => (s.kind === "departure" ? -1 : i)).filter((i) => i >= 0);
  const startPreload = () => {
    wantBulk = [];
    for (const i of preloadable()) {
      const r = reqFor(i);
      if (!ttsCache.get(r.id)?.done && inFlight !== r.id) wantBulk.push(r);
    }
    updatePreloadUi();
    pump();
  };
  const cancelPreload = () => {
    wantBulk = [];
    updatePreloadUi();
  };
  const updatePreloadUi = () => {
    const el = hud.querySelector<HTMLElement>(".jr-preload");
    if (!el) return;
    const ids = preloadable().map((i) => reqFor(i).id);
    const done = ids.filter((id) => ttsCache.get(id)?.done).length;
    const active = ttsBackend === "chatterbox" && done < ids.length && (wantBulk.length > 0 || inFlight !== null);
    if (!active) {
      el.classList.toggle("hidden", true);
      return;
    }
    el.classList.remove("hidden");
    el.querySelector(".jr-pre-label")!.textContent = `🎭 caching ${done}/${ids.length}`;
    (el.querySelector(".jr-pre-fill") as HTMLElement).style.width =
      `${Math.round((done / Math.max(ids.length, 1)) * 100)}%`;
  };

  const onNarrationEnd = () => {
    if (autoOn && idx < steps.length - 1) autoTimer = window.setTimeout(() => go(idx + 1), 450);
  };
  const stopNarration = () => {
    if (audio) {
      audio.onended = null;
      audio.pause();
      audio = null;
    }
    speechSynthesis.cancel();
    clearTimeout(fallbackTimer);
    play = null;
    wantNow = null;
  };
  const playNextChunk = () => {
    if (!play) return;
    const b64 = play.queue.shift();
    if (b64 !== undefined) {
      play.playing = true;
      audio = new Audio(`data:audio/wav;base64,${b64}`);
      audio.onended = playNextChunk;
      void audio.play().catch(() => {
        if (play) play.playing = false;
      });
    } else {
      play.playing = false;
      if (play.done) {
        play = null;
        onNarrationEnd();
      }
      // else: drained ahead of the synth — the next arriving chunk resumes playback.
    }
  };
  const pickVoice = (): SpeechSynthesisVoice | null => {
    const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    return (
      vs.find((v) => /samantha|ava|allison|serena/i.test(v.name)) ??
      vs.find((v) => v.default) ??
      vs[0] ??
      null
    );
  };
  const sysSpeak = (text: string) => {
    const utter = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) utter.voice = v;
    utter.rate = 1.04;
    utter.onend = onNarrationEnd;
    speechSynthesis.speak(utter);
  };
  const narrate = (text: string, intensity: number) => {
    stopNarration();
    if (!voiceOn) return;
    const id = nid(`${ttsBackend}:${intensity}:${text}`);
    const entry = ttsCache.get(id);
    if (entry?.failed || ttsDead) return sysSpeak(text);
    // Attach the player to this id — cached/streamed chunks play in order.
    play = { id, queue: [...(entry?.chunks ?? [])], playing: false, done: entry?.done ?? false };
    playNextChunk();
    if (!entry?.done && inFlight !== id) {
      wantNow = { id, text, intensity };
      pump();
    }
    if (!entry?.done) {
      // Don't leave silence forever (first synth includes the one-time model load).
      fallbackTimer = window.setTimeout(
        () => {
          if (play?.id === id && !play.playing && play.queue.length === 0) sysSpeak(text);
        },
        ttsBackend === "chatterbox" ? 45000 : 15000,
      );
    }
  };
  /** Queue a prefetch of step `i` (one ahead) — never preempts the current step. */
  const prefetch = (i: number) => {
    if (ttsDead || !voiceOn || i < 0 || i >= steps.length) return;
    const r = reqFor(i);
    if (ttsCache.get(r.id)?.done || inFlight === r.id) return;
    wantNext = r;
    pump();
  };
  const handleSpeech = (id: string, b64: string, more: boolean) => {
    if (id === "__dead__") {
      ttsDead = true;
      return;
    }
    let entry = ttsCache.get(id);
    if (!entry) {
      entry = { chunks: [], done: false, failed: false };
      ttsCache.set(id, entry);
    }
    if (b64) entry.chunks.push(b64);
    if (!more) {
      entry.done = true;
      entry.failed = entry.chunks.length === 0;
    }
    if (inFlight === id && !more) {
      inFlight = null;
      syncPower();
      pump(); // serve the next want (current step first)
      updatePreloadUi();
    }
    if (play?.id === id) {
      if (b64) {
        play.queue.push(b64);
        clearTimeout(fallbackTimer);
        if (!play.playing) playNextChunk();
      }
      if (!more) {
        play.done = true;
        if (entry.failed) {
          // Synthesis produced nothing — speak the step with the system voice.
          const cur = steps[idx];
          play = null;
          sysSpeak(narrationFor(doc, cur, selected));
        } else if (!play.playing && play.queue.length === 0) {
          play = null;
          onNarrationEnd();
        }
      }
    }
  };

  // ── diff excerpt for a finding ──
  const diffExcerpt = (f: RdFinding): HTMLElement | null => {
    if (!f.anchor) return null;
    if (!parsedDiff) {
      const raw = opts.getDiff();
      if (raw) parsedDiff = parseDiff(raw);
    }
    const file = parsedDiff?.find((d) => d.path === f.anchor!.path);
    if (!file || file.binary || !file.hunks.length) return null;
    // The hunk containing the anchor line (new side), else the first hunk.
    const line = f.anchor.line;
    const hunk =
      (line != null &&
        file.hunks.find((h) => h.lines.some((l) => l.newNo === line))) ||
      file.hunks[0];
    const rows = hunk.lines;
    let lo = 0;
    let hi = rows.length;
    if (line != null) {
      const at = rows.findIndex((l) => l.newNo === line);
      if (at >= 0) {
        lo = Math.max(0, at - 7);
        hi = Math.min(rows.length, at + 8);
      }
    } else {
      hi = Math.min(rows.length, 14);
    }
    const wrap = document.createElement("div");
    wrap.className = "jr-diff";
    const head = document.createElement("div");
    head.className = "jr-diff-head";
    head.textContent = `${file.path}  ·  @@ ${hunk.header || ""}`;
    wrap.appendChild(head);
    const pre = document.createElement("pre");
    pre.className = "jr-diff-body";
    for (const l of rows.slice(lo, hi)) {
      const row = document.createElement("span");
      row.className = `jr-dl jr-${l.kind}${l.newNo === line ? " jr-anchor-line" : ""}`;
      const no = (l.newNo ?? l.oldNo ?? "").toString().padStart(5, " ");
      row.textContent = `${no}  ${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}\n`;
      pre.appendChild(row);
    }
    wrap.appendChild(pre);
    return wrap;
  };

  // ── per-step render ──
  const stepName = (s: Step): string =>
    s.kind === "arrival"
      ? "arrival"
      : s.kind === "departure"
        ? "verdict"
        : s.kind === "chapter"
          ? `chapter ${s.beatIdx + 1}`
          : `${SEV_GLYPH[s.f.severity] ?? ""} ${s.f.id}`;

  const refreshHud = () => {
    $(".jr-progress").textContent = `${idx + 1} / ${steps.length}`;
    $(".jr-selcount").textContent = selected.size ? `✓ ${selected.size} in your review` : "";
    $(".jr-voice").textContent = voiceOn ? "🔊 voice on" : "🔇 voice off";
    $(".jr-tts").textContent = ttsBackend === "chatterbox" ? "🎭 chatterbox" : "🎙 kokoro";
    $(".jr-tts").classList.toggle("on", ttsBackend === "chatterbox");
    $(".jr-auto").textContent = autoOn ? "▶ auto" : "⏸ manual";
    $(".jr-auto").classList.toggle("on", autoOn);
    $(".jr-voice").classList.toggle("on", voiceOn);
    $(".jr-stepname").textContent = stepName(steps[idx]);
    ($(".jr-prev") as HTMLButtonElement).disabled = idx === 0;
    ($(".jr-next") as HTMLButtonElement).disabled = idx === steps.length - 1;
  };

  const renderStep = () => {
    const s = steps[idx];
    card.innerHTML = "";
    // Camera cue (the beat's "reveal").
    if (s.kind === "arrival" || s.kind === "departure") handle.focusWide();
    else if (s.kind === "chapter") {
      const p = handle.planetAt(s.beatIdx);
      if (p) handle.focus(p, 4.2);
    } else {
      const m = handle.moonOf(s.f.id);
      if (m) handle.focus(m, 2.0);
    }
    // Dialog content (written register: labels + fragments).
    if (s.kind === "arrival") {
      const v = doc.verdict.per_subject[0];
      card.innerHTML = `<div class="jr-kicker">the review</div>
        <div class="jr-title">${esc(doc.subjects[0]?.title || doc.subjects[0]?.ref || "")}</div>
        <div class="jr-body">${esc(doc.understanding.purpose)}</div>
        <div class="jr-chips"><span class="jr-chip jr-state-${v?.state}">${esc(v?.state.replace(/_/g, " ") ?? "")}</span>
        ${doc.understanding.verified.map((x) => `<span class="jr-chip">${esc(x)}</span>`).join("")}</div>`;
    } else if (s.kind === "chapter") {
      const b = doc.understanding.walkthrough[s.beatIdx];
      card.innerHTML = `<div class="jr-kicker">chapter ${s.beatIdx + 1}${b ? ` · risk ${b.risk}` : ""}</div>
        <div class="jr-title">${esc(b?.title ?? "other findings")}</div>
        ${b?.body ? `<div class="jr-body">${esc(b.body)}</div>` : ""}
        <div class="jr-chips"><span class="jr-chip">${s.count} finding${s.count === 1 ? "" : "s"}</span></div>`;
    } else if (s.kind === "finding") {
      const f = s.f;
      const isSel = selected.has(f.id);
      const eng = Object.entries(f.engines)
        .map(([e, verd]) => `${e}:${verd}`)
        .join(" · ");
      card.innerHTML = `<div class="jr-kicker">${SEV_GLYPH[f.severity] ?? ""} ${esc(f.severity.replace(/_/g, " "))} · [${esc(f.type)}] · ${Math.round((f.confidence ?? 1) * 100)}%${eng ? ` · ${esc(eng)}` : ""}</div>
        <div class="jr-title">${esc(f.title)}</div>
        ${f.evidence ? `<div class="jr-body">${esc(f.evidence)}</div>` : ""}
        ${f.rule?.why ? `<div class="jr-why"><b>why this matters</b><br>${esc(f.rule.why)}</div>` : ""}`;
      const ex = diffExcerpt(f);
      if (ex) card.appendChild(ex);
      else if (f.suggestion?.patch) {
        const pre = document.createElement("pre");
        pre.className = "jr-diff-body jr-patch";
        pre.textContent = f.suggestion.patch;
        card.appendChild(pre);
      }
      const selRow = document.createElement("div");
      selRow.className = "jr-selrow";
      selRow.innerHTML = `<button class="jr-btn jr-sel ${isSel ? "on" : ""}">${isSel ? "✓ in your review — ␣ to remove" : "␣ add to your review"}</button>`;
      selRow.querySelector("button")!.addEventListener("click", () => toggleSel());
      card.appendChild(selRow);
      if (f.type === "question") {
        const row = document.createElement("div");
        row.className = "jr-ask";
        const input = document.createElement("input");
        input.placeholder = "answer / ask the agent…";
        const go2 = document.createElement("button");
        go2.className = "jr-btn";
        go2.textContent = "⏎ to terminal";
        const fire = () => {
          if (input.value.trim()) {
            opts.onAsk(f, input.value.trim());
            input.value = "";
          }
        };
        go2.addEventListener("click", fire);
        input.addEventListener("keydown", (e) => {
          e.stopPropagation(); // typing here must not trigger journey keys
          if (e.key === "Enter") fire();
        });
        row.append(input, go2);
        card.appendChild(row);
      }
    } else {
      const v = doc.verdict.per_subject[0];
      const picks = doc.findings.filter((f) => selected.has(f.id));
      card.innerHTML = `<div class="jr-kicker">the verdict</div>
        <div class="jr-title">${esc(v?.state.replace(/_/g, " ") ?? "")}</div>
        ${v?.justification ? `<div class="jr-body">${esc(v.justification)}</div>` : ""}
        <div class="jr-body">${picks.length ? `your review (${picks.length}):` : "you selected nothing — ← to go back, or exit."}</div>
        ${picks.map((f) => `<div class="jr-pick">${SEV_GLYPH[f.severity] ?? ""} ${esc(f.title)}</div>`).join("")}`;
      const ex = document.createElement("button");
      ex.className = "jr-btn primary";
      ex.textContent = "E · export review draft";
      ex.addEventListener("click", doExport);
      card.appendChild(ex);
    }
    refreshHud();
    narrate(narrationFor(doc, s, selected), intensityFor(s));
    prefetch(idx + 1); // warm the next beat so navigation is gapless
  };

  const go = (i: number) => {
    clearTimeout(autoTimer);
    idx = Math.max(0, Math.min(steps.length - 1, i));
    renderStep();
  };

  const toggleSel = () => {
    const s = steps[idx];
    if (s.kind !== "finding") return;
    const on = !selected.has(s.f.id);
    if (on) selected.add(s.f.id);
    else selected.delete(s.f.id);
    handle.setSelected(s.f.id, on);
    localStorage.setItem(selKey, JSON.stringify([...selected]));
    // Light UI update only — narration text is selection-independent (cache-stable),
    // so a full renderStep would just restart the audio.
    const btn = card.querySelector<HTMLButtonElement>(".jr-sel");
    if (btn) {
      btn.classList.toggle("on", on);
      btn.textContent = on ? "✓ in your review — ␣ to remove" : "␣ add to your review";
    }
    refreshHud();
  };

  const doExport = () => {
    const picks = doc.findings.filter((f) => selected.has(f.id));
    const v = doc.verdict.per_subject[0];
    const lines = [
      `## Review — ${doc.subjects.map((s) => s.ref).join(" + ")}`,
      ``,
      `**Verdict:** ${v?.state.replace(/_/g, " ") ?? ""}${v?.justification ? ` — ${v.justification}` : ""}`,
      ``,
      ...picks.map((f) => {
        const at = f.anchor ? ` (\`${f.anchor.path}${f.anchor.line ? `:${f.anchor.line}` : ""}\`)` : "";
        const why = f.rule?.why ? `\n  - why: ${f.rule.why}` : "";
        return `- **[${f.severity.replace(/_/g, " ")}]** ${f.title}${at}${f.evidence ? `\n  - ${f.evidence}` : ""}${why}`;
      }),
    ];
    opts.onExport(lines.join("\n"), picks.length);
  };

  // ── keys ──
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement)?.tagName === "INPUT") return;
    switch (e.key) {
      case "ArrowRight":
        go(idx + 1);
        break;
      case "ArrowLeft":
        go(idx - 1);
        break;
      case " ":
        e.preventDefault();
        toggleSel();
        break;
      case "v":
      case "V":
        voiceOn = !voiceOn;
        localStorage.setItem("pear.journey.voice", voiceOn ? "1" : "0");
        if (!voiceOn) stopNarration();
        else narrate(narrationFor(doc, steps[idx], selected), intensityFor(steps[idx]));
        refreshHud();
        break;
      case "a":
      case "A":
        autoOn = !autoOn;
        refreshHud();
        if (autoOn && voiceOn) narrate(narrationFor(doc, steps[idx], selected), intensityFor(steps[idx]));
        break;
      case "b":
      case "B":
        ttsBackend = ttsBackend === "kokoro" ? "chatterbox" : "kokoro";
        localStorage.setItem("pear.journey.tts", ttsBackend);
        refreshHud();
        if (voiceOn) narrate(narrationFor(doc, steps[idx], selected), intensityFor(steps[idx]));
        // Chatterbox is ~realtime — pre-cache the whole journey in the background
        // (current step always outranks the bulk queue).
        if (ttsBackend === "chatterbox" && voiceOn) startPreload();
        else cancelPreload();
        break;
      case "d":
      case "D": {
        const s = steps[idx];
        if (s.kind === "finding") handle.showDetail(s.f);
        break;
      }
      case "e":
      case "E":
        doExport();
        break;
      case "?":
        legend.classList.toggle("hidden");
        break;
      case "Escape":
        exit();
        break;
    }
  };
  document.addEventListener("keydown", onKey);
  $(".jr-prev").addEventListener("click", () => go(idx - 1));
  $(".jr-next").addEventListener("click", () => go(idx + 1));
  $(".jr-voice").addEventListener("click", () => onKey(new KeyboardEvent("keydown", { key: "v" })));
  $(".jr-tts").addEventListener("click", () => onKey(new KeyboardEvent("keydown", { key: "b" })));
  $(".jr-auto").addEventListener("click", () => onKey(new KeyboardEvent("keydown", { key: "a" })));
  $(".jr-keys").addEventListener("click", () => legend.classList.toggle("hidden"));
  $(".jr-exit").addEventListener("click", () => exit());

  // speechSynthesis voices load async on first use.
  if (voiceOn && speechSynthesis.getVoices().length === 0)
    speechSynthesis.addEventListener("voiceschanged", () => {}, { once: true });

  const exit = () => {
    clearTimeout(autoTimer);
    stopNarration();
    document.removeEventListener("keydown", onKey);
    handle.setLowPower(false);
    handle.setJourneyMode(false);
    hud.remove();
  };

  // First-run: show the legend briefly so the keys are discoverable.
  if (!localStorage.getItem("pear.journey.seen")) {
    legend.classList.remove("hidden");
    localStorage.setItem("pear.journey.seen", "1");
    window.setTimeout(() => legend.classList.add("hidden"), 6000);
  }
  renderStep();
  // Journey starts on chatterbox → pre-cache every beat right away (progress in HUD).
  if (ttsBackend === "chatterbox" && voiceOn) startPreload();
  return { exit, handleSpeech };
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}
