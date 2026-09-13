---
id: manifest-verify-not-regenerate
tasks: [T12163]
kind: fix
summary: "`pretypecheck`/`prebuild` verify the command manifest instead of regenerating it, so running a tool no longer mutates a tracked file"
---

**gh#1306.** `pretypecheck` and `prebuild` both ran the manifest generator, so
**every typecheck and every build rewrote a tracked file**:

```
$ git status --porcelain=v1 --untracked-files=no | wc -l
0
$ pnpm --filter @cleocode/cleo run gen:manifest
$ git status --porcelain=v1 --untracked-files=no | wc -l
1
 M packages/cleo/src/cli/generated/command-manifest.ts
```

Two costs. Every agent got a dirty tree they did not create — one maintainer
reasonably suspected another session's stash had leaked into their worktree. And
`captureDirtyFingerprint` feeds `git status` into the evidence cache key
`(canonical, cmd, args, HEAD, dirtyFingerprint)`, so **`tool:typecheck` changed
the fingerprint as a side effect of running**, and every subsequent `tool:test` /
`tool:lint` / `tool:typecheck` missed cache. The tools invalidated each other
indefinitely, on a path that fires every time.

This is the second instance of gh#1221's shape — *a tool invalidates its own
cache by running* — and the first one's remedy does not reach it: that was about
**untracked** noise (`--untracked-files=no`), this is a **tracked** mutation. The
general rule: **a build step that mutates tracked files is an evidence-fingerprint
hazard, and the fingerprint cannot defend itself against one.**

`--check` verifies and never writes; `gen:manifest` remains the explicit write
path. `pretypecheck`/`prebuild` now use `--check`.

**The generator also formats its own output now**, which is what makes `--check`
meaningful. Previously it emitted unformatted source, biome reformatted it, the
formatted version was committed, and the next run un-formatted it again — ~183
lines of pure formatting churn per regeneration. That noise was not cosmetic: it
**camouflaged real drift**. Two commands were missing from the committed manifest
inside it — `cleo doctor memory-guard`, the documented remedy for the P0
machine-freeze issue, and `cleo doctor superseded-store`, the command AGENTS.md
prescribes for the which-DB-is-real confusion. Both are ones AGENTS.md tells
agents to reach for.

The same regeneration now produces **18 insertions and 1 deletion — pure
content** — where it previously produced 201 lines.

One measured subtlety, recorded in the source: the formatting scratch file must
live in the **output directory**, not `os.tmpdir()`. Biome resolves configuration
and per-path overrides by path, so formatting identical bytes at `/tmp` and at
`packages/cleo/src/cli/generated/` yields different output — verified by a
flip-flop where the temp-path result was immediately reformatted at the real
path, which would have made `--check` fail forever.

The regenerated manifest is committed here so the tree is self-consistent when
this lands. No runtime behaviour changes: `memory-guard` and `superseded-store`
always worked, because they are `doctor` subcommands registered in `doctor.ts`
rather than top-level manifest entries.
