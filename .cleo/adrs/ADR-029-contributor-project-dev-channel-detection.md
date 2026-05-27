# ADR-029: Contributor Project Dev Channel Detection

**Status**: Accepted
**Date**: 2026-03-07
**Task**: T5576
**Related ADRs**: ADR-016 (Installation Channels), ADR-026 (Release System Consolidation)

---

## 1. Context

ADR-016 §2.3 defines the `cleo-dev` contributor dev channel: a local build symlink at `~/.local/bin/cleo-dev` that points to `dist/cli/index.js` in the CLEO source repository. This channel is isolated from the production `@cleocode/cleo@latest` install.

However, nothing in the CLEO system marks a project as "this IS the CLEO source repository" in a machine-readable way. The result, observed during T5576 dogfooding, is:

- LLM agents working inside the CLEO repo use the **production MCP server** (`@cleocode/cleo@latest`) from `.mcp.json`
- The published version lags `develop` by at least one release cycle
- New MCP operations added on `develop` return `E_INVALID_OPERATION` from the production server
- Agents waste context debugging "broken" operations that actually work fine in the local build
- No signal in agent context says "use cleo-dev instead"

This is a structural trap: agents know about `cleo-dev` from ADR-016 documentation, but have no automated signal to activate dev-channel awareness for the current project.

---

## 2. Decision

### 2.1 Contributor Detection

CLEO SHALL auto-detect contributor projects by fingerprinting the source layout at init time. A project is a contributor project if and only if ALL of the following are true:

1. `src/mcp/` directory exists
2. `src/dispatch/` directory exists
3. `src/core/` directory exists
4. `package.json` exists with `"name": "@cleocode/cleo"`

This fingerprint is intentionally strict — only the canonical CLEO source repository matches all four criteria. Forks with renamed packages do not auto-qualify.

### 2.2 Config Flag

When a contributor project is detected, `ensureConfig()` writes a `contributor` block to `.cleo/config.json`:

```json
{
  "contributor": {
    "isContributorProject": true,
    "devCli": "cleo-dev",
    "verifiedAt": "<ISO 8601 timestamp>"
  }
}
```

**Backfill**: `ensureConfig()` also backfills this block into existing configs that predate this ADR, so no manual intervention is needed on upgrade.

**Schema**: The `contributor` block is defined in `schemas/config.schema.json` with `additionalProperties: false`.

### 2.3 Agent Context Injection

When `contributor.isContributorProject === true`, `ensureInjection()` appends an inline warning block to the AGENTS.md injection content:

```markdown
# CLEO Contributor Project — Dev Channel Required

This project IS the CLEO source repository. The production `@cleocode/cleo@latest`
MCP server and `cleo` CLI are STALE relative to the current branch.

**ALWAYS use `cleo-dev` CLI and the local `cleo-dev` MCP server** when:
- Testing new operations or features added on the `develop` branch
- Running the release pipeline (`cleo-dev release ship ...`)
- Dogfooding any code change that hasn't yet been published to npm

**Never use `cleo` (production) to test unreleased code on this repo.**
The published `@latest` lags `develop` by at least one release cycle.
```

This block is regenerated on every `cleo init`, `cleo upgrade`, and `admin.inject.generate` call.

### 2.4 Doctor Check

A new `contributor_channel` doctor check verifies:

- If `contributor.isContributorProject === false` (or block absent): passes silently
- If `isContributorProject === true` and `cleo-dev` is on PATH: passes with confirmation message
- If `isContributorProject === true` and `cleo-dev` is NOT on PATH: warning with fix `./install.sh --dev`

### 2.5 Verification Scope

The contributor flag does NOT prevent using the production `cleo` command — it only injects context. The flag is advisory: it informs agents, not gates operations. Enforcement is at the agent context level, not the runtime level.

---

## 3. Consequences

### Positive

- LLM agents working inside the CLEO source repo receive an explicit, persistent warning in their context: use `cleo-dev`
- No manual flag-setting required — detection is automatic on init/upgrade
- Doctor check surfaces misconfigured dev environments proactively
- `verifiedAt` timestamp allows future tooling to detect stale flags

### Negative

- Auto-detection logic is brittle if the source layout changes significantly (mitigated: all 4 criteria must match, and the package name check provides strong identity)

### Neutral

- The flag is in `.cleo/config.json`, which is git-tracked. Contributors cloning fresh will have it auto-generated on first `cleo init`
- Production projects with similar source layouts (node, with src/) are not affected — `package.json#name` check prevents false positives

---

## 4. Implementation

- `src/core/scaffold.ts`: `isCleoContributorProject()` detector, `ensureConfig()` writes/backfills the block
- `src/core/injection.ts`: `buildContributorInjectionBlock()`, called from `ensureInjection()`
- `src/core/system/health.ts`: `checkContributorChannel()` doctor check
- `schemas/config.schema.json`: `contributor` block definition

---

## 5. References

- ADR-016: Installation Channels and Dev Runtime Isolation (§2.3 Contributor Dev Channel)
- ADR-026: Release System Consolidation (T5576 — the session where this gap was discovered)
- T5576: LOOM Release Pipeline Remediation (epic)

---

**END OF ADR-029**
