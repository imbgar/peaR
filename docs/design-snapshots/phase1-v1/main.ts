import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import {
  Command,
  Event as CoreEvent,
  CliKind,
  HistoryEntry,
  PrMeta,
  PrRef,
  ReviewButton,
  parsePrRef,
  shortLabel,
} from "./protocol";

// ── ghostty-flavored xterm theme ────────────────────────────────────────────
const TERM_THEME = {
  background: "#0b0c10",
  foreground: "#d7dae0",
  cursor: "#7ee787",
  cursorAccent: "#0b0c10",
  selectionBackground: "#2a3a4a",
  black: "#15171c",
  red: "#ff6b6b",
  green: "#7ee787",
  yellow: "#f0c674",
  blue: "#6cb6ff",
  magenta: "#d2a8ff",
  cyan: "#76e0d6",
  white: "#c9ccd3",
  brightBlack: "#4b5263",
  brightRed: "#ff8585",
  brightGreen: "#9af2a8",
  brightYellow: "#ffd789",
  brightBlue: "#8cc8ff",
  brightMagenta: "#e0c0ff",
  brightCyan: "#95efe6",
  brightWhite: "#ffffff",
};

const FONT_STACK =
  '"JetBrains Mono", "SF Mono", "Menlo", "Cascadia Code", ui-monospace, monospace';

// ── per-tab view state ──────────────────────────────────────────────────────
interface TabView {
  id: number;
  title: string;
  subtitle: string;
  cli: CliKind;
  pr: PrRef | null;
  meta: PrMeta | null;
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

const tabs = new Map<number, TabView>();
let active: number | null = null;

// ── element handles ─────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
let tabbarEl: HTMLElement;
let terminalsEl: HTMLElement;
let historyEl: HTMLElement;
let statusEl: HTMLElement;
let prInput: HTMLInputElement;
let cliSelect: HTMLSelectElement;
let toolbarEl: HTMLElement;
let copyModalEl: HTMLElement;
let copyTextEl: HTMLTextAreaElement;
let copyStatusEl: HTMLElement;

// ── core IPC ────────────────────────────────────────────────────────────────
async function send(cmd: Command) {
  try {
    await invoke("pear_command", { command: cmd });
  } catch (e) {
    setStatus(`⚠ ${e}`, true);
  }
}

function selectedCli(): CliKind {
  return cliSelect.value as CliKind;
}

// ── rendering ───────────────────────────────────────────────────────────────
function setStatus(msg: string, warn = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("warn", warn);
}

function renderTabBar() {
  tabbarEl.innerHTML = "";
  for (const t of tabs.values()) {
    const pill = document.createElement("div");
    pill.className = "tab" + (t.id === active ? " active" : "");
    pill.title = t.subtitle || t.title;

    const dot = document.createElement("span");
    dot.className = `dot cli-${t.cli}`;
    pill.appendChild(dot);

    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = t.title;
    pill.appendChild(label);

    const close = document.createElement("button");
    close.className = "tab-close";
    close.textContent = "×";
    close.onclick = (e) => {
      e.stopPropagation();
      send({ type: "close_tab", tab: t.id });
    };
    pill.appendChild(close);

    pill.onclick = () => setActive(t.id);
    tabbarEl.appendChild(pill);
  }
  if (tabs.size === 0) {
    const empty = document.createElement("div");
    empty.className = "tab-empty";
    empty.textContent = "no open tabs — open a PR or a shell from the left";
    tabbarEl.appendChild(empty);
  }
}

function renderToolbar() {
  const enabled = active !== null;
  toolbarEl
    .querySelectorAll<HTMLButtonElement>("button[data-needs-tab]")
    .forEach((b) => (b.disabled = !enabled));
}

function renderHistory(entries: HistoryEntry[]) {
  historyEl.innerHTML = "";
  if (entries.length === 0) {
    const li = document.createElement("li");
    li.className = "history-empty";
    li.textContent = "no reviews yet";
    historyEl.appendChild(li);
    return;
  }
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = "history-item";
    li.title = `${e.pr.owner}/${shortLabel(e.pr)} — ${e.title}`;

    const ref = document.createElement("span");
    ref.className = "history-ref";
    ref.textContent = shortLabel(e.pr);
    li.appendChild(ref);

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = e.title;
    li.appendChild(title);

    li.onclick = () =>
      send({ type: "open_pr", pr: e.pr, cli: selectedCli(), cwd: null });
    historyEl.appendChild(li);
  }
}

// ── terminal lifecycle ──────────────────────────────────────────────────────
function createTabView(id: number, title: string, cli: CliKind, pr: PrRef | null): TabView {
  const el = document.createElement("div");
  el.className = "terminal-host hidden";
  terminalsEl.appendChild(el);

  const term = new Terminal({
    theme: TERM_THEME,
    fontFamily: FONT_STACK,
    fontSize: 13,
    lineHeight: 1.2,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 10000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(el);
  queueMicrotask(() => fit.fit());

  term.onData((data) =>
    send({ type: "input", tab: id, bytes: Array.from(new TextEncoder().encode(data)) }),
  );
  term.onResize(({ cols, rows }) => send({ type: "resize", tab: id, cols, rows }));

  const view: TabView = {
    id,
    title,
    subtitle: title,
    cli,
    pr,
    meta: null,
    term,
    fit,
    el,
  };
  tabs.set(id, view);
  return view;
}

function setActive(id: number) {
  active = id;
  for (const t of tabs.values()) {
    t.el.classList.toggle("hidden", t.id !== id);
  }
  const v = tabs.get(id);
  if (v) {
    requestAnimationFrame(() => {
      v.fit.fit();
      v.term.focus();
    });
  }
  renderTabBar();
  renderToolbar();
}

function closeTabView(id: number) {
  const v = tabs.get(id);
  if (v) {
    v.term.dispose();
    v.el.remove();
    tabs.delete(id);
  }
  if (active === id) {
    active = null;
    const next = tabs.keys().next();
    if (!next.done) setActive(next.value);
  }
  renderTabBar();
  renderToolbar();
}

/** Selection if any, else the full scrollback — used as the saved review artifact. */
function terminalText(term: Terminal): string {
  if (term.hasSelection()) return term.getSelection();
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join("\n").replace(/\s+$/g, "") + "\n";
}

// ── event handling ──────────────────────────────────────────────────────────
function handle(ev: CoreEvent) {
  switch (ev.type) {
    case "tab_opened": {
      createTabView(ev.tab, ev.title, ev.cli, ev.pr);
      setActive(ev.tab);
      setStatus(`opened ${ev.title}`);
      break;
    }
    case "pr_meta": {
      const v = tabs.get(ev.tab);
      if (v) {
        v.meta = ev.meta;
        const m = ev.meta;
        v.subtitle = `${m.title} — @${m.author} · ${m.state}${m.draft ? " (draft)" : ""} · +${m.additions}/-${m.deletions} · ${m.changed_files} files`;
        renderTabBar();
        setStatus(v.subtitle);
      }
      break;
    }
    case "output": {
      tabs.get(ev.tab)?.term.write(new Uint8Array(ev.bytes));
      break;
    }
    case "tab_closed": {
      closeTabView(ev.tab);
      setStatus(`tab ${ev.tab} closed${ev.code != null ? ` (exit ${ev.code})` : ""}`);
      break;
    }
    case "review_saved": {
      setStatus(`saved review → ${ev.path}`);
      break;
    }
    case "history": {
      renderHistory(ev.entries);
      break;
    }
    case "notice": {
      setStatus(ev.message);
      break;
    }
    case "error": {
      setStatus(`⚠ ${ev.message}`, true);
      break;
    }
  }
}

// ── wiring ──────────────────────────────────────────────────────────────────
function pressButton(button: ReviewButton) {
  if (active === null) return;
  send({ type: "button", tab: active, button });
}

function saveReview() {
  if (active === null) return;
  const v = tabs.get(active);
  if (!v) return;
  send({ type: "save_review", tab: active, content: terminalText(v.term) });
}

// ── copy-content modal ──────────────────────────────────────────────────────
function setCopyStatus(msg: string, warn = false) {
  copyStatusEl.textContent = msg;
  copyStatusEl.classList.toggle("warn", warn);
}

async function copyToClipboard(text: string) {
  try {
    await writeText(text);
    setCopyStatus("copied to clipboard ✓");
  } catch (e) {
    setCopyStatus(`clipboard failed: ${e}`, true);
  }
}

/** Grab the active terminal's text (selection or full buffer), pop the modal, and
 *  push straight to the system clipboard via the Tauri clipboard plugin. */
async function copyContent() {
  if (active === null) return;
  const v = tabs.get(active);
  if (!v) return;
  const hadSelection = v.term.hasSelection();
  const content = terminalText(v.term);
  copyTextEl.value = content;
  copyModalEl.classList.remove("hidden");
  copyTextEl.focus();
  copyTextEl.setSelectionRange(0, copyTextEl.value.length);
  await copyToClipboard(content);
  if (!hadSelection) {
    setCopyStatus("copied whole buffer ✓ — tip: select text first for a tighter copy");
  }
}

function closeCopyModal() {
  copyModalEl.classList.add("hidden");
  if (active !== null) tabs.get(active)?.term.focus();
}

window.addEventListener("DOMContentLoaded", async () => {
  tabbarEl = $("#tabbar");
  terminalsEl = $("#terminals");
  historyEl = $("#history");
  statusEl = $("#status");
  prInput = $("#pr-input");
  cliSelect = $("#cli-select");
  toolbarEl = $("#toolbar");
  copyModalEl = $("#copy-modal");
  copyTextEl = $("#copy-modal-text");
  copyStatusEl = $("#copy-modal-status");

  $("#open-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const pr = parsePrRef(prInput.value);
    if (!pr) {
      setStatus("⚠ expected owner/repo#NUMBER", true);
      return;
    }
    send({ type: "open_pr", pr, cli: selectedCli(), cwd: null });
    prInput.value = "";
  });

  $("#new-shell").addEventListener("click", () =>
    send({ type: "open_scratch", cli: selectedCli(), cwd: null }),
  );

  toolbarEl.querySelector('[data-btn="post_review"]')!.addEventListener("click", () => pressButton("post_review"));
  toolbarEl.querySelector('[data-btn="copy_content"]')!.addEventListener("click", () => copyContent());
  toolbarEl.querySelector('[data-btn="reduce_to_key_points"]')!.addEventListener("click", () => pressButton("reduce_to_key_points"));
  toolbarEl.querySelector('[data-btn="save_review"]')!.addEventListener("click", saveReview);

  // Copy modal controls.
  $("#copy-modal-close").addEventListener("click", closeCopyModal);
  $("#copy-modal-done").addEventListener("click", closeCopyModal);
  $("#copy-modal-recopy").addEventListener("click", () => copyToClipboard(copyTextEl.value));
  copyModalEl.addEventListener("click", (e) => {
    if (e.target === copyModalEl) closeCopyModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !copyModalEl.classList.contains("hidden")) closeCopyModal();
  });

  const refit = () => {
    if (active !== null) tabs.get(active)?.fit.fit();
  };
  window.addEventListener("resize", refit);
  new ResizeObserver(refit).observe(terminalsEl);

  await listen<CoreEvent>("pear:event", (e) => handle(e.payload));

  renderTabBar();
  renderToolbar();
  send({ type: "load_history" });
  setStatus("ready");
});
