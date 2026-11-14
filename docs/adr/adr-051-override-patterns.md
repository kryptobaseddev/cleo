# ADR-051: Override Patterns — When and How to Use CLEO_OWNER_OVERRIDE

## Summary

ADR-051 ("Evidence-Based Gate Integrity") establishes that every task completion gate (`implemented`, `testsPassed`, `qaPassed`, `documented`, `securityPassed`, `cleanupDone`) must be backed by **programmatic evidence** validated against git, the filesystem, or the toolchain.

**However**, not all work fits the standard evidence model. This document describes the **override pattern** — when and how to use `CLEO_OWNER_OVERRIDE` to bypass gates on legitimate work that lacks conventional proof.

## Override Pattern Design

### Prerequisites

**ADR-051 override requires**:
1. A valid reason (not arbitrary)
2. An audit trail (all overrides logged to `.cleo/audit/force-bypass.jsonl`)
3. Owner-level authorization (via environment variable)
4. Documentation (reason must be captured)

### Trigger Conditions

Override when **standard evidence atoms cannot be collected** for legitimate reasons:

| Condition | Example | Valid? |
|-----------|---------|--------|
| Work delivered in separate repo (not git-tracked) | T924: `/mnt/projects/cleo-sandbox/harnesses/` | ✅ YES |
| Declarative config (not code) | T924: Dockerfile, no biome/tsc applicable | ✅ YES |
| Harness scaffold (no executable tests) | T924: README + structure verified manually | ✅ YES |
| Documentation-only task | T1418: created `.md` files, no tests | ✅ YES |
| Release ceremony (formal but not code-tested) | T820: `cleo release push` verified CLI output | ✅ YES |
| Incident hotfix (time-critical) | T1105: P0 bug, owner-approved bypass | ⚠️ MAYBE |
| "Tests are too hard to run" | Agent avoids test flake | ❌ NO |
| "Biome formatting is annoying" | Agent refuses linting | ❌ NO |

### Override Invocation

```bash
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="<clear, concise reason>" \
  cleo verify T### --all --evidence "note:<summary>"
```

**Environment variables**:
- `CLEO_OWNER_OVERRIDE=1` — Must be set to a truthy value to enable override mode
- `CLEO_OWNER_OVERRIDE_REASON` — Required; must explain why the override is needed

**Evidence requirement** (post-ADR-051):
- Must still pass `--evidence` even in override mode
- The evidence atom becomes a memo, not a proof
- Example: `--evidence "note:T924 harness scaffold — Dockerfile is declarative; biome/tsc not applicable"`

## Documented Override Examples

### Example 1: Separate Repository Delivery (T924)

**Context**: T924 delivered CleoOS harness scaffolds to `/mnt/projects/cleo-sandbox` (separate git repo, not tracked by cleocode).

**Applied override**:

```bash
# Implemented gate
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T924: delivered files live in /mnt/projects/cleo-sandbox (separate repo, not tracked by cleocode git)" \
  cleo verify T924 --gate implemented --evidence "note:owner-approved;commit:7a14c8099342b109c35ed5125a589f537fc9b37d"

# Tests gate
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T924: harness scaffold — no executable tests; Dockerfile structure and README content verified against claude-code model" \
  cleo verify T924 --gate testsPassed --evidence "note:owner-approved"

# QA gate
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T924: Dockerfile is a declarative config file; biome/tsc not applicable" \
  cleo verify T924 --gate qaPassed --evidence "note:owner-approved"
```

**Audit log entry** (`.cleo/audit/force-bypass.jsonl`):

```json
{
  "timestamp": "2026-04-18T01:04:15.282Z",
  "taskId": "T924",
  "gate": "implemented",
  "action": "set",
  "override": true,
  "overrideReason": "T924: delivered files live in /mnt/projects/cleo-sandbox (separate repo, not tracked by cleocode git)",
  "command": "/home/keatonhoskins/.npm-global/bin/cleo verify T924 --gate implemented --evidence note:owner-approved;commit:7a14c8099342b109c35ed5125a589f537fc9b37d"
}
```

### Example 2: Sandbox Repo (No Git Commits)

**Context**: T921 provisioned a sandbox harness with intentionally no commits (per orchestrator design).

**Applied override**:

```bash
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T921: sandbox repo has no commits by design (orchestrator instruction); files verified on filesystem" \
  cleo verify T921 --gate implemented \
  --evidence "files:/mnt/projects/cleo-sandbox/harnesses/opencode/Dockerfile,/mnt/projects/cleo-sandbox/harnesses/opencode/README.md,/mnt/projects/cleo-sandbox/bin/sandbox-install"
```

**Rationale**: The files exist on the filesystem and were manually verified; git commits don't exist by design.

### Example 3: Documentation-Only Task (T1418)

**Pattern for pure documentation deliverables**:

```bash
# Implemented gate — files exist in repo
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T1418: documentation task; files created in docs/" \
  cleo verify T1418 --gate implemented \
  --evidence "commit:$(git rev-parse HEAD);files:docs/release/dep-pruning.md,docs/adr/ADR-051-override-patterns.md"

# Tests gate — no executable tests for docs
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T1418: documentation task; no tests" \
  cleo verify T1418 --gate testsPassed --evidence "note:documentation; no unit tests"

# QA gate — markdown lint (not biome/tsc)
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T1418: documentation markdown; biome/tsc not applicable" \
  cleo verify T1418 --gate qaPassed --evidence "note:markdown lint clean"

# Documented gate — docs are the deliverable
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T1418: documentation task" \
  cleo verify T1418 --gate documented --evidence "files:docs/release/dep-pruning.md,docs/adr/ADR-051-override-patterns.md"

# Security gate — documentation only
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T1418: documentation only; no network surface" \
  cleo verify T1418 --gate securityPassed --evidence "note:doc only"

# Cleanup gate
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T1418: documentation task; 2 files created" \
  cleo verify T1418 --gate cleanupDone --evidence "note:2 files added; no refactor"
```

### Example 4: Release Ceremony (T820)

**Context**: Release tasks follow a formal ceremony (prepare → commit → tag → push) but have no traditional "tests."

**Pattern**:

```bash
# Implemented gate — manifest entry + git tag
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T820: release ceremony; gates enforced by release-engine.ts" \
  cleo verify T820 --gate implemented \
  --evidence "files:.cleo/releases.jsonl;commit:18128e3cec6b61f7486c136fb9a2cd956c51b37c"

# Tests gate — release pipeline gates (IVTR, manifest validation)
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T820: release task; cleo release ship enforces IVTR + manifest gates" \
  cleo verify T820 --gate testsPassed --evidence "note:release gates passed (ivtr_state=released)"

# QA gate — biome + tsc run on root before ship
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T820: release gates enforce pnpm run build + tests before tag" \
  cleo verify T820 --gate qaPassed --evidence "note:release gates enforced pre-tag"

# Documented gate — release notes are the changelog
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T820: release changelog is the documentation" \
  cleo verify T820 --gate documented --evidence "note:release CHANGELOG.md auto-generated"

# Security gate — release is npm-published
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T820: npm publishing enforces package integrity" \
  cleo verify T820 --gate securityPassed --evidence "note:published to npm registry"

# Cleanup gate
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="T820: release task; shipped v2026.4.100" \
  cleo verify T820 --gate cleanupDone --evidence "note:release shipped; dependency pruning pending"
```

## Anti-Patterns

### DO NOT Override To Avoid Work

```bash
# ❌ WRONG: Avoiding a test flake
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="tests are flaky, skipping" \
  cleo verify T### --gate testsPassed --evidence "note:flaky"
```

**Why**: Flaky tests are a root-cause problem, not something to bypass. Fix the flake, then verify.

### DO NOT Override Incomplete Work

```bash
# ❌ WRONG: Incomplete implementation
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="ran out of time" \
  cleo verify T### --gate implemented --evidence "note:partial"
```

**Why**: Incomplete work belongs in a follow-up task, not marked done.

### DO NOT Chain Overrides

```bash
# ❌ WRONG: Multiple overrides on same gate without fixing root cause
cleo verify T### --gate implemented --evidence "note:approved (override #1)"
# ... later ...
cleo verify T### --gate implemented --evidence "note:approved (override #2)"
```

**Why**: Repeated overrides indicate the gate is broken. Refactor the gate instead.

## Audit Log Format

Every override is logged to `.cleo/audit/force-bypass.jsonl` (one JSON object per line).

**Log schema**:

```typescript
interface ForceBypassEntry {
  timestamp: string;         // ISO 8601
  taskId: string;            // e.g., "T924"
  gate: string;              // e.g., "implemented"
  action: string;            // Always "set"
  evidence: {
    atoms: Array<{
      kind: string;          // e.g., "override"
      reason: string;        // Override reason
    }>;
    override: boolean;        // Always true
    overrideReason: string;   // From CLEO_OWNER_OVERRIDE_REASON
  };
  agent: string;             // Agent ID or "unknown"
  sessionId: string | null;  // CLEO_SESSION_ID or null
  pid: number;               // Process ID
  command: string;           // Full command line invoked
}
```

**Query the audit log**:

```bash
# All overrides for a task
grep '"taskId":"T924"' .cleo/audit/force-bypass.jsonl | jq .

# All overrides on a specific gate
grep '"gate":"implemented"' .cleo/audit/force-bypass.jsonl | jq '.overrideReason'

# Timeline of all overrides
jq -s 'sort_by(.timestamp)' .cleo/audit/force-bypass.jsonl | jq '.[] | "\(.timestamp): \(.taskId) (\(.gate)) — \(.overrideReason)"'
```

## Decision Tree

```
┌──────────────────────────────────────────────────────────────┐
│ Do I Need CLEO_OWNER_OVERRIDE?                               │
├──────────────────────────────────────────────────────────────┤
│                                                              │
├─ Is the gate failing because evidence can't be collected?    │
│  ├─ YES: Can I collect the evidence anyway?                  │
│  │  ├─ YES: Collect it and pass. No override needed.         │
│  │  └─ NO: Is there a legitimate reason?                     │
│  │      ├─ YES (e.g., work in separate repo) → OVERRIDE OK  │
│  │      └─ NO (e.g., avoiding work) → FIX FIRST, THEN GATE  │
│  └─ NO: The gate passed normally. No override needed.        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Governance

- **Who can invoke**: Owner (environment variable gated)
- **Frequency**: Rare (overrides should be exceptional)
- **Audit trail**: All invocations logged to `.cleo/audit/force-bypass.jsonl`
- **Review cycle**: Audit logs reviewed at release time; persistent overrides on the same gate → escalate as a process issue

## See Also

- **ADR-051** — Evidence-Based Gate Integrity (parent decision)
- `~/.cleo/templates/CLEO-INJECTION.md` — Pre-Complete Gate Ritual (full evidence syntax)
- `packages/core/src/verification/` — Gate verification engine
- `.cleo/audit/force-bypass.jsonl` — Audit log of all overrides
