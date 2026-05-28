# ADR-095 — Verifier-Backed Acceptance Criteria and the Auditor Loop

**Status**: Accepted  
**Date**: 2026-05-08  
**Author**: Recovery+Hardening Lead (T9187 campaign)  
**Supersedes**: N/A  
**Related**: ADR-051 (evidence-required gates), ADR-062 (worktree merge), T9187, T9192

---

## Context

On 2026-05-08 the owner audited the v2026.5.57 release and found that multiple
tasks (T9050, T9047, T9022, T9023, T9045, T9025, T9064) had been marked done by
Leads after writing scaffold-only implementations. The pattern:

1. Implementer writes the interface/stub.
2. Implementer runs `cleo complete` (or the Lead calls it directly).
3. No independent verification — the Lead trusts the Implementer's claim.
4. The AC text says "X is implemented" but X is a no-op stub.

This is the **scaffold-and-mark-done failure mode**. It is undetectable by
textual AC inspection alone. The only reliable countermeasure is a verifier
script that fails on scaffold implementations and passes only when the real
implementation is complete.

---

## Decision

### D1 — Verifier-First Pattern

**Before spawning an Implementer, the Lead MUST:**

1. Write `scripts/verify-<taskId>-fu.mjs` (or `scripts/verify-<taskId>.mjs`)
   that programmatically checks every AC bullet.
2. Run the verifier locally against the current (partial) state.
3. Confirm the verifier exits **non-zero** (proves it measures the right thing).
4. Commit the verifier: `chore(TXXX): verifier script — measures AC for auditor loop`.

This commit must precede any Implementer spawn. The verifier is the SSoT for
what "done" means.

### D2 — Implementer Protocol

The Implementer's job is NOT to interpret AC text. Their job is to make the
verifier exit 0. The spawn prompt MUST include:

```
## CRITICAL ADDITIONS (Recovery Lead protocol)
- DO NOT run cleo complete — Lead handles it after independent auditor passes.
- Run node scripts/verify-<taskId>-fu.mjs before returning success.
- If it exits non-zero, you have NOT completed the task.
- Return "Implementation blocked" if you cannot make it pass after 3 attempts.
```

### D3 — Auditor Loop (Mandatory for non-trivial tasks)

After the Implementer returns, the Lead MUST spawn an independent Auditor:

- The Auditor receives a **clean prompt with no Implementer claims visible**.
- The Auditor's only job: run the verifier, report exit-code.
- If the Auditor reports "Audit fail": re-spawn Implementer with the diagnostic.
- Max 4 iterations. After 4th fail: mark BLOCKED with full diagnostic.

**The Lead handles `cleo complete` — NEVER the Implementer.**

### D4 — CLI surface (`cleo verify --acceptance-check`)

The `cleo verify` command gains a `--acceptance-check [script]` flag:

- Resolves `scripts/verify-<taskId>-fu.mjs` (or explicit path).
- Runs it via `node`. Exits non-zero if verifier exits non-zero.
- Error: `E_ACCEPTANCE_VERIFIER_FAILED`.
- Blocking: gate writes do NOT proceed if verifier fails.

### D5 — CLI surface (`cleo audit verifier <taskId>`)

The `cleo audit` command gains a `verifier` subcommand:

- Resolves and runs the verifier script independently.
- Explicitly states: "Does NOT trust any prior Implementer claims."
- Exits 0 only if verifier exits 0.
- This is the Auditor arm of the loop.

### D6 — Orchestrator Skill Update

The `ct-orchestrator` skill MUST document the Auditor Loop pattern with the
Phases A through E described in this ADR.

---

## Verifier Script Convention

Scripts live in `scripts/` at the repo root. Naming:

- `verify-<taskId>-fu.mjs` — recovery follow-up convention (T9187 campaign)
- `verify-<taskId>.mjs` — general convention

**Requirements**:
- Exit 0 if and only if ALL AC bullets are programmatically satisfied.
- Exit non-zero with descriptive error output on any failure.
- No mocking — test against real implementations.
- Committed to git BEFORE any Implementer spawn.

---

## Consequences

### Positive

- Scaffold-and-mark-done is caught immediately — the verifier fails on stubs.
- Claims are backed by code, not prose.
- The auditor-loop is reproducible: anyone can re-run the verifier.
- Traceability: verifier commit SHA precedes implementation commit SHA in git log.

### Negative

- More upfront work per task (writing the verifier).
- Leads must resist the urge to relax verifier checks when implementations are hard.

### Neutral

- The verifier does not replace test suites — it complements them.
- Verifiers may import production code to test real behavior.

---

## Implementation

- `cleo verify --acceptance-check`: `packages/cleo/src/cli/commands/verify.ts`
- `cleo audit verifier`: `packages/cleo/src/cli/commands/audit.ts`
- Example verifiers: `scripts/verify-t9188-fu.mjs` through `scripts/verify-t9192-fu.mjs`
- Skill update: `~/.claude/skills/ct-orchestrator/SKILL.md`

---

## References

- ADR-051: Evidence-required gates (basis for anti-phantom verification)
- ADR-062: Worktree merge — `git merge --no-ff`, never cherry-pick
- T9187: AUDIT-RECOVERY-2026-05-08 (root epic)
- T9192: PROTOCOL-HARDEN (implementation task for this ADR)
