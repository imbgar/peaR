// Unified-diff parser + renderer for the PR diff panel. Diff code is built with the
// DOM (textContent), so diff content is never injected as HTML. Comment *bodies* are
// markdown, rendered through the sanitizing `renderMarkdown` helper (see markdown.ts).

import { Comment, DiffComment, ReviewThread } from "./protocol";
import { renderMarkdown } from "./markdown";

type LineKind = "add" | "del" | "ctx";
interface DLine {
  kind: LineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}
interface DHunk {
  header: string;
  lines: DLine[];
}
interface DFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  adds: number;
  dels: number;
  hunks: DHunk[];
}

/** Parse a git/GitHub unified diff into files → hunks → lines. */
export function parseDiff(diff: string): DFile[] {
  const files: DFile[] = [];
  let f: DFile | null = null;
  let h: DHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  const flush = () => {
    if (f) files.push(f);
  };

  for (const ln of diff.split("\n")) {
    if (ln.startsWith("diff --git")) {
      flush();
      const m = ln.match(/^diff --git a\/(.+) b\/(.+)$/);
      f = {
        path: m ? m[2] : ln.slice(11).trim(),
        oldPath: m ? m[1] : null,
        status: "modified",
        binary: false,
        adds: 0,
        dels: 0,
        hunks: [],
      };
      h = null;
      continue;
    }
    if (!f) continue;
    if (ln.startsWith("new file")) {
      f.status = "added";
      continue;
    }
    if (ln.startsWith("deleted file")) {
      f.status = "deleted";
      continue;
    }
    if (ln.startsWith("rename from ")) {
      f.oldPath = ln.slice(12);
      f.status = "renamed";
      continue;
    }
    if (ln.startsWith("rename to ")) {
      f.path = ln.slice(10);
      f.status = "renamed";
      continue;
    }
    if (ln.startsWith("Binary files")) {
      f.binary = true;
      continue;
    }
    if (
      ln.startsWith("--- ") ||
      ln.startsWith("+++ ") ||
      ln.startsWith("index ") ||
      ln.startsWith("similarity ") ||
      ln.startsWith("old mode") ||
      ln.startsWith("new mode") ||
      ln.startsWith("copy ") ||
      ln.startsWith("dissimilarity ")
    ) {
      continue;
    }
    if (ln.startsWith("@@")) {
      const m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      oldNo = m ? parseInt(m[1], 10) : 0;
      newNo = m ? parseInt(m[2], 10) : 0;
      h = { header: m ? m[3].trim() : ln.replace(/^@+/, "").trim(), lines: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    const c = ln[0];
    if (c === "+") {
      h.lines.push({ kind: "add", text: ln.slice(1), oldNo: null, newNo });
      newNo++;
      f.adds++;
    } else if (c === "-") {
      h.lines.push({ kind: "del", text: ln.slice(1), oldNo, newNo: null });
      oldNo++;
      f.dels++;
    } else if (c === " ") {
      h.lines.push({ kind: "ctx", text: ln.slice(1), oldNo, newNo });
      oldNo++;
      newNo++;
    }
    // "\ No newline at end of file" and stray lines are ignored.
  }
  flush();
  return files;
}

const STATUS_LETTER: Record<string, string> = {
  added: "A",
  deleted: "D",
  renamed: "R",
  modified: "M",
};

/**
 * Render the parsed diff into `container`. When `threads` is provided (full review
 * threads with resolved state + reactions) it drives the inline UI — each anchored
 * line gets a collapsible 💬 bubble that toggles a GitHub-style thread. Otherwise we
 * fall back to the flat `comments` list (rendered open) until threads arrive.
 */
export function renderDiff(
  container: HTMLElement,
  diff: string,
  comments: DiffComment[],
  threads: ReviewThread[] = [],
) {
  container.innerHTML = "";
  const files = parseDiff(diff);
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "diff-empty";
    empty.textContent = "No textual changes in this PR's diff.";
    container.appendChild(empty);
    return;
  }

  const useThreads = threads.length > 0;
  // Index inline threads by path → anchored line (current line, else original).
  const threadByPath = new Map<string, Map<number, ReviewThread[]>>();
  for (const t of threads) {
    const line = t.line ?? t.original_line;
    if (line == null) continue;
    const m = threadByPath.get(t.path) ?? new Map<number, ReviewThread[]>();
    (m.get(line) ?? m.set(line, []).get(line)!).push(t);
    threadByPath.set(t.path, m);
  }
  // Fallback: index flat comments by path → new-side line.
  const byPath = new Map<string, Map<number, DiffComment[]>>();
  for (const c of comments) {
    if (c.line == null) continue;
    const m = byPath.get(c.path) ?? new Map<number, DiffComment[]>();
    (m.get(c.line) ?? m.set(c.line, []).get(c.line)!).push(c);
    byPath.set(c.path, m);
  }

  const cmtCount = useThreads
    ? threads.reduce((s, t) => s + t.comments.length, 0)
    : comments.length;
  const totAdd = files.reduce((s, f) => s + f.adds, 0);
  const totDel = files.reduce((s, f) => s + f.dels, 0);
  const summary = document.createElement("div");
  summary.className = "diff-summary";
  const fc = document.createElement("span");
  fc.className = "diff-fcount";
  fc.textContent = `${files.length} file${files.length > 1 ? "s" : ""} changed`;
  const a = document.createElement("span");
  a.className = "diff-adds";
  a.textContent = `+${totAdd}`;
  const d = document.createElement("span");
  d.className = "diff-dels";
  d.textContent = `−${totDel}`;
  if (cmtCount) {
    const cc = document.createElement("span");
    cc.className = "diff-ccount";
    cc.textContent = `${cmtCount} comment${cmtCount > 1 ? "s" : ""}`;
    summary.append(fc, a, d, cc);
  } else {
    summary.append(fc, a, d);
  }
  container.appendChild(summary);

  for (const f of files) {
    const card = document.createElement("div");
    card.className = "diff-file";

    const head = document.createElement("button");
    head.type = "button";
    head.className = "diff-file-head";
    const chev = document.createElement("span");
    chev.className = "diff-chev";
    chev.textContent = "▾";
    const badge = document.createElement("span");
    badge.className = `diff-status s-${f.status}`;
    badge.textContent = STATUS_LETTER[f.status] ?? "M";
    badge.title = f.status;
    const path = document.createElement("span");
    path.className = "diff-path";
    path.textContent =
      f.status === "renamed" && f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    const adds = document.createElement("span");
    adds.className = "diff-adds";
    adds.textContent = `+${f.adds}`;
    const dels = document.createElement("span");
    dels.className = "diff-dels";
    dels.textContent = `−${f.dels}`;
    head.append(chev, badge, path, adds, dels);
    card.appendChild(head);

    const body = document.createElement("div");
    body.className = "diff-body";
    if (f.binary) {
      const b = document.createElement("div");
      b.className = "diff-binary";
      b.textContent = "Binary file — not shown";
      body.appendChild(b);
    }
    const threadMap = threadByPath.get(f.path);
    const cmtMap = byPath.get(f.path);
    for (const hunk of f.hunks) {
      const hh = document.createElement("div");
      hh.className = "diff-hunk";
      hh.textContent = hunk.header ? `┄ ${hunk.header}` : "┄";
      body.appendChild(hh);
      for (const line of hunk.lines) {
        const row = document.createElement("div");
        row.className = `diff-row r-${line.kind}`;
        const go = document.createElement("span");
        go.className = "diff-gutter";
        go.textContent = line.oldNo?.toString() ?? "";
        const gn = document.createElement("span");
        gn.className = "diff-gutter";
        gn.textContent = line.newNo?.toString() ?? "";
        const sign = document.createElement("span");
        sign.className = "diff-sign";
        sign.textContent = line.kind === "add" ? "+" : line.kind === "del" ? "−" : "";
        const code = document.createElement("span");
        code.className = "diff-code";
        code.textContent = line.text.length ? line.text : " ";
        row.append(go, gn, sign, code);
        // Inline threads (collapsible, GitHub-style): render a 💬 bubble on the line
        // that toggles the thread, collapsed by default.
        const lineThreads = line.newNo != null ? threadMap?.get(line.newNo) : undefined;
        if (lineThreads) {
          row.classList.add("has-cmt");
          const blocks: HTMLElement[] = [];
          for (const t of lineThreads) {
            const block = renderThread(t);
            const n = t.comments.length;
            const bubble = document.createElement("button");
            bubble.type = "button";
            bubble.className = "diff-bubble" + (t.is_resolved ? " resolved" : "");
            const setLabel = () =>
              (bubble.textContent = `💬 ${n}${block.classList.contains("hidden") ? " ▸" : " ▾"}`);
            bubble.addEventListener("click", () => {
              block.classList.toggle("hidden");
              setLabel();
            });
            setLabel();
            code.appendChild(bubble);
            blocks.push(block);
          }
          body.appendChild(row);
          for (const b of blocks) body.appendChild(b);
          continue;
        }
        body.appendChild(row);
        // Fallback (pre-threads): render flat comments open under the line.
        if (line.newNo != null && cmtMap?.has(line.newNo)) {
          for (const c of cmtMap.get(line.newNo)!) body.appendChild(renderFlatComment(c));
        }
      }
    }
    card.appendChild(body);
    head.addEventListener("click", () => card.classList.toggle("collapsed"));
    container.appendChild(card);
  }
}

/** A short relative time ("2h", "3d", "5mo") from an RFC3339 timestamp. */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d`;
  const mo = d / 30;
  if (mo < 12) return `${Math.floor(mo)}mo`;
  return `${Math.floor(mo / 12)}y`;
}

/**
 * Render one comment — author, relative time, body, and reaction rollups. Shared
 * by the inline diff threads and the conversation panel (same `Comment` shape).
 * The body is GitHub markdown, rendered via the sanitizing `renderMarkdown`.
 */
export function commentEl(c: Comment): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "cv-cmt";
  const top = document.createElement("div");
  top.className = "cv-top";
  const who = document.createElement("span");
  who.className = "cv-who" + (c.mine ? " me" : "");
  who.textContent = c.author;
  const when = document.createElement("span");
  when.className = "cv-when";
  when.textContent = relTime(c.created_at);
  top.append(who, when);
  const body = document.createElement("div");
  body.className = "cv-body markdown";
  renderMarkdown(body, c.body);
  wrap.append(top, body);
  wrap.appendChild(reactionRow(c));
  return wrap;
}

// The eight reactions GitHub supports, in its display order (emoji ↔ enum).
const REACTIONS: ReadonlyArray<{ emoji: string; content: string }> = [
  { emoji: "👍", content: "THUMBS_UP" },
  { emoji: "👎", content: "THUMBS_DOWN" },
  { emoji: "😄", content: "LAUGH" },
  { emoji: "🎉", content: "HOORAY" },
  { emoji: "😕", content: "CONFUSED" },
  { emoji: "❤️", content: "HEART" },
  { emoji: "🚀", content: "ROCKET" },
  { emoji: "👀", content: "EYES" },
];

// Set once by the app (main.ts) — toggles a reaction on a comment node id.
type ReactFn = (subjectId: string, content: string, add: boolean) => void;
let onReact: ReactFn | null = null;
export function setReactionHandler(fn: ReactFn) {
  onReact = fn;
}

// Close any open reaction picker when clicking elsewhere (the toggles below
// stopPropagation, so opening one doesn't immediately close it).
document.addEventListener("click", () => {
  document.querySelectorAll(".cv-picker:not(.hidden)").forEach((p) => p.classList.add("hidden"));
});

function reactionRow(c: Comment): HTMLElement {
  const row = document.createElement("div");
  row.className = "cv-react";
  for (const r of c.reactions) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cv-pill" + (r.me ? " me" : "");
    pill.textContent = `${r.emoji} ${r.count}`;
    pill.title = r.me ? "Remove your reaction" : "React";
    pill.addEventListener("click", () => onReact?.(c.id, r.content, !r.me));
    row.appendChild(pill);
  }
  // "+" opens a small picker of the eight reactions; clicking one toggles it.
  const add = document.createElement("button");
  add.type = "button";
  add.className = "cv-addreact";
  add.textContent = "＋";
  add.title = "Add reaction";
  const picker = document.createElement("div");
  picker.className = "cv-picker hidden";
  for (const opt of REACTIONS) {
    const mine = c.reactions.find((x) => x.content === opt.content)?.me ?? false;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cv-pick" + (mine ? " me" : "");
    b.textContent = opt.emoji;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      picker.classList.add("hidden");
      onReact?.(c.id, opt.content, !mine);
    });
    picker.appendChild(b);
  }
  add.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasHidden = picker.classList.contains("hidden");
    document.querySelectorAll(".cv-picker:not(.hidden)").forEach((p) => p.classList.add("hidden"));
    picker.classList.toggle("hidden", !wasHidden);
  });
  const wrap = document.createElement("span");
  wrap.className = "cv-react-add";
  wrap.append(add, picker);
  row.appendChild(wrap);
  return row;
}

/** An inline review thread block (collapsed by default via the `hidden` class). */
function renderThread(t: ReviewThread): HTMLElement {
  const block = document.createElement("div");
  block.className = "diff-thread hidden" + (t.is_resolved ? " resolved" : "");
  if (t.is_resolved || t.is_outdated) {
    const tag = document.createElement("div");
    tag.className = "dt-state";
    tag.textContent = [t.is_resolved ? "✓ resolved" : "", t.is_outdated ? "outdated" : ""]
      .filter(Boolean)
      .join(" · ");
    block.appendChild(tag);
  }
  for (const c of t.comments) block.appendChild(commentEl(c));
  return block;
}

/** Fallback inline render of a flat REST review comment (before threads arrive). */
function renderFlatComment(c: DiffComment): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "diff-comment";
  const who = document.createElement("div");
  who.className = "dc-author";
  who.textContent = `@${c.author}`;
  const body = document.createElement("div");
  body.className = "dc-body";
  body.textContent = c.body;
  wrap.append(who, body);
  return wrap;
}
