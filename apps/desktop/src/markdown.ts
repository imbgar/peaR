// Safe GitHub-flavored-markdown rendering for UNTRUSTED content (PR comment bodies
// come from arbitrary GitHub users). marked → DOMPurify → innerHTML: the sanitizer
// is what makes this safe to inject, since the Tauri webview has IPC access and a
// raw `<img onerror>` / `<script>` in a comment would otherwise be stored-XSS.

import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

// Force links to open externally and never leak the opener.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer nofollow");
  }
});

/** Render markdown `src` into `el` as sanitized HTML. */
export function renderMarkdown(el: HTMLElement, src: string) {
  const html = marked.parse(src ?? "", { async: false }) as string;
  el.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
