---
id: t12122-arch-gate-parity
tasks: [T12122]
kind: fix
summary: cleo check arch runs every gate the AGENTS.md table documents — 9 missing gates bundled, 4 undocumented gates documented, a gate on the gates, and the false Skill-Drift-gate claim removed
---

Closes GH #1253.

`cleo check arch` reported `Result: 10 passed, 0 failed, 0 skipped` while the AGENTS.md architectural-gate table documented **15** gates — and the two had drifted in **both** directions: 9 documented gates the runner never ran, and 4 gates it did run that the table never listed.

**Nothing was unenforced in CI** — all 15 documented lint scripts are invoked by `.github/workflows/*`, so `main` was never unprotected. That is what made this low *severity*. It is not what made it low *priority*: the misled party is the agent running `cleo check arch` to self-check before pushing, which AGENTS.md instructs **every** agent to do. That agent read `10 passed, 0 failed` as "clear against the table in front of me", when five of those gates had never been exercised locally.

This is GH #1245's defect class one level up — **a tool reporting success for work it did not do, with no signal the caller could read** — and it is gate 14's own failure mode (documentation naming something the binary does not have) pointed at the gate runner instead of at `cleo` verbs.

## What changed

1. **All 9 documented gates are now bundled**: `lint-paths-ssot`, `lint-deployed-template-parity`, `lint-node-engine-ssot`, `lint-publish-surface`, `lint-no-runtime-in-contracts`, `lint-tools-vs-skills-boundary`, `lint-no-crate-publish`, `lint-llm-chokepoint`, `lint-injection-commands` (gates 11-19). Each was measured before bundling: none needs a build, network access, or non-trivial time — **~800 ms for all nine combined** — so nothing had to be skipped, and the "bundle what you can and say what you skipped" fallback was not needed.
2. **All 4 runner-only gates are now documented** as table rows 16-19 (`lint-no-bare-get-active-session` T11640, `lint-no-domain-db-singleton` T12041, `lint-vitest-memory-safe` T12087, `lint-cli-startup-barrel-imports` T12076), each with its real baseline and the measurement that justifies it.
3. **A gate on the gates** — `scripts/lint-arch-gate-parity.mjs`, bundled as gate 20, zero-tolerance, no baseline. It asserts the script set in `packages/cleo/src/cli/commands/check.ts` equals the script set in the AGENTS.md gate table and fails naming the offenders plus the fix for each direction. It reads from **source, never `dist/`**, so it needs no build — the same contract as gates 14 and 15.

## Joins on script path, never gate number

The runner's `gate-N` ids and the table's row numbers are independent and already collide: runner `gate-6` is the `getActiveSession` gate, while table row 6 is the CLI package boundary. A reader cross-referencing "gate 6" between command output and AGENTS.md gets the wrong gate. Matching the two lists by number would have been fragile and would have invited renumbering churn across a doc many agents read, so the parity gate joins on the script path and AGENTS.md now says so explicitly.

## Guarding the guard

A parity check whose parser silently stopped matching would pass vacuously — the same "absence reads as success" shape as the bug it prevents. So the table parser **throws** rather than returning an empty set when the AGENTS.md heading moves, and the test suite pins a minimum bundled-gate count.

AGENTS.md prose also now records that `--strict` is aspirational rather than a passing gate: several gates carry real baselines, so `cleo check arch --strict` fails today by design (measured 6 passed / 4 failed before this change). Baseline mode is the one that must stay green.

## Also: a third instance of the same pattern, corrected in prose

While verifying the gates, a **third** place where CLEO documents enforcement it does not perform came to light, and its false claim is removed here (the real fix is tracked in GH #1256):

AGENTS.md's "Skill Maintenance" section asserted a `Skill Drift Check` CI gate failing with `E_SKILL_DRIFT_UNACKNOWLEDGED`, and named six tier-0 skills for which "NO trailer override permitted". **No such gate exists** — no script reads `packages/skills/internal/skill-coverage.yml`, no workflow runs the job, the map holds exactly one entry (`cleo-validator`, tier 2) pointing at paths its own comment says do not exist, and the six tier-0 skills have no coverage entries at all.

That claim is now replaced with an accurate statement: the convention is kept and labelled a convention, the absence of the gate is stated plainly, and GH #1256 is referenced. A false assurance is worse than none — it removes the vigilance that would otherwise substitute for the missing mechanism, and the risk is not theoretical: `CLEO-INJECTION.md`, a tier-0 artifact injected verbatim into every spawned agent, had drifted into describing bare `cleo show {id}` as the "full task record", which is the sentence that produced the GH #1243 data-loss incident.

**The pattern is worth naming:** three separate places where CLEO documents enforcement it does not perform — gate 14's original case (commands named in CLEO-INJECTION.md that never existed), this issue (a runner covering two-thirds of its documented table), and the Skill Drift gate (a CI job that was never built). All three are GH #1245's defect class — **a surface asserting a guarantee it does not deliver** — aimed at agents reading docs rather than agents reading output. It suggests the next audit question: *what else does AGENTS.md claim is enforced?*
