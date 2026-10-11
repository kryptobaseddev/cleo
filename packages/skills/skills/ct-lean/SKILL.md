---
name: ct-lean
description: >-
  Lean change discipline for CLEO work: the smallest change that fully solves the task, and
  a reply a busy owner understands in one read. Use on every coding task (writing, fixing,
  refactoring, reviewing, choosing dependencies) and when the owner asks for the simplest
  solution, YAGNI, or complains about over-engineering or bloat. Never trades away evidence
  gates, package boundaries, validation, data safety or anything the task asked for.
license: MIT
metadata:
  version: 1.0.0
  tier: core
  install: harness
  covers:
    - packages/core/src/orchestration/lean-change.ts
  lastReviewed: 2026-10-10
  stability: stable
  attribution: Adapted from Ponytail 5.1.0 by DietrichGebert (MIT) — https://github.com/DietrichGebert/ponytail
---

# ct-lean — the smallest complete change

The best code is the code never written. Solve the whole task with the least new code,
then end the reply with one or two lines: what you skipped or did not check, and any risk
the owner must know.

## Before you write

Read the task (`cleo show <id> --full`) and the code it touches. List every place the
change must reach: callers, tests, fixtures, config, exports, contracts. Run
`cleo nexus impact <symbol>` before editing a symbol, and grep for runtime callers static
analysis cannot see. Check what the change could break: data it would destroy or expose,
callers that stop working, stores it would migrate. That is scope. Extra features are not.

## Take the first option that fully works

1. **Does it need to exist?** Skip features, options and flexibility nobody asked for, and
   name them in one line. A vague request gets the smallest version that does the core job.
2. **Already in this codebase?** A helper, accessor, contract or pattern: use it the way the
   surrounding code does. Search `packages/core/src` and `packages/contracts/src` first.
3. **Standard library or platform feature?** Use it, unless the repo has its own (a house
   chokepoint such as `openDualScopeDb` or `cleo run` beats a raw primitive).
4. **An installed dependency?** Use it. Never add a dependency for a few lines.
5. **One line a reader gets at a glance?** One line.
6. **Otherwise** the minimum code that works, in the package the boundary table assigns.

## Rules

- Lazy about the solution, never about the change: finish every part the task needs,
  including the callers, tests, fixtures and docs the change breaks.
- No abstraction, wrapper, type conversion, option, config, boilerplate or "for later" code
  nobody asked for. Deletion beats addition. Keep the layers, contracts and conventions the
  repo already has.
- The shortest working diff wins once you know everything it must touch. A one-liner that
  needs decoding is not short.
- Comment only the why the code cannot show, in one line. Exported symbols still get TSDoc.
- Bug fix: grep every caller of the function you touch, then fix the root cause once in the
  shared code. No workaround at a call site.
- Code you move or merge keeps its error handling and validation.
- Between options of equal size, take the one that is correct on edge cases.
- New non-trivial logic (a branch, a loop, a parser, a store write, security) leaves one
  small test. Trivial changes need none. Run single test files through `cleo run --wait`.
- A shortcut with a known limit gets a comment: `shortcut: <the limit>, <when to upgrade>`.

## Never cut

- Validation at trust boundaries, error handling that prevents data loss, security,
  accessibility, and anything the task or owner asked for.
- CLEO evidence: every gate gets programmatic evidence (`cleo verify`), never self-attested.
- Type safety: no `any`, no `as unknown as X`; shared types live in `packages/contracts/`.
- The package boundary and the `cleo check arch` gates; a smaller diff in the wrong package
  is not smaller.
- Store safety: the DB chokepoint, migrations, backups, and the tracked identity files.

## Replies

Answer first: the first line is the result, answer or decision. Then only the evidence the
reader needs (bullets or a small table), then the skipped/unchecked line. No preamble,
recap or restated request. Owner questions go through the ask tool with populated options,
never in the reply (CLEO-INJECTION.md universal protocol step 7).

## References

- `references/examples.md` — worked CLEO examples, over-built vs lean.
- `references/never-cut.md` — the never-cut list with the gate that enforces each row.
- `references/reviewing.md` — a lean review checklist for PRs and your own diff.

---

Adapted from [Ponytail](https://github.com/DietrichGebert/ponytail) 5.1.0, Copyright (c) 2026
DietrichGebert, MIT License. Levels, statusline and plugin hooks are not carried over.
