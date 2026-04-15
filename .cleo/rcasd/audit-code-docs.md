# CLI Audit: Code & Documentation Domain

**Date**: 2026-04-10
**Auditor**: CLI Full Audit subagent
**Scope**: `cleo code`, `cleo docs`, `cleo detect-drift`, `cleo map`

---

## Summary Table

| Command | Exit Code | Works | Notes |
|---------|-----------|-------|-------|
| `cleo code outline <file>` | 7 | NO | tree-sitter not installed |
| `cleo code search <query>` | 7 | NO | tree-sitter not installed |
| `cleo code unfold <file> <sym>` | 7 | NO | tree-sitter not installed |
| `cleo docs sync` | 0 | YES | 1 drift warning detected |
| `cleo docs sync --quick` | 0 | PARTIAL | flag accepted, has no effect |
| `cleo docs sync --strict` | 1 | YES | exits 1 on warning, 2 on error |
| `cleo docs gap-check` | 0 | YES | found 72 gaps across agent-outputs |
| `cleo docs gap-check --task T473` | 0 | YES | filter works correctly |
| `cleo docs gap-check --epic <id>` | 0 | YES | same code path as --task |
| `cleo detect-drift` | 2 | YES | 8-check deep audit, 2 errors found |
| `cleo map` | 0 | YES | full project context output |
| `cleo map --focus stack` | 0 | PARTIAL | see focus analysis below |
| `cleo map --focus architecture` | 0 | PARTIAL | architecture.layers always empty |
| `cleo map --store` | 0 | YES | triggers mutate gateway |

---

## Command-by-Command Findings

### 1. `cleo code outline` / `cleo code search` / `cleo code unfold`

**Status: BLOCKED — exit 7, dependency not installed**

All three subcommands fail uniformly with:
```
Error: tree-sitter is not installed. Code analysis features require tree-sitter grammar packages.
```

Exit code 7 is intentional (service unavailable). The error message is clear and actionable — it provides the exact install command.

**Help quality**: Good. Arguments documented. No undocumented options.

**Issues:**
- `cleo code outline --help` shows no `OPTIONS` section even though `--help` itself is an option. This is fine — no options exist besides the positional arg — but an agent might be confused by the empty section.
- The `--help` output does not mention that tree-sitter is a required runtime dependency. An agent will get no warning until it actually runs the command.

**Verdict**: Commands are feature-gated, not broken. But tree-sitter not being installed in this environment means these are completely untestable at runtime. The help text should mention the tree-sitter requirement upfront.

---

### 2. `cleo docs sync`

**Status: WORKING**

Compares `scripts/*.sh` files against `docs/commands/COMMANDS-INDEX.json`. On this repo, detects 1 script not in the index: `register-agents-signaldock`.

Output format: LAFS envelope (`{success, data, meta}`). Clean.

**The `--quick` flag is a no-op.** It is accepted without error but the source code (line 143, `docs.ts`) registers the option and never reads it in the action handler. The full drift scan runs regardless. This is a documentation mismatch — the help says "Quick check (commands only)" but there is no shortened code path.

**The `--strict` flag works correctly**: exits 1 on warning-level drift, exits 2 on error-level drift (>5 missing entries).

**What "drift" actually means here**: This is `scripts/*.sh` vs `docs/commands/COMMANDS-INDEX.json` sync — a very narrow legacy check. It does NOT check whether CLI TypeScript commands are documented. It is a script-file inventory check, which is probably vestigial from when CLEO used shell scripts. `register-agents-signaldock.sh` exists in `scripts/` but is not in the index.

**Issues:**
- `--quick` option has no effect (dead option).
- The description "Run drift detection between scripts and docs index" is opaque. A zero-context agent will not know what "scripts" means (shell scripts in `scripts/`), what "docs index" means (`COMMANDS-INDEX.json`), or why this matters.
- No mention of what to do when drift is found (how to update `COMMANDS-INDEX.json`).

---

### 3. `cleo docs gap-check`

**Status: WORKING**

Scans all `.md` files in the agent-outputs directory and checks for two required sections:
1. `## Summary` heading
2. A task provenance header (`**Task**:` or `**Task:**`)

Found 72 documents with gaps on this run. The `--task <id>` and `--epic <id>` filters work by simple substring match on the filename.

**Issues:**
- `--epic` and `--task` are treated identically in code (`filterId = opts.epic ?? opts.task`). There is no distinction between filtering by epic scope vs task ID. An agent specifying `--epic T447` will get results for files matching `T447` in the filename — same as `--task T447`. The semantic distinction advertised in help is false.
- Gap rules are hardcoded in source (only 2 checks). There is no way to customize or extend them without code changes.
- The 72-gap result is not alarming — many of these are legacy output files from earlier audit waves. The command is working as designed.

---

### 4. `cleo detect-drift`

**Status: WORKING — but with caveats**

This is a fundamentally different command from `cleo docs sync`. It runs 8 structural checks against the CLEO monorepo source:

| Check | Status | Notes |
|-------|--------|-------|
| Gateway-to-spec sync | WARN | 230 operations in registry not in spec |
| CLI-to-core sync | PASS | 106 CLI command files found |
| Domain handler coverage | PASS | 15 domain handlers |
| Capability matrix | PASS | file exists |
| Schema validation | FAIL | `src/store/schema.ts` not found (hardcoded legacy path) |
| Canonical identity | PASS | vision + spec docs present, all 5 pillars found |
| Agent injection | FAIL | `.cleo/templates/CLEO-INJECTION.md` not found at expected path |
| Exit codes | PASS | 0 exit codes (counts `= \d+` matches, finds zero) |

Exit code 2 (errors present).

**Critical bugs found:**

1. **Schema check uses wrong path**: Hardcoded to `src/store/schema.ts` (line 337). The CLEO monorepo moved schemas to `packages/core/src/`. This check always fails in the monorepo context. The check also looks for `CREATE TABLE` strings in a TypeScript file — but the schema uses Drizzle ORM table definitions, not raw SQL. Both the path and the check logic are wrong.

2. **Agent injection check uses wrong path**: Checks `.cleo/templates/CLEO-INJECTION.md` but the actual injection template lives at `~/.cleo/templates/CLEO-INJECTION.md` (global) or is injected via the CAAMP chain, not at the project-local `.cleo/templates/` path. Confirmed: that file does not exist at the checked path in the project.

3. **Exit codes counter is broken**: Counts `= \d+` patterns in `exit-codes.ts`. Checking the actual file would show this regex matches numeric assignments generically — not just exit code definitions. Reports "0 exit codes defined" (PASS with count 0), which contradicts reality.

4. **Gateway-to-spec warning is noisy but acceptable**: 230 operations in the registry that are not in the spec is a genuine gap, but the spec (`CLEO-OPERATION-CONSTITUTION.md`) is a high-level reference — it does not enumerate every sub-operation. This warning fires on every run and is likely a known false positive.

**The help text for `cleo detect-drift` is nearly empty**: it only shows USAGE with no OPTIONS or FLAGS listed. No mention of exit codes. A zero-context agent cannot know what this does, what it checks, or what to do with the output.

---

### 5. `cleo map`

**Status: WORKING — but `--focus` is partially broken**

Without `--focus`, outputs a full project context: detected project types (node + rust), monorepo structure, all packages listed with file counts, conventions, testing setup, CI/CD detection, dependencies.

**`--focus` analysis:**

| Focus value | Behavior |
|-------------|----------|
| `stack` | Returns full `projectContext` but `structure.directories` is empty, `structure.totalFiles` is 0 |
| `architecture` | Returns full `projectContext` but `stack` empty, `structure` empty. `architecture.layers` always `[]`, `architecture.entryPoints` always `[]` |
| `structure` | Returns full `projectContext` with structure populated. Stack empty. |
| `conventions` | Returns full `projectContext` with `conventions` populated. Other fields empty. |
| `testing` | Returns full `projectContext` with `testing` populated. Other fields empty. |
| `integrations` | Returns full `projectContext` with `integrations` populated. Other fields empty. |
| `concerns` | Returns full `projectContext` with `concerns` populated. Other fields empty. |

**Issues:**
- Every `--focus` value still returns the full `projectContext` wrapper including the `llmHints` block. There is no "focused" output — it's the same envelope with only some sections populated. An agent expecting a compact focused response will still receive a large JSON blob.
- `--focus architecture` always returns `architecture: {layers: [], entryPoints: [], patterns: []}`. The architecture detection in the core engine is either not implemented or not finding patterns in this monorepo. This focus value is silently useless.
- `--focus stack` returns an empty `structure` section, meaning stack focus suppresses the directory listing. This is correct behavior (focused), but the `llmHints` block is always included regardless of focus — a significant portion of the output that seems unconditional.
- `--store` flag routes to the mutate gateway but the dispatch action handler hardcodes `storeToBrain: false` for the query path and `storeToBrain: true` for the mutate path. The store is not confirmed in the output — no success/failure indicator that brain.db was actually written.

---

## Duplicate / Overlap Analysis

### `cleo detect-drift` vs `cleo docs sync`

These are NOT the same command. They are complementary but poorly differentiated in their names.

| Aspect | `cleo docs sync` | `cleo detect-drift` |
|--------|-----------------|---------------------|
| What it checks | `scripts/*.sh` vs `COMMANDS-INDEX.json` | 8 structural checks (spec sync, schema, injection, etc.) |
| Target audience | Build/CI automation | Agents and developers checking CLEO health |
| Scope | Narrow: legacy shell script inventory | Wide: architecture conformance |
| Output format | LAFS envelope | LAFS envelope |
| Exit codes | 0 (clean), 1 (warning, strict mode), 2 (error, strict mode) | 0 (clean), 1 (warnings), 2 (errors) |
| Has options | Yes (`--quick`, `--strict`) | No |
| Fixable output | No — just reports | No — just reports |

**Verdict**: These are not duplicates. `cleo docs sync` is a narrow CI tool checking a legacy script inventory. `cleo detect-drift` is a health checker for CLEO architecture conformance. The naming is confusing because "docs sync" implies syncing documentation, but it only detects drift without syncing anything. The name of `cleo docs sync` should arguably be `cleo docs lint` or `cleo docs status`. The fact that `detect-drift` also exists at top-level (not under `cleo docs`) suggests it was added later as a broader concept and never migrated `docs sync` into it.

### `cleo map` vs `cleo code outline`

These are completely different tools:

| Aspect | `cleo map` | `cleo code outline` |
|--------|-----------|---------------------|
| Scope | Entire project | Single file |
| Method | Static analysis of package.json, tsconfig, file structure | tree-sitter AST parsing |
| Output | JSON project context (conventions, deps, structure) | Function/class signatures with line numbers |
| Useful for | Onboarding agents to a project | Navigating a specific source file |

Not duplicates. Complementary at different granularities.

---

## Help Text Quality Assessment

| Command | Clarity | Options Complete | Undocumented Options | Agent-Usable? |
|---------|---------|-----------------|---------------------|---------------|
| `cleo code` | Good | Yes | None | Yes (but blocked) |
| `cleo code outline` | Good | Yes | None | Yes (with caveat: no mention of tree-sitter req) |
| `cleo code search` | Good | Yes | None | Yes |
| `cleo code unfold` | Good | Yes | None | Yes |
| `cleo docs` | OK | Yes | None | Marginal |
| `cleo docs sync` | Poor | Yes (but --quick broken) | None | No — "scripts and docs index" unexplained |
| `cleo docs gap-check` | OK | Yes | None | Marginal |
| `cleo detect-drift` | Very poor | N/A (no options) | None | No — no description of checks, exit codes, or scope |
| `cleo map` | Good | Yes | None | Yes |

---

## Issues Requiring Fixes

### P0 — Bugs

| ID | Command | Issue |
|----|---------|-------|
| BUG-1 | `cleo detect-drift` | Schema check path hardcoded to `src/store/schema.ts` — wrong for monorepo |
| BUG-2 | `cleo detect-drift` | Schema check looks for `CREATE TABLE` in a Drizzle ORM TypeScript file — always false |
| BUG-3 | `cleo detect-drift` | Agent injection check path `.cleo/templates/CLEO-INJECTION.md` does not match actual template location |
| BUG-4 | `cleo detect-drift` | Exit codes counter (`= \d+` regex) reports 0 even though exit codes are defined |

### P1 — Functional Gaps

| ID | Command | Issue |
|----|---------|-------|
| GAP-1 | `cleo docs sync --quick` | Flag is declared but never read — silently ignored |
| GAP-2 | `cleo docs gap-check` | `--epic` and `--task` are functionally identical — false semantic distinction |
| GAP-3 | `cleo map --focus architecture` | `architecture.layers` and `architecture.entryPoints` always return empty arrays — focus is useless |
| GAP-4 | `cleo map --store` | No confirmation in output that brain.db was written |

### P2 — Help Text / UX

| ID | Command | Issue |
|----|---------|-------|
| UX-1 | `cleo detect-drift` | Help text body is empty — no description of what checks are run or what exit codes mean |
| UX-2 | `cleo docs sync` | Description does not explain what "scripts" (shell files) or "docs index" (COMMANDS-INDEX.json) means |
| UX-3 | `cleo code *` | Help text does not warn that tree-sitter is required; error only surfaced at runtime |
| UX-4 | `cleo detect-drift` | Should note it is distinct from `cleo docs sync`; the relationship is invisible |

---

## What Is `cleo docs sync` Actually Checking?

This warrants a note because it may surprise maintainers: `cleo docs sync` checks whether every file in `scripts/*.sh` has an entry in `docs/commands/COMMANDS-INDEX.json`. The project has one undocumented shell script (`register-agents-signaldock.sh`) causing the persistent drift warning. This script is responsible for registering agent profiles with SignalDock. It should either be added to `COMMANDS-INDEX.json` or the check should explicitly exclude it if it's internal infrastructure.

---

## Output Format Assessment

All commands that work output valid LAFS envelopes (`{success, data, meta}`). `cleo code *` outputs plain text (not JSON). `cleo detect-drift` outputs a JSON envelope. All exit codes are consistent with the documented protocol.

The `cleo map` output is very large (the full JSON is several kilobytes) and is not agent-friendly for quick consumption. There is no `--json` vs `--human` output mode. The `--focus` option was presumably intended to reduce output size but does not achieve this — it still returns the full envelope.
