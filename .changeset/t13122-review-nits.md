---
id: t13122-review-nits
tasks: [T13122]
kind: fix
summary: The heavy-tool bounds also catch MAKEFLAGS flag clusters, a dash-spelled workspace variable and a coloured npm warning
---

Follow-up to the evidence heap/worker plan (#1808), from its review:

- An inherited `MAKEFLAGS` job count written as a short-flag cluster (`-sj18`, `-kj`) or as make's dash-less
  first word (`j18`) is now bounded like `-j18`, keeping the cluster's other flags.
- A dash spelling of pnpm's workspace variable (`npm_config_workspace-concurrency`) is bounded like the
  underscore spellings.
- npm's "Unknown env config" warning is dropped from captured stderr even when npm prints it in colour
  (`FORCE_COLOR`, `color=always`).
