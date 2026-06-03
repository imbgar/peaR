// TypeScript mirror of `pear-core`'s protocol (crates/pear-core/src/protocol.rs).
// serde uses `#[serde(tag = "type", rename_all = "snake_case")]`, so the wire shape
// is `{ type: "open_pr", ... }`. Keep these two files in lockstep.

export type CliKind = "claude" | "codex" | "aider" | "shell";

export type ReviewButton =
  | "post_review"
  | "distill"
  | "walk_through"
  | "explain"
  | "video"
  | "ultra"
  | "copy_content";

export type ReviewTier = "light" | "standard" | "complex";

export interface PanelPayload {
  kind: string; // "markdown" | "diff" | "note"
  title: string;
  body: string;
}

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

export interface SessionRec {
  id: string;
  started: string;
  last_opened: string;
}

export interface PrRecord {
  pr: PrRef;
  title: string;
  last_opened: string;
  cli: CliKind;
  sessions: SessionRec[];
}

export type Command =
  | {
      type: "open_pr";
      pr: PrRef;
      cli: CliKind;
      cwd: string | null;
      fresh?: boolean;
      session_id?: string | null;
    }
  | { type: "open_scratch"; cli: CliKind; cwd: string | null }
  | { type: "close_tab"; tab: number }
  | { type: "input"; tab: number; bytes: number[] }
  | { type: "resize"; tab: number; cols: number; rows: number }
  | { type: "button"; tab: number; button: ReviewButton }
  | { type: "start_review"; tab: number; tier: ReviewTier }
  | { type: "save_review"; tab: number; content: string }
  | { type: "load_panel"; tab: number }
  | { type: "set_claude_permission"; mode: string }
  | { type: "load_history" }
  | { type: "clear_history" }
  | { type: "restore_history" };

export type Event =
  | { type: "tab_opened"; tab: number; title: string; pr: PrRef | null; cli: CliKind }
  | { type: "pr_meta"; tab: number; meta: PrMeta }
  | { type: "output"; tab: number; bytes: number[] }
  | { type: "tab_closed"; tab: number; code: number | null }
  | { type: "review_saved"; tab: number; path: string }
  | { type: "panel"; tab: number; payload: PanelPayload }
  | { type: "history"; entries: PrRecord[] }
  | { type: "notice"; tab: number | null; message: string }
  | { type: "error"; tab: number | null; message: string };

/** Parse `owner/repo#123`, `owner/repo/123`, or a full GitHub PR URL
 *  (`https://github.com/owner/repo/pull/123[/files...]`). */
export function parsePrRef(input: string): PrRef | null {
  const s = input.trim();
  const url = s.match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i);
  if (url) return { owner: url[1], repo: url[2], number: parseInt(url[3], 10) };
  const m = s.match(/^([^/\s]+)\/([^#/\s]+)[#/](\d+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

export function shortLabel(pr: PrRef): string {
  return `${pr.repo}#${pr.number}`;
}
