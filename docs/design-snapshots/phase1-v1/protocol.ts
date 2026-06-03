// TypeScript mirror of `pear-core`'s protocol (crates/pear-core/src/protocol.rs).
// serde uses `#[serde(tag = "type", rename_all = "snake_case")]`, so the wire shape
// is `{ type: "open_pr", ... }`. Keep these two files in lockstep.

export type CliKind = "claude" | "codex" | "aider" | "shell";

export type ReviewButton = "post_review" | "copy_content" | "reduce_to_key_points";

export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export interface PrMeta {
  pr: PrRef;
  title: string;
  author: string;
  state: string;
  draft: boolean;
  url: string;
  additions: number;
  deletions: number;
  changed_files: number;
}

export interface HistoryEntry {
  pr: PrRef;
  title: string;
  last_opened: string;
}

export type Command =
  | { type: "open_pr"; pr: PrRef; cli: CliKind; cwd: string | null }
  | { type: "open_scratch"; cli: CliKind; cwd: string | null }
  | { type: "close_tab"; tab: number }
  | { type: "input"; tab: number; bytes: number[] }
  | { type: "resize"; tab: number; cols: number; rows: number }
  | { type: "button"; tab: number; button: ReviewButton }
  | { type: "save_review"; tab: number; content: string }
  | { type: "load_history" };

export type Event =
  | { type: "tab_opened"; tab: number; title: string; pr: PrRef | null; cli: CliKind }
  | { type: "pr_meta"; tab: number; meta: PrMeta }
  | { type: "output"; tab: number; bytes: number[] }
  | { type: "tab_closed"; tab: number; code: number | null }
  | { type: "review_saved"; tab: number; path: string }
  | { type: "history"; entries: HistoryEntry[] }
  | { type: "notice"; tab: number | null; message: string }
  | { type: "error"; tab: number | null; message: string };

/** Parse `owner/repo#123` (or `owner/repo/123`). */
export function parsePrRef(input: string): PrRef | null {
  const s = input.trim();
  const m = s.match(/^([^/\s]+)\/([^#/\s]+)[#/](\d+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

export function shortLabel(pr: PrRef): string {
  return `${pr.repo}#${pr.number}`;
}
