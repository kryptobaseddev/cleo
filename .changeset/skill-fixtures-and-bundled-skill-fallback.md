---
id: skill-fixtures-and-bundled-skill-fallback
tasks: [T12645, T12646]
kind: fix
summary: Tests can no longer write into the real CLEO data dir, `cleo doctor skill-fixtures` quarantines the caamp fixtures already there, and spawn prompts and stage guidance fall back to the bundled skill when it is not installed
---

On macOS on 2026-09-28, 53 of the 70 entries in
`~/Library/Application Support/cleo/skills` were caamp unit-test fixtures:
50 `<prefix>-<uuid>` dirs plus `real-skill`, `skill-alpha` and `skill-beta`.
They came from `skills-installer.test.ts` and
`skills-installer-recordrow.test.ts` at a time when `resolveSkillsRoot()`
returned `homedir()/.cleo/skills` and `vitest.setup.ts` did not pin `HOME`.
The writes went through the `~/.cleo` alias into the real data dir.

- `vitest.setup.ts` records the real data dir (and `~/.cleo`) before it
  sandboxes the environment. It then refuses every fs write under that dir
  with `E_TEST_REAL_DATA_WRITE`, and fails the test in `afterEach` even when
  the code under test swallowed the error. `<dataDir>/worktrees` is exempt.
- New `cleo doctor skill-fixtures [--repair] [--dry-run]`. An entry counts as
  a fixture only when its name is `<slug>-<uuid>` or one of the three fixture
  names and its content is exactly what those tests write. Any other entry
  with a matching name is reported as `unclassified` and left alone. Manifest
  skills, bundled names and hidden entries are never candidates. `--repair`
  moves fixtures into `<cleoHome>/audit/skill-fixture-quarantine/<receiptId>/`
  and deletes nothing. Intent and completed receipts, with the sha256 of every
  file, go to `<cleoHome>/audit/skill-fixtures.jsonl`.
- `resolveSkillPath` and `findSkill` fall back to the skill bundled in
  `@cleocode/skills` when no search path holds it. `ct-lead` and several
  LOOM-stage skills are never installed, so tier-1 lead spawns printed
  "Skills not installed" and every stage's guidance fell back to a stub.
  `CLEO_SKILL_SOURCE=embedded` still disables the fallback. The set of skills
  installed to harnesses is unchanged.
