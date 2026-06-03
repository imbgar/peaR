---
description: Produce a clean, copy/paste-ready review write-up (no GitHub posting).
argument-hint: "[optional: target audience, e.g. 'for the PR author']"
---

Generate a polished, copy/paste-ready review of the current pull request.

- Use `gh pr view` and `gh pr diff` for context.
- Output GitHub-flavored markdown only — no preamble, no tool chatter — so the user
  can paste it straight into a PR comment or Slack. $ARGUMENTS
- Structure: a one-line verdict, then **Findings** (grouped by file), then **Nits**.
- Reference code as `path:line`. Be specific and terse.

Print the final markdown to the terminal as your last output (no trailing commentary).
In pear, click **Copy content** to capture it to the clipboard — select the markdown
block first for a tight copy, or just click to grab the whole buffer.
