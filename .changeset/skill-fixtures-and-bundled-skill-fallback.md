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
  sandboxes the environment. It computes that dir from the raw platform rules
  rather than loading `env-paths`, which caches `os.homedir()` when imported.
  It then refuses every fs write under the dir with `E_TEST_REAL_DATA_WRITE`
  and fails the test in `afterEach`/`afterAll`, even when the code under test
  swallowed the error. Only the git checkout the run started in is exempt.
  Other agents' worktrees are not. The known limits are documented in the
  file: paths are compared as text, and child processes and native writes
  are not seen.
- New `cleo doctor skill-fixtures [--repair | --restore <receiptId>] [--dry-run]`.
  An entry counts as a fixture only when its name is `<slug>-<uuid>` or one of
  the three fixture names and its content is exactly what those tests write.
  Any other entry with a matching name is reported as `unclassified` and left
  alone. Manifest skills, bundled names and hidden entries are never
  candidates. `--repair` moves fixtures into
  `<cleoHome>/audit/skill-fixture-quarantine/<receiptId>/` and deletes
  nothing. Across filesystems it copies instead, checks the copy against the
  recorded hashes, and only then removes the source. Intent and completed
  receipts go to `<cleoHome>/audit/skill-fixtures.jsonl`, and `--restore`
  moves a run back without overwriting anything.
- `ct-lead` and several LOOM-stage skills are never installed, so tier-1 lead
  spawns printed "Skills not installed" and every stage's guidance fell back
  to a stub. When `CLEO_SKILL_SOURCE` is `auto` (the default),
  `resolveSkillPath`/`resolveSkillLocation` and stage guidance now read those
  skills from `@cleocode/skills`. They record it as `origin: 'bundled'` or
  `bundledSkills` and say so in the prompt. `caamp` and `embedded` never fall
  back. `findSkill` returns bundled skills only with `{ includeBundled: true }`,
  so playbook skill-node routing and the skill executor still see installed
  skills only. The set of skills installed to harnesses is unchanged.
