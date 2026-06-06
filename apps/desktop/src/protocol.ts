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
  | "copy_content"
  | "save_review";

export type ReviewTier = "light" | "standard" | "complex";

export interface PanelPayload {
  kind: string; // "markdown" | "diff" | "note"
  title: string;
  body: string;
}

export interface DiffComment {
  path: string;
  line: number | null;
  author: string;
  body: string;
}

export interface Reaction {
  content: string; // GraphQL ReactionContent enum, e.g. "THUMBS_UP"
  emoji: string;
  count: number;
  me: boolean;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  created_at: string;
  mine: boolean;
  reactions: Reaction[];
  // For a PR review summary in the conversation: its state, else null.
  review_state: string | null;
}

export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  original_line: number | null;
  is_resolved: boolean;
  is_outdated: boolean;
  comments: Comment[];
}

export interface PrComments {
  conversation: Comment[];
  threads: ReviewThread[];
  pr_node_id: string;
  head_sha: string;
  pending_review_id: string | null;
  pending_count: number;
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
  | { type: "open_scratch"; cli: CliKind; cwd: string | null; session_id?: string | null }
  | { type: "close_tab"; tab: number }
  | { type: "input"; tab: number; bytes: number[] }
  | { type: "resize"; tab: number; cols: number; rows: number }
  | { type: "button"; tab: number; button: ReviewButton; agent?: CliKind }
  | { type: "start_review"; tab: number; tier: ReviewTier; agent?: CliKind }
  | { type: "save_review"; tab: number; content: string }
  | { type: "load_panel"; tab: number }
  | { type: "set_claude_permission"; mode: string }
  | { type: "load_history" }
  | { type: "clear_history" }
  | { type: "delete_history"; pr: PrRef }
  | { type: "restore_history" }
  | { type: "check_skills" }
  | { type: "install_skills" }
  | { type: "load_diff"; tab: number }
  | { type: "load_comments"; tab: number }
  | { type: "toggle_reaction"; tab: number; subject_id: string; content: string; add: boolean }
  | {
      type: "create_review_comment";
      tab: number;
      mode: "single" | "review";
      body: string;
      commit_id: string;
      pr_node_id: string;
      review_id?: string | null;
      path: string;
      line: number;
      side: string;
      start_line?: number | null;
      start_side?: string | null;
    }
  | { type: "submit_review"; tab: number; review_id: string; event: string; body: string }
  | { type: "reply_review_thread"; tab: number; thread_id: string; body: string }
  | { type: "resolve_thread"; tab: number; thread_id: string; resolved: boolean }
  | { type: "ask_insight"; tab: number; id: string; prompt: string }
  | { type: "load_repo_tree"; tab: number }
  | { type: "watch_brain"; tab: number }
  | { type: "stop_brain"; tab: number }
  | { type: "save_layout"; active?: number | null }
  | { type: "load_layout"; restore: boolean }
  | { type: "clear_layout" };

export type Event =
  | { type: "tab_opened"; tab: number; title: string; pr: PrRef | null; cli: CliKind }
  | { type: "pr_meta"; tab: number; meta: PrMeta }
  | { type: "output"; tab: number; bytes: number[] }
  | { type: "tab_closed"; tab: number; code: number | null }
  | { type: "review_saved"; tab: number; path: string }
  | { type: "panel"; tab: number; payload: PanelPayload }
  | { type: "diff"; tab: number; diff: string; comments: DiffComment[] }
  | { type: "comments"; tab: number; comments: PrComments }
  | { type: "repo_tree"; tab: number; files: string[] }
  | { type: "thought"; tab: number; kind: string; text: string; detail: string }
  | { type: "insight"; tab: number; id: string; kind: string; text: string }
  | { type: "history"; entries: PrRecord[] }
  | { type: "skills_status"; installed: boolean }
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
