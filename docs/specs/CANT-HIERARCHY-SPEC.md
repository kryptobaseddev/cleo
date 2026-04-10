# CANT 3-Tier Hierarchy Specification

**Status**: DRAFT
**Date**: 2026-04-09
**Epic**: T438 -- CleoOS Agent Platform
**Reference**: CLEO-ULTRAPLAN.md Section 2.4

---

## 1. Overview

CANT (Configuration-As-Code for Agents aNd Teams) files define agent
personas, team structures, tools, routing rules, and lifecycle stages.
This specification defines the 3-tier discovery and resolution algorithm
that governs how `.cant` files are located and merged at session start.

Prior to this specification, the CANT bridge (`cleo-cant-bridge.ts`)
only scanned the project tier (`<cwd>/.cleo/cant/`). This spec extends
discovery to three tiers with deterministic override semantics.

## 2. Tier Definitions

Three tiers exist, ordered from lowest to highest precedence:

| Tier | Precedence | XDG Variable | Default Path | Purpose |
|------|-----------|--------------|--------------|---------|
| Global | 1 (lowest) | `XDG_DATA_HOME` | `~/.local/share/cleo/cant/` | Shared agents available to all projects |
| User | 2 | `XDG_CONFIG_HOME` | `~/.config/cleo/cant/` | User-customized agents and overrides |
| Project | 3 (highest) | N/A | `<cwd>/.cleo/cant/` | Project-specific agents and teams |

### 2.1 Path Resolution

Paths MUST be resolved using `resolveCleoOsPaths()` from
`packages/cleo-os/src/xdg.ts`. The function respects `XDG_DATA_HOME`
and `XDG_CONFIG_HOME` environment variables when set, falling back to
XDG defaults.

```
Global tier:  resolveCleoOsPaths().cant       // ~/.local/share/cleo/cant/
User tier:    resolveCleoOsPaths().config + '/cant/'  // ~/.config/cleo/cant/
Project tier: join(ctx.cwd, '.cleo', 'cant')  // <cwd>/.cleo/cant/
```

### 2.2 Directory Structure

Each tier MAY contain any of the following subdirectories:

```
<tier-root>/
  agents/           -- agent persona definitions (*.cant)
  teams/            -- team composition definitions (*.cant)
  tools/            -- tool declarations (*.cant)
  routing/          -- model routing rules (*.cant)
  protocols/        -- lifecycle protocol definitions (*.cant)
  *.cant            -- top-level definitions
```

Subdirectory structure is informational. The discovery algorithm scans
recursively regardless of subdirectory names.

## 3. Override Semantics

Override resolution uses **filename-based deduplication**. When the same
filename appears in multiple tiers, the highest-precedence tier wins.

### 3.1 Matching Rule

Two `.cant` files are considered "the same" when their **basenames**
(filename without directory path) are identical. For example:

```
~/.local/share/cleo/cant/agents/backend-dev.cant   (global)
~/.config/cleo/cant/agents/backend-dev.cant         (user)
.cleo/cant/agents/backend-dev.cant                  (project)
```

All three have basename `backend-dev.cant`. The project-tier file wins.

### 3.2 Precedence Chain

```
Project > User > Global
```

- If a file exists at the project tier, the user-tier and global-tier
  files with the same basename are excluded.
- If a file exists at the user tier but not the project tier, the
  global-tier file with the same basename is excluded.
- If a file exists only at the global tier, it is included.

### 3.3 Additive Discovery

Files with unique basenames across tiers are all included. For example:

```
Global:  agents/security-reviewer.cant
User:    agents/custom-reviewer.cant
Project: agents/backend-dev.cant
```

All three files are included in the merged set because their basenames
are distinct.

## 4. Discovery Algorithm

The bridge MUST implement the following algorithm at `session_start`:

```
function discoverCantFilesMultiTier(projectDir, globalDir, userDir):
    // Phase 1: Scan all tiers (order does not matter)
    globalFiles  = discoverCantFiles(globalDir)   // recursive scan
    userFiles    = discoverCantFiles(userDir)      // recursive scan
    projectFiles = discoverCantFiles(projectDir)   // recursive scan

    // Phase 2: Build basename-keyed map (highest precedence last)
    fileMap = new Map<basename, absolutePath>()

    for file in globalFiles:
        fileMap.set(basename(file), file)

    for file in userFiles:
        fileMap.set(basename(file), file)    // overrides global

    for file in projectFiles:
        fileMap.set(basename(file), file)    // overrides user + global

    // Phase 3: Return merged list
    return Array.from(fileMap.values())
```

### 4.1 Error Handling

- If a tier directory does not exist, it is silently skipped (no error).
- If a tier directory exists but is unreadable (permissions), it is
  silently skipped and a diagnostic warning is emitted if the UI is
  available.
- The bridge MUST NOT crash Pi if any tier scan fails. Best-effort
  semantics apply (per ULTRAPLAN guardrails).

### 4.2 Diagnostic Reporting

The `/cant:bundle-info` command SHOULD report:

- Total files discovered per tier
- Number of overrides (files that were shadowed by a higher tier)
- The final merged file count passed to `compileBundle()`

## 5. `compileBundle()` Contract

The merged file list from the discovery algorithm is passed directly to
`compileBundle()` from `@cleocode/cant`. The compiler does not need to
know which tier each file came from. Tier information is purely a
discovery-time concern.

## 6. Future Extensions

### 6.1 `.cantz` Package Format

Packaged agents (`.cantz` archives) install their contents into a tier
directory. Once extracted, their `.cant` files participate in the normal
3-tier discovery. See `CANTZ-PACKAGE-STANDARD.md` for the packaging
specification.

### 6.2 Tier Pinning

A future CANT grammar extension MAY allow files to declare
`tier-pin: project` to prevent global/user overrides. This is not part
of the current specification.

## 7. Compliance Requirements

| ID | Requirement | Level |
|----|-------------|-------|
| HIER-001 | The bridge MUST scan all three tier directories | MUST |
| HIER-002 | Project-tier files MUST override user-tier files with the same basename | MUST |
| HIER-003 | User-tier files MUST override global-tier files with the same basename | MUST |
| HIER-004 | Missing tier directories MUST NOT cause errors | MUST |
| HIER-005 | Scan failures MUST NOT crash Pi | MUST |
| HIER-006 | The discovery algorithm MUST be deterministic | MUST |
| HIER-007 | Diagnostic output SHOULD report per-tier file counts | SHOULD |

## 8. References

| Document | Path |
|----------|------|
| CLEO-ULTRAPLAN.md Section 2.4 | `docs/plans/CLEO-ULTRAPLAN.md` |
| XDG path resolution | `packages/cleo-os/src/xdg.ts` |
| CANT bridge | `packages/cleo-os/extensions/cleo-cant-bridge.ts` |
| CANTZ Package Standard | `docs/specs/CANTZ-PACKAGE-STANDARD.md` |
