---
id: evidence-link-followups
tasks: [T14005]
kind: fix
summary: Evidence file nodes are keyed by the checkout that holds the file; clearer graph-link and lessons warnings
---

A `files:` evidence path is now keyed relative to the git checkout that holds
the file. A file verified from a worktree but found in the main checkout, and
files-only evidence in a store that parents several repositories, get the same
`file:` node as commit-anchored evidence instead of being skipped or prefixed
with the child directory. When a commit link fails, `W_EVIDENCE_GRAPH_LINK_FAILED`
says which links were still written. When both brain stores fail, the briefing
shows one lessons warning naming each store.
