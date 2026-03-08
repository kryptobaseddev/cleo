# CLEO Skill Validator v2 — Validation Rules

Complete rule reference for the 5-tier validation system.

## Overview

The CLEO Skill Validator v2 enforces compliance across five tiers of increasing depth:

1. **Structure** — Does the skill have the required files and valid frontmatter?
2. **Frontmatter Quality** — Are all frontmatter fields correct, well-formed, and non-contradictory?
3. **Body Quality** — Is the body content complete, concise, and free of placeholders?
4. **CLEO Integration** — Does the skill align with manifest.json and dispatch-config.json?
5. **Provider Compatibility** — Is the skill referenced in the provider-skills-map?

Tiers 1-3 run on every validation. Tiers 4-5 are opt-in via CLI flags.

## Allowed vs Forbidden Fields

### V2_STANDARD (allowed in SKILL.md frontmatter)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Skill identifier, hyphen-case, max 64 chars |
| `description` | string | Yes | What the skill does and when to use it, max 1024 chars |
| `argument-hint` | string | No | Shown in autocomplete, max 100 chars |
| `disable-model-invocation` | boolean | No | Prevent model from auto-invoking |
| `user-invocable` | boolean | No | Whether skill appears as slash command |
| `allowed-tools` | string or list | No | Tools pre-approved without per-use prompts |
| `model` | string | No | Override model for this skill |
| `context` | string | No | Must be "fork" if present |
| `agent` | string | No | Subagent type (Explore, Plan, etc.) |
| `hooks` | dict | No | Skill-scoped lifecycle hooks |
| `license` | string | No | License identifier |

### CLEO_ONLY (forbidden in SKILL.md, belongs in manifest.json)

| Field | Destination |
|-------|-------------|
| `version` | manifest.json |
| `tier` | manifest.json |
| `core` | manifest.json |
| `category` | manifest.json |
| `protocol` | manifest.json |
| `dependencies` | manifest.json |
| `sharedResources` | manifest.json |
| `compatibility` | manifest.json |
| `token_budget` | manifest.json |
| `capabilities` | manifest.json |
| `constraints` | manifest.json |
| `metadata` | manifest.json |
| `tags` | manifest.json |
| `triggers` | manifest.json |
| `mvi_scope` | manifest.json |
| `requires_tiers` | manifest.json |

## Tier 1 — Structure Rules

| Rule ID | Check | Severity | Fix |
|---------|-------|----------|-----|
| T1-001 | SKILL.md exists in skill directory | ERROR | Create SKILL.md with frontmatter and body |
| T1-002 | Content starts with `---` (frontmatter present) | ERROR | Add YAML frontmatter block at top of file |
| T1-003 | Frontmatter block can be extracted (closing `---` found) | ERROR | Add closing `---` after frontmatter |
| T1-004 | Frontmatter is valid YAML | ERROR | Fix YAML syntax errors |
| T1-005 | Frontmatter parses to a dictionary | ERROR | Frontmatter must be key: value pairs, not a scalar or list |
| T1-006 | No CLEO-only fields present in frontmatter | ERROR (per field) | Move the field to manifest-entry.json or manifest.json |

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

## Tier 3 — Body Quality Rules

| Rule ID | Check | Severity | Fix |
|---------|-------|----------|-----|
| T3-001 | Body is present (non-empty content after frontmatter) | WARN | Add content below the closing `---` |
| T3-002 | Body is under 600 lines | ERROR | Split into sub-documents or trim |
| T3-003 | Body is under 400 lines | WARN | Consider trimming for token efficiency |
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
| T1-006 | 1 | No CLEO-only fields | ERROR |
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
| T3-001 | 3 | Body present | WARN |
| T3-002 | 3 | Body under 600 lines | ERROR |
| T3-003 | 3 | Body under 400 lines | WARN |
| T3-004 | 3 | No placeholder text | WARN |
| T3-005 | 3 | Section headers in long bodies | WARN |
| T3-006 | 3 | File references exist | WARN |
| T4-001 | 4 | Skill in manifest | WARN |
| T4-002 | 4 | Manifest required fields | WARN |
| T4-003 | 4 | Skill in dispatch config | WARN |
| T5-001 | 5 | Skill in provider map | WARN |
