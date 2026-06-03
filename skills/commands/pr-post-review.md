---
description: Post the current PR review as inline + summary comments on GitHub via gh.
argument-hint: "[optional: extra emphasis, e.g. 'focus on security']"
---

You are reviewing the pull request checked out in this working directory.

1. Determine the PR with `gh pr view --json number,title,headRefName,baseRefName`.
2. Read the diff with `gh pr diff`.
3. Produce a focused code review covering: correctness bugs, security, missing tests,
   and clear simplifications. Skip nits unless they affect correctness.
   $ARGUMENTS
4. Post it: inline comments on specific lines where possible
   (`gh pr review --comment`), plus one concise summary comment with the top findings
   and an overall verdict (approve / request changes / comment).
5. Print the URL of the posted review.

Keep the summary under ~12 bullet points — most important first.
