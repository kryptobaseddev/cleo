---
id: ADR-076
slug: adr-076-canonical-docs-ssot
title: Canonical Docs SSoT — `.cleo/canon.yml` + `cleo check canon docs` CI gate
status: Accepted
date: 2026-05-20
task: T9796
saga: SG-DOCS-CANON-CLOSURE (T9787)
supersedes: ADR-028
supersededBy: null
linkedTasks: [T9788, T9791, T9793, T9794, T9795]
---

# ADR-076: Canonical Docs SSoT

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.

> NOTE — numbering: ADR-074 and ADR-075 were already in use when this
> ADR landed (skills telemetry transport + skills federation trust
> ladder, both shipped under Saga SG-CLEO-SKILLS). The original T9796
> spec referenced "ADR-074"; the next free slot — ADR-076 — was used
> here. This ADR is the one referred to as "ADR-074" in the T9796
> commit message and is the canonical lockdown record.

---

## 1. Context

The Saga `SG-DOCS-CANON-CLOSURE` (T9787) shipped a SSoT for every
canonical document kind:

- **T9788** — `DocKindRegistry` consolidates 10 built-in kinds
  (`adr`, `spec`, `research`, `handoff`, `note`, `llm-readme`,
  `changeset`, `release-note`, `plan`, `rcasd`) into one taxonomy at
  `packages/contracts/src/docs-taxonomy.ts`.
- **T9791** — 1,427 legacy `.md` files across the five legacy sources
  (`.cleo/adrs/`, `.cleo/agent-outputs/`, `.cleo/rcasd/`, `docs/adr/`,
  `docs/spec/`) were imported into the SSoT blob store.
- **T9793** — `changeset` was promoted to a first-class DocKind with a
  SSoT-first dual-write path via `cleo changeset add`.
- **T9794** — `ct-documentor` + the protocol-injection triggers were
  updated so future agents reach for `cleo docs add` instead of `Write`.
- **T9795** — `.cleo/deprecations.yml` registry pattern was introduced;
  this ADR uses the same shape (`version + dictionary-of-entries`) for
  routing.

Despite all of the above, **nothing stopped an agent from writing
`.cleo/adrs/ADR-XXX.md` directly with a plain `Write` tool call**. The
SSoT existed, the docs verb routed through it, the agent prompts said
"use SSoT" — but the bypass remained available. A single non-compliant
session could re-introduce the same drift T9625 spent a quarter
closing.

This ADR locks the door.

---

## 2. Decision

### 2.1 Canonical routing registry (`.cleo/canon.yml`)

A new file `.cleo/canon.yml` (validated by
`.cleo/canon.schema.json`) MUST list every DocKind's routing:

```yaml
version: 1
kinds:
  adr:
    canonicalHome: ssot                # SSoT-only
    publishMirror: docs/adr/           # human-reviewable mirror
    rawMdAllowed: false                # gate-blocked
    rawMdPaths:
      - .cleo/adrs/
```

Per-kind keys:

- `canonicalHome: ssot` — bytes live in the attachment/blob store; the
  publish mirror is written by `cleo docs publish`.
- `canonicalHome: ssot-first` — dual-write via a dedicated cleo verb
  (e.g. `cleo changeset add`). Publish mirror is part of the contract
  (e.g. `.changeset/` is git-tracked by design).
- `rawMdAllowed: false` — new `*.md` files in any `rawMdPaths`
  directory fail the CI gate.
- `rawMdAllowed: true` — kind is dual-write or repo-root (e.g.
  `llm-readme` at `.`, `changeset` under `.changeset/`).

### 2.2 CI gate (`cleo check canon docs`)

A new subcommand `cleo check canon docs [--base <ref>]` MUST:

1. Load `.cleo/canon.yml` (no-op when missing — projects opt in).
2. Walk `git diff --diff-filter=A --name-only <base>...HEAD` for newly
   added `*.md` files (`<base>` defaults to `origin/main`, overridden
   in CI to `origin/${{ github.base_ref }}`).
3. For each addition, check whether its path starts with any
   `rawMdPaths` entry whose owning kind has `rawMdAllowed: false`.
4. Emit a LAFS error envelope with code `E_CANON_VIOLATION` and exit
   non-zero when any violation is found. The envelope MUST carry the
   full structured result (file list, kind, matched path, fix hint)
   under `error.details.result` so the CI surface can grep it.

The gate MUST NOT flag pre-existing files (T9791-imported legacy
`.md` content) — only ADDITIONS in the PR diff trigger it.

### 2.3 CI wiring

A new `canon-check` job (named "Canon Drift Check (T9796)") MUST be
added to `.github/workflows/ci.yml`. It runs only when
`needs.changes.outputs.code == 'true'`, builds the cleo CLI, and
invokes `cleo check canon docs --base origin/${{ github.base_ref }}`.

### 2.4 Documentation surface

`AGENTS.md` MUST include a "Canonical Docs Routing" section pointing
to `.cleo/canon.yml` and `cleo check canon docs` so agents reading
the file understand BOTH that the SSoT exists AND that bypassing it
is now a hard CI fail.

### 2.5 Supersession of ADR-028

ADR-028 ("CHANGELOG Generation Model") covered ONE specific document
flow — the section-aware merge of `CHANGELOG.md`. It predated the
SSoT-first changeset DocKind shipped by T9793 and the consolidated
docs-taxonomy registry shipped by T9788. The changeset DocKind +
canon routing replace the implicit policy that lived inside
`changelog-generator.ts`. ADR-028 is hereby marked **superseded**;
its operational rules (idempotent merge, `[custom-log]` block
preservation, CI gate on `## [VERSION]` header) remain valid but now
live behind the SSoT — direct `CHANGELOG.md` writes go through
`cleo changeset add` / `cleo docs publish`.

---

## 3. Consequences

### Positive

- **Bypass closed.** A raw `Write` to `.cleo/adrs/ADR-XXX.md` now
  fails `canon-check`. The agent cannot complete a PR without routing
  through `cleo docs add`.
- **Opt-in design.** Projects without `.cleo/canon.yml` see a no-op
  success envelope — the lockdown ships first to cleocode itself
  before any cross-project mandate.
- **Schema-validated.** `.cleo/canon.schema.json` constrains the
  routing file so a typo (`canonicalHome: ssot-first` vs
  `cononicalHome:`) is caught at parse time.
- **Mirrors `.cleo/deprecations.yml`** (T9795) — single, recognisable
  registry shape across the project.

### Negative

- **Friction for hot-fix flows.** An agent who genuinely needs to
  write a one-off `.md` (e.g. an emergency runbook) must route through
  `cleo docs add`. The dispatched LAFS error envelope includes the
  exact `cleo docs add` command to run, so the friction is one
  redirection rather than a research task.
- **CI cost.** One additional ~2-minute job per PR. The job runs only
  when `needs.changes.outputs.code == 'true'`, so doc-only PRs skip
  it.

### Neutral

- Existing legacy files migrated by T9791 are NEVER flagged — the
  `--diff-filter=A` semantics ensure the gate is forward-only.
- `.cleo/rcasd/` retains `rawMdAllowed: true` because RCASD directory
  trees are agent-generated and the SSoT mirror is still the source
  of truth via the dual-write contract.

---

## 4. Migration Path

1. Land `.cleo/canon.yml` + `.cleo/canon.schema.json` in this PR.
2. Land the `cleo check canon docs` subcommand + dispatch wiring.
3. Add the `canon-check` job to `.github/workflows/ci.yml`.
4. Update `AGENTS.md` to document the new gate.
5. Mark ADR-028 as superseded by this ADR.
6. (Future) Once the legacy `.cleo/adrs/` mirror reaches end-of-life
   (~v2026.6.0), remove that entry from `rawMdPaths` — additions
   anywhere under `.cleo/adrs/` will then fail unconditionally and
   the only valid path is `cleo docs add ... --type adr` →
   `docs/adr/`.

---

## 5. References

- ADR-028 (superseded) — CHANGELOG Generation Model
- ADR-073 — Above-Epic Naming (Task Hierarchy Charter)
- T9787 — Saga SG-DOCS-CANON-CLOSURE
- T9788 — DocKindRegistry (taxonomy SSoT)
- T9791 — 1,427 legacy `.md` files imported to SSoT
- T9793 — Changeset DocKind dual-write
- T9794 — ct-documentor + protocol-injection triggers
- T9795 — `.cleo/deprecations.yml` registry pattern
- `packages/contracts/src/docs-taxonomy.ts` — DocKindRegistry source
- `packages/cleo/src/dispatch/domains/check/canon-docs.ts` — gate engine

---

**END OF ADR-076**
