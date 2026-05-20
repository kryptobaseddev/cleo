# Evidence and Gates

ADR-051 requires every `cleo complete <TASK_ID>` to be backed by
programmatic evidence. The executor MUST attach evidence atoms to each
gate before completing; the verify step re-validates them against git,
the filesystem, and the toolchain. This reference defines atom shapes,
canonical names, and the failure modes most often hit.

## The Gate Set

Every task carries six standard gates. Optional gates may be added per
task; the standard set is non-negotiable.

| Gate | Meaning | Evidence kind |
|------|---------|---------------|
| implemented | Code change exists | `commit:<sha>` + `files:<list>` |
| testsPassed | Tests green | `tool:test` or `test-run:<json>` |
| qaPassed | Lint + typecheck clean | `tool:lint` + `tool:typecheck` |
| documented | Docs updated | `files:<docs-paths>` |
| securityPassed | Security scan or waiver | `tool:security-scan` or `note:<rationale>` |
| cleanupDone | Branch/cleanup summary | `note:<text>` |

Decision-only tasks (no code change; the deliverable is a recorded BRAIN
decision) use a distinct `implemented` atom shape:

```bash
cleo verify T### --gate implemented \
  --evidence "decision:D-arch-001;files:docs/research-note.md"
```

This shape eliminates the `CLEO_OWNER_OVERRIDE` path on decision-only
completion (per T1875).

## Atom Kinds

### `commit:<sha>`

The git commit SHA where the work landed. Re-validated for reachability
from HEAD at complete time. The SHA MUST be a full or short SHA that
`git rev-parse` resolves.

```bash
cleo verify T### --gate implemented \
  --evidence "commit:b8e723d78;files:packages/skills/.../references/triggers.md"
```

If the worktree's branch has been merged to main since the commit, the
atom still resolves. If the commit was rebased away, validation fails
with `E_EVIDENCE_STALE` — re-attach the new SHA.

### `files:<comma-list>`

Paths affected by the work. Re-validated by sha256 against the on-disk
file at complete time. If the file's contents change between verify
and complete (e.g. a later edit drifts the hash), validation fails with
`E_EVIDENCE_STALE`.

```bash
--evidence "files:packages/cleo/src/commands/release-plan.ts,packages/cleo/__tests__/release-plan.test.ts"
```

Use forward slashes; absolute or repo-relative paths both work.

### `tool:<name>`

Canonical tool name. CLEO resolves to the project's actual command via
`.cleo/project-context.json` (`testing.command`, `build.command`) with
per-`primaryType` fallbacks. Canonical names:

| Canonical | Resolves to (Node) | Fallback |
|-----------|-------------------|----------|
| `test` | `pnpm run test` | `cargo test`, `pytest`, `go test` |
| `build` | `pnpm run build` | `cargo build`, etc. |
| `lint` | biome / eslint | clippy, ruff |
| `typecheck` | `tsc -b` | mypy |
| `audit` | `pnpm audit` | `cargo audit` |
| `security-scan` | varies | varies |

Legacy aliases still work: `pnpm-test`, `tsc`, `biome`, `cargo-test`,
`pytest` all map to canonical names.

### `test-run:<json-path>`

Path to a vitest JSON output file. Re-validated by hash. Preferred for
sharing test evidence across sibling tasks in the same wave.

```bash
pnpm vitest run --reporter=json --outputFile=/tmp/vitest-out.json
cleo verify T### --gate testsPassed --evidence "test-run:/tmp/vitest-out.json"
```

### `decision:<decision-id>`

A BRAIN decision ID (e.g., `D-arch-001`) or an `AGT-*` provenance ID.
Validated by lookup against the brain.db; status MUST be `proposed` or
`accepted`. Used for decision-only tasks where the deliverable is the
decision itself, not code.

### `note:<text>`

Free-form rationale. Always permitted; used when no programmatic atom
applies. Notes appear in the audit log but do not gate validation —
they document, they do not prove. Reserve for `cleanupDone`,
`securityPassed` waivers, and rare edge cases.

## The Ritual

The full per-task ritual, in order:

```bash
# 1. Implement and verify locally
pnpm biome check --write .
pnpm run build && pnpm run typecheck
pnpm run test
git add -p && git commit -m "feat(T###): <slug>"

# 2. Capture evidence for each gate (commit SHA from step 1)
SHA=$(git rev-parse HEAD)
FILES=$(git diff-tree --no-commit-id --name-only -r HEAD | paste -sd,)

cleo verify T### --gate implemented --evidence "commit:$SHA;files:$FILES"
cleo verify T### --gate testsPassed --evidence "tool:test"
cleo verify T### --gate qaPassed --evidence "tool:lint;tool:typecheck"
cleo verify T### --gate documented --evidence "files:docs/path/to/note.md"
cleo verify T### --gate securityPassed --evidence "note:no network surface"
cleo verify T### --gate cleanupDone --evidence "note:branch task/T### ready for merge"

# 3. Complete (CLEO re-validates everything)
cleo complete T###

# 4. Record learning
cleo memory observe "..." --title "..."
```

## Common Failure Modes

| Exit | Code | Cause | Fix |
|------|------|-------|-----|
| — | `E_EVIDENCE_MISSING` | Ran `verify --all` without `--evidence` | Re-run per-gate with atoms |
| — | `E_EVIDENCE_INSUFFICIENT` | Gate atom kind doesn't match required | See gate-atom table above |
| — | `E_EVIDENCE_TESTS_FAILED` | `tool:test` exit non-zero | Fix failing tests first |
| — | `E_EVIDENCE_TOOL_FAILED` | Lint/typecheck/etc exit non-zero | Fix source and re-run |
| — | `E_EVIDENCE_STALE` | Files or commit changed after verify | Re-verify before complete |
| — | `E_EVIDENCE_INVALID_DECISION` | Decision ID not found in BRAIN | Use `cleo memory decision-find` |
| — | `E_FLAG_REMOVED` | Tried `cleo complete --force` | `--force` removed per ADR-051 |

## Cache Behavior

Tool-evidence results are cached under `.cleo/cache/evidence/<key>.json`,
keyed on (canonical, cmd, args, HEAD, dirty-tree fingerprint). Parallel
verifies against identical state coalesce to one execution via a per-key
lock. Cross-worktree parallelism is bounded by a machine-wide per-tool
semaphore at `~/.local/share/cleo/locks/tool-<canonical>/`.

Tune with `CLEO_TOOL_CONCURRENCY_<TOOL>=<n>` (`0` disables). For most
worker agents this is set-and-forget; the orchestrator handles tuning.

## The Emergency Override

In rare incident-response scenarios, the override exists:

```bash
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="incident 1234 hotfix" \
  cleo verify T### --all --evidence "note:owner-approved"
```

The override appends to `.cleo/audit/force-bypass.jsonl`. Use only when
the owner has explicitly authorized — never as a routine shortcut to
skip gates.

## What NOT to Do

- ❌ Run `cleo complete` without verifying tests actually ran
- ❌ Run `cleo verify --all` without `--evidence` (REJECTED post-ADR-051)
- ❌ Use `cleo complete --force` (REMOVED post-ADR-051)
- ❌ Skip `cleo memory observe` on non-trivial tasks
- ❌ Self-attest without programmatic proof
- ❌ Modify files between `verify` and `complete` (caught by staleness check)
