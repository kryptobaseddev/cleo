---
id: managed-block-hash-check
tasks: [T14304]
kind: fix
summary: "cleo doctor global-delivery hashes every managed instruction block against the current template, and --repair refreshes only stale blocks"
---

A global provider file such as `~/.claude/CLAUDE.md` could carry an inlined
copy of an older CLEO-INJECTION (2.24.8 while the template is 2.25.5), and
`cleo doctor global-delivery` did not look at instruction files at all.

- The CAAMP staleness scan now also hashes each managed block's body against
  the body a sync would write now (`blockSha256` / `expectedSha256`); a block
  that differs is `stale` even when its source stamps still match.
- `cleo doctor global-delivery` reports that scan (`instructions`) and is
  unhealthy while any block is stale.
- `--repair` rewrites only the stale CAAMP blocks, through the same explicit
  user command that relinks `~/.cleo`. Every byte outside the block,
  legacy `CLEO:START` blocks included, is kept; the result is in the receipt.
