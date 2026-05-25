# CLEO Skill Validator — Validation Rules

Complete rule reference for the 5-tier validation system.

## Overview

The CLEO Skill Validator enforces compliance across five tiers of increasing depth:

1. **Structure** — Does the skill have the required files and valid frontmatter?
2. **Frontmatter Quality** — Are all frontmatter fields correct, well-formed, and non-contradictory?
3. **Body Quality** — Is the body content complete, concise, and free of placeholders?
4. **CLEO Integration** — Does the skill align with manifest.json and dispatch-config.json?
5. **Provider Compatibility** — Is the skill referenced in the provider-skills-map?

Tiers 1-3 run on every validation. Tiers 4-5 are opt-in via CLI flags.

## Allowed vs Forbidden Fields

### Allowed in SKILL.md frontmatter

Two groups: **agentskills.io spec fields** (the open standard) and
**Claude Code harness extensions** (honored by the runtime but not part of
the open spec).

#### From the agentskills.io spec

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Skill identifier, hyphen-case, max 64 chars, must match parent directory name |
| `description` | string | Yes | What the skill does and when to use it, max 1024 chars |
| `license` | string | No | License name or reference to a bundled LICENSE file |
| `compatibility` | string | No | Environment requirements (max 500 chars). Only include when the skill needs specific runtime, packages, or network access |
| `metadata` | dict | No | Map from string keys to string values for additional metadata not defined by the spec |
| `allowed-tools` | string or list | No | Tools pre-approved without per-use prompts (experimental in spec) |

##### Recommended `metadata` sub-keys (string values per spec)

The agentskills.io spec defines `metadata` as "a map from string keys to string
values". Use it for authorship and version info that the spec doesn't define
fields for:

| Sub-key | Convention | Example |
|---------|-----------|---------|
| `author` | Author name or org | `author: example-org` |
| `version` | Skill version (always quoted as string) | `version: "1.0.0"` |
| `last_updated` | ISO timestamp `YYYY-MM-DD HH:MM:SS` (always quoted) | `last_updated: "2026-05-21 14:00:18"` |
| `related` | Related skills | `related: skill-creator, skill-evaluator` |
| `spec` | Spec the skill claims to follow | `spec: https://agentskills.io/specification.md` |

The validator emits a WARN when `metadata` is present without any of
`author`, `version`, or `last_updated`. Numeric values like `version: 1.0` are
flagged — the spec requires string values, so quote them: `version: "1.0"`.

#### Claude Code harness extensions

These are honored by the Claude Code runtime but are NOT part of the
agentskills.io open spec. Skills targeting other agent runtimes should
either omit them or document the dependency in `compatibility`.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `argument-hint` | string | No | Shown in autocomplete, max 100 chars |
| `disable-model-invocation` | boolean | No | Prevent model from auto-invoking |
| `user-invocable` | boolean | No | Whether skill appears as slash command |
| `model` | string | No | Override model for this skill |
| `context` | string | No | Must be "fork" if present |
| `agent` | string | No | Subagent type (Explore, Plan, etc.) |
| `hooks` | dict | No | Skill-scoped lifecycle hooks |

#### CLEO overlay extensions

These are intentionally allowlisted CLEO runtime overlays that still live in
`SKILL.md` because repo/runtime gates consume them directly. Do not add new
provider- or runtime-specific top-level fields without adding them to the
validator allowlist.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `loomStage` | string | No | RCASD-IVTR+C stage binding used by LOOM protocol skills |

### CLEO-only fields (forbidden in SKILL.md; belong in `manifest-entry.json`)

These fields hold CLEO-specific structured data that the Claude runtime
doesn't read. They live in `manifest-entry.json` so they don't bloat
the SKILL.md frontmatter or violate the agentskills.io spec.

| Field | Destination |
|-------|-------------|
| `version` | manifest-entry.json (or `metadata.version` in SKILL.md) |
| `tier` | manifest-entry.json |
| `core` | manifest-entry.json |
| `category` | manifest-entry.json |
| `protocol` | manifest-entry.json |
| `dependencies` | manifest-entry.json |
| `sharedResources` | manifest-entry.json |
| `token_budget` | manifest-entry.json |
| `capabilities` | manifest-entry.json |
| `constraints` | manifest-entry.json |
| `tags` | manifest-entry.json |
| `triggers` | manifest-entry.json |
| `mvi_scope` | manifest-entry.json |
| `requires_tiers` | manifest-entry.json |

## Tier 1 — Structure Rules

| Rule ID | Check | Severity | Fix |
|---------|-------|----------|-----|
| T1-001 | SKILL.md exists in skill directory | ERROR | Create SKILL.md with frontmatter and body |
| T1-002 | Content starts with `---` (frontmatter present) | ERROR | Add YAML frontmatter block at top of file |
| T1-003 | Frontmatter block can be extracted (closing `---` found) | ERROR | Add closing `---` after frontmatter |
| T1-004 | Frontmatter is valid YAML | ERROR | Fix YAML syntax errors |
| T1-005 | Frontmatter parses to a dictionary | ERROR | Frontmatter must be key: value pairs, not a scalar or list |
| T1-006 | Frontmatter is JSON-serializable after YAML parsing | ERROR | Quote date/timestamp-like values and use string keys |
| T1-007 | All top-level fields are in the explicit spec/provider allowlist | ERROR (per field) | Move custom data under `metadata` or add a deliberate allowlist entry |
| T1-008 | No CLEO-only fields present in frontmatter | ERROR (per field) | Move the field to manifest-entry.json or manifest.json |

## Tier 2 — Frontmatter Quality Rules

| Rule ID | Check | Severity | Fix |
|---------|-------|----------|-----|
| T2-001 | `name` field is present | ERROR | Add `name: my-skill-name` to frontmatter |
| T2-002 | `name` is a string | ERROR | Ensure name is a plain string value |
| T2-003 | `name` is valid hyphen-case (lowercase alphanumeric + hyphens) | ERROR | Use only `a-z`, `0-9`, and `-` |
| T2-004 | `name` has no consecutive hyphens | ERROR | Replace `--` with `-` |
| T2-005 | `name` does not start or end with hyphen | ERROR | Remove leading/trailing hyphens |
| T2-006 | `name` is 64 characters or fewer | ERROR | Shorten the name |
| T2-007 | `name` matches skill directory name | WARN | Rename to match or update frontmatter |
| T2-008 | `description` field is present | ERROR | Add description to frontmatter |
| T2-009 | `description` is a string | ERROR | Ensure description is a plain string |
| T2-010 | `description` contains no `<` or `>` characters | ERROR | Remove angle brackets |
| T2-011 | `description` is 1024 characters or fewer | ERROR | Shorten the description |
| T2-012 | `description` is at least 50 characters | WARN | Expand description with more detail |
| T2-013 | `description` contains trigger indicator (when/use when/use for) | WARN | Add usage context (e.g., "Use when auditing...") |
| T2-014 | `description` does not start with "I " | WARN | Rewrite in third person |
| T2-015 | `description` does not use YAML multiline (`>` or `\|`) | WARN | Use quoted string instead |
| T2-016 | `context` is "fork" if present | ERROR | Set to "fork" or remove |
| T2-017 | `context: fork` has accompanying `agent` field | WARN | Add `agent` field specifying subagent type |
| T2-018 | `disable-model-invocation` is boolean if present | ERROR | Set to `true` or `false` |
| T2-019 | `user-invocable` is boolean if present | ERROR | Set to `true` or `false` |
| T2-020 | No contradictory flags (DMI=true + UI=false) | ERROR | A skill must be invocable somehow; fix one flag |
| T2-021 | `argument-hint` is a string if present | ERROR | Use a plain string value |
| T2-022 | `argument-hint` is 100 characters or fewer | ERROR | Shorten the hint |
| T2-023 | `allowed-tools` is string or list if present | ERROR | Use `Tool1, Tool2` or `[Tool1, Tool2]` |
| T2-024 | `model` is a string if present | ERROR | Use model ID string |
| T2-025 | `agent` is a string if present | ERROR | Use agent type string |
| T2-026 | `hooks` is a dict if present | ERROR | Use key: value structure |
| T2-027 | `compatibility` is a string if present | ERROR | Use a plain string value |
| T2-028 | `compatibility` is 500 characters or fewer (agentskills.io spec) | ERROR | Shorten or move detail to `references/` |
| T2-029 | `metadata` is a dict if present (agentskills.io spec) | ERROR | Use key: value structure |
| T2-030 | `metadata` keys are all strings (agentskills.io spec) | ERROR | Quote non-string keys |
| T2-031 | `metadata` values are all strings (agentskills.io spec) | WARN | Quote numeric versions: `version: "1.0"` |
| T2-032 | `metadata` includes at least one of: author, version, last_updated | WARN | Add recommended traceability keys |
| T2-033 | `metadata.last_updated` (and `metadata.last_reviewed` if present) match `YYYY-MM-DD HH:MM:SS` | WARN | Use precise timestamp format, e.g. `"2026-05-21 14:00:18"` |
| T2-034 | Date-like, timestamp, version, and numeric metadata scalars are quoted | ERROR | Quote metadata values so Python/JS YAML parsers and JSON serializers agree |

## Tier 3 — Body Quality Rules

| Rule ID | Check | Severity | Fix |
|---------|-------|----------|-----|
| T3-001 | Body is present (non-empty content after frontmatter) | WARN | Add content below the closing `---` |
| T3-002 | Body is under 600 lines (hard cap) | ERROR | Split into sub-documents or trim |
| T3-003 | Body is under 500 lines (agentskills.io spec recommendation) | WARN | Move detail to `references/` for progressive disclosure |
| T3-004 | No placeholder text (`[Required:`, `TODO`, `REPLACE`, `[Add content`, `FIXME`, `TBD`) | WARN (per match) | Replace placeholders with real content |
| T3-005 | Bodies over 200 lines have `## ` section headers | WARN | Add section structure for readability |
| T3-006 | File references (`references/`, `scripts/`) point to existing files | WARN | Create the referenced file or fix the path |

## Tier 4 — CLEO Integration Rules

| Rule ID | Check | Severity | Fix |
|---------|-------|----------|-----|
| T4-001 | Skill found in manifest.json `skills[]` array | WARN | Add entry to manifest.json with matching name |
| T4-002 | Manifest entry has all required fields (name, version, description, path, status, tier, token_budget, capabilities, constraints) | WARN (per field) | Add missing field to manifest entry |
| T4-003 | Skill found in dispatch-config.json `skill_overrides` (if --dispatch-config provided) | WARN | Add override entry or omit flag if not needed |

## Tier 5 — Provider Compatibility Rules

| Rule ID | Check | Severity | Fix |
|---------|-------|----------|-----|
| T5-001 | Skill referenced in provider-skills-map.json (if --provider-map provided) | WARN | Add skill to relevant provider entries |

## Complete Rule Table

| Rule ID | Tier | Check | Severity |
|---------|------|-------|----------|
| T1-001 | 1 | SKILL.md exists | ERROR |
| T1-002 | 1 | Frontmatter present (starts with `---`) | ERROR |
| T1-003 | 1 | Frontmatter extractable (closing `---`) | ERROR |
| T1-004 | 1 | Frontmatter valid YAML | ERROR |
| T1-005 | 1 | Frontmatter is a dict | ERROR |
| T1-006 | 1 | Frontmatter JSON-serializable after YAML parsing | ERROR |
| T1-007 | 1 | Top-level fields in explicit spec/provider allowlist | ERROR |
| T1-008 | 1 | No CLEO-only fields | ERROR |
| T2-001 | 2 | `name` present | ERROR |
| T2-002 | 2 | `name` is string | ERROR |
| T2-003 | 2 | `name` hyphen-case | ERROR |
| T2-004 | 2 | `name` no consecutive hyphens | ERROR |
| T2-005 | 2 | `name` no leading/trailing hyphens | ERROR |
| T2-006 | 2 | `name` max 64 chars | ERROR |
| T2-007 | 2 | `name` matches directory | WARN |
| T2-008 | 2 | `description` present | ERROR |
| T2-009 | 2 | `description` is string | ERROR |
| T2-010 | 2 | `description` no angle brackets | ERROR |
| T2-011 | 2 | `description` max 1024 chars | ERROR |
| T2-012 | 2 | `description` min 50 chars | WARN |
| T2-013 | 2 | `description` has trigger indicator | WARN |
| T2-014 | 2 | `description` not first person | WARN |
| T2-015 | 2 | `description` no YAML multiline | WARN |
| T2-016 | 2 | `context` is "fork" | ERROR |
| T2-017 | 2 | `context: fork` has `agent` | WARN |
| T2-018 | 2 | `disable-model-invocation` is bool | ERROR |
| T2-019 | 2 | `user-invocable` is bool | ERROR |
| T2-020 | 2 | No contradictory flags | ERROR |
| T2-021 | 2 | `argument-hint` is string | ERROR |
| T2-022 | 2 | `argument-hint` max 100 chars | ERROR |
| T2-023 | 2 | `allowed-tools` is string/list | ERROR |
| T2-024 | 2 | `model` is string | ERROR |
| T2-025 | 2 | `agent` is string | ERROR |
| T2-026 | 2 | `hooks` is dict | ERROR |
| T2-027 | 2 | `compatibility` is string | ERROR |
| T2-028 | 2 | `compatibility` max 500 chars | ERROR |
| T2-029 | 2 | `metadata` is dict | ERROR |
| T2-030 | 2 | `metadata` keys are strings | ERROR |
| T2-031 | 2 | `metadata` values are strings | WARN |
| T2-032 | 2 | `metadata` has author/version/last_updated | WARN |
| T2-033 | 2 | `metadata` timestamp keys match `YYYY-MM-DD HH:MM:SS` | WARN |
| T2-034 | 2 | Risky metadata scalars are quoted | ERROR |
| T3-001 | 3 | Body present | WARN |
| T3-002 | 3 | Body under 600 lines | ERROR |
| T3-003 | 3 | Body under 500 lines (spec) | WARN |
| T3-004 | 3 | No placeholder text | WARN |
| T3-005 | 3 | Section headers in long bodies | WARN |
| T3-006 | 3 | File references exist | WARN |
| T4-001 | 4 | Skill in manifest | WARN |
| T4-002 | 4 | Manifest required fields | WARN |
| T4-003 | 4 | Skill in dispatch config | WARN |
| T5-001 | 5 | Skill in provider map | WARN |
