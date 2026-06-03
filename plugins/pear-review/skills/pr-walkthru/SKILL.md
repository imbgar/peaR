---
name: pr-walkthru
description: Interactively walk the user through the PR review, one finding at a time, pausing between each. Use for a guided, conversational tour of the review rather than a dump.
argument-hint: "['start' | 'next' | a finding number]"
allowed-tools: [Bash, Read, Grep, Glob]
metadata:
  category: code-review
  requires:
    cli: [gh, git]
---

# Walk-through

Walk me through the review of this PR **conversationally**, one finding at a time — like a
senior engineer pairing with me.

For each finding, in order of importance:
1. State the finding with its `path:line` and severity.
2. Explain *why it matters* in 1–2 sentences (the risk or the win).
3. Show the smallest relevant code snippet.
4. Suggest the concrete fix.
5. Then pause and wait for me to say "next" (or ask a question) before continuing.

If $ARGUMENTS names a finding number, jump to it. Start with a one-line map of how many
findings there are and how they're grouped, then begin with #1.

Keep each step tight — this is a guided tour, not a dump.
