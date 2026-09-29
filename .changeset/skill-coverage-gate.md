---
id: skill-coverage-gate
tasks: [T12124]
kind: feat
summary: Gate 32 enforces the skill drift check AGENTS.md used to only describe; gate 33 ratchets ct-cleo's size
---

AGENTS.md described a "Skill Drift Check" backed by
`packages/skills/internal/skill-coverage.yml`. No script read that file, and
its one entry named a skill that does not exist. That file is deleted, and the
check is now real.

- **Coverage lives with the skill.** Each skill declares the code it
  documents in `metadata.covers` (repo globs). All six core skills, every LOOM
  stage skill and ct-codebase-mapper declare it.
- **Gate 32, `scripts/lint-skill-coverage.mjs`, checks two things.**
  - In `cleo check arch` and on push, every core and LOOM-stage skill
    declares covers, and every glob matches a tracked file.
  - In PR mode (`--base`, run by CI against the PR base), a changed covered
    path requires a change to that skill, and a changed skill requires a
    `metadata.version` bump. On-demand skills accept a
    `Skill-Drift-Reviewed: <skill>: <reason>` commit trailer instead; core
    skills never do (D11157).
- **Gate 33, `scripts/check-ct-cleo-thin.mjs`, is now wired and ratcheted.**
  ct-cleo may not grow past its baseline (364 non-blank lines, 17 extra
  sections) or gain a new `## ` section. `--strict` keeps the 50-line T9148
  target.

The frontmatter parser reads nested `metadata` lists. Every skill that gained
`covers` has its version bumped, as gate 32 itself requires.
