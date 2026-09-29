---
id: skill-command-gate
tasks: [T12649]
kind: fix
summary: Gate 31 checks every cleo command the skills teach; the core skills, LOOM skills and release skill no longer teach dead commands
---

The skills are what an agent reads when it needs the detail, and on
2026-09-28 they carried about 100 invocations the CLI rejects or silently
ignores. Gate 31, `scripts/lint-skill-commands.mjs`, applies gate 14's rules
(verb, sub-verb, declared flags, required flags, `--field` pointers) to every
markdown file under `packages/skills/skills/`. Core-tier skills are
zero-tolerance. Other skills ratchet against
`scripts/.lint-skill-commands-baseline.json`, which holds 10 entries, all in
skills scheduled for merge or retirement. It runs in `cleo check arch` and the
Arch Boundary Check workflow. `loadRegistry` and a new `makeSourceForVerb` are
exported from `lint-injection-commands.mjs` so both gates share one registry.

Fixes to the skills themselves:

- **ct-orchestrator** (31 findings): `orchestrate ready/start/next/context
  --epic` → positional epic; `--template` → `--protocol`; `show --brief` and
  `show --format json` removed; `session gc --include-active/--dry-run` →
  `--max-age`; `session suspend --note` → `<sessionId> --reason`;
  `research inject` → `orchestrate spawn`; `release create/ship` →
  `plan`/`open`/tag/`reconcile`.
- **ct-cleo** (13 findings): `cleo orchestrator …` → `cleo orchestrate …`,
  `skill list/show` → `skills list/info`, decisions through
  `memory decision-store`, `release create/ship` removed, `workgraph`
  positional files.
- **ct-lead** (9 findings): `lead rollup` → `orchestrate roll-up`,
  `conduit await` → `conduit listen --since`, `orchestrate spawn-batch` →
  `orchestrate fanout`, `conduit subscribe --topic`. It also states that no
  runtime check enforces the wave-width cap.
- **ct-task-executor, ct-documentor:** remaining dead flags and verbs fixed.
  The deliberate `--titel` example is marked as a negative example.
- **LOOM skills:** every `cleo check protocol --protocolType X --taskId …`
  example now uses the positional type and kebab-case flags; the CLI rejected
  the camelCase form with `E_UNKNOWN_FLAG`.
- **All skills:** the retired `{{MANIFEST_PATH}}` return contract is replaced
  by `cleo manifest append` (ADR-027).
- **ct-release-orchestrator:** it no longer says the tag is created by
  `auto-tag-on-release-merge.yml`, which was retired in T10434 / ADR-087. The
  tag is pushed explicitly after the release PR merges.
- **ct-epic-architect, `_shared`, ct-grade:** dead commands fixed; retired
  `research` verbs documented as retired.

Frontmatter:

- `loomStage` moved under `metadata:`. Gate 29 fails when it names a stage
  that is not in `STAGE_SKILL_MAP` or a `.cant` protocol id, or when it is
  bound to a different skill.
- The parser reads CRLF files and blank lines inside `metadata:`, and
  `.gitattributes` pins `*.md` to LF.

Every changed skill has its patch version bumped.
