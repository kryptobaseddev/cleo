---
name: ct-master-tac
description: >-
  Master Tactical Bundle for CleoOS autonomous execution. Installs the complete
  primitive library needed to run the full agentic execution layer on a fresh CleoOS
  install: 12 CANT protocol files (research, consensus, architecture-decision,
  specification, decomposition, implementation, validation, testing, contribution,
  release, artifact-publish, provenance), the canonical platform team definition, and
  the skills manifest entry. Use when bootstrapping a new CleoOS project, verifying that
  all protocol primitives are present, or recovering a broken protocol tree. Triggers on:
  "install master tac", "bootstrap protocols", "tools.skill.install ct-master-tac",
  "verify protocol bundle", "repair protocol files", "fresh CleoOS install".
version: 1.0.0
tier: 1
core: false
category: meta
protocol: null
argument-hint: "[--verify] [--force]"
allowed-tools: ["Read", "Write", "Bash(cp *)", "Bash(ls *)", "Bash(mkdir *)", "Bash(test *)"]
dependencies:
  - ct-cleo
sharedResources:
  - subagent-protocol-base
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
install-hook: "tools.skill.install ct-master-tac"
---

# ct-master-tac — Master Tactical Bundle

> **Provenance**: @task T430, @epic T382, @umbrella T377
> **Bundle version**: 1.0.0 — ships with CleoOS v2026.4.x

The Master TAC (Tactical Asset Cache) plugin bundles every protocol primitive the
autonomous execution layer requires. After `tools.skill.install ct-master-tac`, a
fresh CleoOS install has batteries-included support for the full RCASD-IVTR+C
lifecycle.

---

## What's Inside

### 12 CANT Protocol Files (`bundled/protocols/`)

| File | ID | Stage | Skill |
|------|----|-------|-------|
| `research.cant` | RSCH | research | ct-research-agent |
| `consensus.cant` | CONS | consensus | ct-consensus-voter |
| `architecture-decision.cant` | ADR | architecture-decision | ct-adr-recorder |
| `specification.cant` | SPEC | specification | ct-spec-writer |
| `decomposition.cant` | DCMP | decomposition | ct-epic-architect |
| `implementation.cant` | IMPL | implementation | ct-task-executor |
| `validation.cant` | VALID | validation | ct-validator |
| `testing.cant` | TEST | testing | ct-ivt-looper |
| `contribution.cant` | CONT | cross-cutting | ct-contribution |
| `release.cant` | REL | release | ct-release-orchestrator |
| `artifact-publish.cant` | ART | release | ct-artifact-publisher |
| `provenance.cant` | PROV | release | ct-provenance-keeper |

### Platform Team (`bundled/teams/platform.cant`)

Canonical 3-tier team definition with planning-lead, engineering-lead, and
validation-lead. Mirrors the `.cleo/teams.cant` seed from a standard CleoOS init.

---

## Install Behaviour

```bash
tools.skill.install ct-master-tac
```

The install hook:

1. Copies `bundled/protocols/*.cant` to
   `packages/core/src/validation/protocols/cant/` (skips files that already exist
   unless `--force` is provided).
2. Copies `bundled/teams/platform.cant` to `.cleo/teams.cant` (skips if exists).
3. Verifies that all 12 protocol files are present and parseable.
4. Emits an install summary to stdout.

Running install a second time is a no-op (idempotent).

---

## Verify Mode

```bash
tools.skill.install ct-master-tac --verify
```

Read-only. Checks that all bundled files are present at their target locations and
reports any missing or mismatched files without writing anything.

---

## Plugin Boundary (§11 criteria)

This plugin meets all three §11 criteria from `docs/specs/CLEO-OPERATION-CONSTITUTION.md`:

- **(a)** Requires reading protocol CANT files managed outside the core CLI binary.
- **(b)** Reads `bundled/` assets not managed by the CLEO core package.
- **(c)** Removing it from core does not break any mandatory agent workflow — it is
  a bootstrap/recovery utility only.

---

## Upgrade Path

When new protocol files are added, bump `version` in this SKILL.md and
`manifest.json`, add the new `.cant` file to `bundled/protocols/`, and update the
`manifest.json` `files` array. The install hook will copy the new file on next run.
