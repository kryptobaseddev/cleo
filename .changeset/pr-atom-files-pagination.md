---
id: pr-atom-files-pagination
tasks: [T12358]
kind: fix
summary: "`pr:<number>` evidence now reads the complete changed-file list of PRs with more than 100 files"
---

`gh pr view --json files` returns at most 100 files, so every `pr:` atom for a
larger PR was refused as incomplete — PR #1541 (152 files) failed with
`changed-file coverage is incomplete or empty (100/152)` on every
`cleo verify --gate implemented`.

The resolver now paginates `gh api repos/{owner}/{repo}/pulls/<n>/files`
(100 per page, up to GitHub's 3000-file ceiling) whenever `gh pr view` returns
fewer files than the PR's `changedFiles` count. The incompleteness refusal still
fires when pagination genuinely fails — a page error or a short total — and now
names the failure. An incomplete inventory is never cached, and a cache entry
holding a truncated list from before this fix is ignored and refetched.
