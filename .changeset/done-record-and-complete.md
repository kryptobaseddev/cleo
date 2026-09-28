---
id: done-record-and-complete
tasks: [T12625]
kind: feat
summary: "`cleo done <id>` records every required gate from derived evidence in one write and completes the task; `cleo verify <id> --auto` records without completing"
---
Step 3 of the streamlined verification flow (spec `verify-streamlined-design`,
D11148–D11151), on top of the `cleo done --plan` planner.

- `recordTaskDone` (core) runs in a fixed order so every slow step finishes before
  the task write transaction opens: plan (git and gh) → `lint` and `typecheck` in
  parallel, then `test`, through the ADR-061 resolver and cache → typed gates once
  via `previewTaskGates` (their passes are cached, T12621) → one write.
- The write is ONE `validateGateVerify` call with the new `gateEvidence`
  (per-gate atom strings). Each gate's atoms go through the same parse →
  `validateAtom` → gate minimum → `checkTaskEvidenceContext` path a
  `--gate … --evidence …` write uses (that path is now one shared closure, not
  two), typed gates are served from the cache (`noRun`), all gates persist in
  one transaction, and `gates.jsonl` gets one line per gate as before.
- `cleo done <id>` then completes through the same `tasks.complete` operation
  `cleo complete` dispatches, and emits one envelope. Every stop is
  `E_DONE_BLOCKED` with one next step in `fix` / `details.next.command` and the
  original code in `details.cause`.
- There is no override flag, and a multi-gate write refuses `CLEO_OWNER_OVERRIDE`
  (`E_OVERRIDE_NOT_ACCEPTED`) without touching the override cap or
  `force-bypass.jsonl`; the audited override stays a single-gate `cleo verify` path.
- `cleo done` refuses to run from the main checkout when the task's work is in its
  worktree (`run-from-worktree`): the tools must measure that tree.
- `cleo verify --evidence` and `cleo complete` are unchanged.
- Before any tool or typed gate runs, the checked-out tree must contain the change
  `implemented` cites. For a branch change set, the change-set commit must be HEAD.
  For a PR change set, the merge commit must be an ancestor of HEAD. Otherwise the
  run stops with `checkout-required` and names the exact `git switch` command.
- Typed gates now run in, and build their cache key from, the caller's own worktree
  of this project (`resolveTypedGateRoot`), the same tree the evidence tools use.
  From the main checkout, or from any other directory, they still run in the CLEO
  root as before.
- Typed results are bound to content, not to a path. Each result records its
  tree-relative cwd, the verified HEAD, whether that tree was clean, and a
  tree-relative inputs hash.
- `cleo complete` from another checkout of the same project (for example, the
  orchestrator on main after the merge) accepts the result when:
  1. the verified tree was clean;
  2. its HEAD is an ancestor of the completing HEAD;
  3. the inputs rehash identically.
- Otherwise `complete` refuses and gives the exact `cleo verify … --gate testsPassed`
  command in `fix`. The recorded worktree is never re-entered.
- Results recorded before this change keep exact path-bound revalidation.
