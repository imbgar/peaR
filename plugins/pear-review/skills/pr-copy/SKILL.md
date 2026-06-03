---
name: pr-copy
description: Produce a clean, copy/paste-ready review write-up of the current PR — no GitHub posting. Use when you want polished markdown to paste into a comment, Slack, or a doc.
argument-hint: "[optional audience, e.g. 'for the PR author']"
allowed-tools: [Bash, Read, Grep, Glob]
metadata:
  category: code-review
  requires:
    cli: [gh, git]
---

# Copy-ready review

Generate a polished, copy/paste-ready review of the current pull request.

- Use `gh pr view` and `gh pr diff` for context.
- Output GitHub-flavored markdown only — no preamble, no tool chatter. $ARGUMENTS
- Structure: a one-line verdict, then **Findings** (grouped by file), then **Nits**.
- Reference code as `path:line`. Be specific and terse.

Print the final markdown to the terminal as your last output (no trailing commentary).
In peaR, click **Copy content** to capture it to the clipboard — select the markdown block
first for a tight copy, or just click to grab the whole buffer.
