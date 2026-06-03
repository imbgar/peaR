---
name: pr-post-review
description: Review the current pull request for correctness, security, tests, and clear simplifications, then post inline + summary comments to GitHub. Use when you want the review published as a GitHub review, not just a local note.
argument-hint: "[optional emphasis, e.g. 'focus on security']"
allowed-tools: [Bash, Read, Grep, Glob]
metadata:
  category: code-review
  requires:
    cli: [gh, git]
---

# Post review

You are reviewing the pull request checked out in this working directory.

1. Identify the PR: `gh pr view --json number,title,headRefName,baseRefName`.
2. Read the diff: `gh pr diff`.
3. Produce a focused review — correctness bugs, security, missing tests, and clear
   simplifications. Skip nits unless they affect correctness. $ARGUMENTS
4. Post it: inline comments on specific lines where possible (`gh pr review --comment`),
   plus one concise summary comment with the top findings and an overall verdict
   (approve / request changes / comment).
5. Print the URL of the posted review.

Keep the summary under ~12 bullet points, most important first.
