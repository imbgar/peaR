// Unified-diff parser + renderer for the PR diff panel. Dependency-free; all output
// is built with the DOM (textContent), so PR content is never injected as HTML.

import { DiffComment } from "./protocol";

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

/** Render the parsed diff (with existing review comments) into `container`. */
export function renderDiff(container: HTMLElement, diff: string, comments: DiffComment[]) {
  container.innerHTML = "";
  const files = parseDiff(diff);
  if (!files.length) {
    const empty = document.createElement("div");
    empty.className = "diff-empty";
    empty.textContent = "No textual changes in this PR's diff.";
    container.appendChild(empty);
    return;
  }

  // Index comments by path → new-side line.
  const byPath = new Map<string, Map<number, DiffComment[]>>();
  for (const c of comments) {
    if (c.line == null) continue;
    const m = byPath.get(c.path) ?? new Map<number, DiffComment[]>();
    (m.get(c.line) ?? m.set(c.line, []).get(c.line)!).push(c);
    byPath.set(c.path, m);
  }

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
  if (comments.length) {
    const cc = document.createElement("span");
    cc.className = "diff-ccount";
    cc.textContent = `${comments.length} comment${comments.length > 1 ? "s" : ""}`;
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
        body.appendChild(row);
        if (line.newNo != null && cmtMap?.has(line.newNo)) {
          for (const c of cmtMap.get(line.newNo)!) body.appendChild(renderComment(c));
        }
      }
    }
    card.appendChild(body);
    head.addEventListener("click", () => card.classList.toggle("collapsed"));
    container.appendChild(card);
  }
}

function renderComment(c: DiffComment): HTMLElement {
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
