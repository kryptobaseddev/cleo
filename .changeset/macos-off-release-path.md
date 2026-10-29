---
id: macos-off-release-path
tasks: [T14104, T13209]
kind: feat
summary: "Release never waits on GitHub macOS runners; macOS runs on main nightly and on demand and files an issue on failure; backup add --destination works"
---

`release-prepare` no longer runs macOS test shards, and `cleo release open`
no longer asks GitHub for macOS results or sends `skip-macos-tests` (the free
plan's five macOS jobs cost ~75 minutes per release). macOS is validated in
two places instead:

- `macos-main.yml` runs on every main push, nightly and on demand
  (`workflow_dispatch`). A failed run opens the one open `macos-regression`
  issue or comments on it. `ci.yml`'s nightly is now Linux only, so macOS
  never runs twice.
- `node scripts/release-mac-smoke.mjs` on the owner's Mac builds the exact
  commit, snapshots the real stores into a sandbox, runs the built CLI in a
  sandboxed HOME, and writes exit codes plus SHA256SUMS.

`cleo backup add --destination <dir>` now writes the backup into `<dir>` only
(the global copy goes under `<dir>/global`). That backup never rotates the
store's snapshot window, and nothing in the window rotates it (T13209). Before
this fix the flag was ignored, and the files went into the rotating
`.cleo/backups/sqlite/`.
