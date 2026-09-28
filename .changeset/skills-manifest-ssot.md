---
id: skills-manifest-ssot
tasks: [T12648]
kind: feat
summary: SKILL.md frontmatter is now the skills metadata SSoT; the manifest is generated from it and two arch gates enforce it
---

Every canonical skill now declares `metadata.version`, `metadata.tier`
(`core` | `on-demand` | `internal`) and `metadata.install` (`harness` |
`internal`) in its SKILL.md frontmatter, per owner decision D11157. The
duplicate `metadata:` block in ct-task-executor, the top-level `tier` keys and
the three-way version disagreements are gone; each skill has one version.

`packages/skills/skills/manifest.json` is generated from the frontmatter by
`node scripts/skills/generate-manifest.mjs`. It now lists all 29 skill
directories (it omitted seven, including ct-codebase-mapper and ct-lead) and
carries `deliveryTier` and `install`. Curated routing data
(`dispatch_matrix`, capabilities, constraints) is carried over unchanged.

Two gates join `cleo check arch` and the Arch Boundary Check workflow:

- Gate 29, `scripts/lint-skills-manifest.mjs`, fails on invalid frontmatter or
  a manifest that differs from the generator output. Zero tolerance.
- Gate 30, `scripts/lint-emitted-skills.mjs`, fails when a skill named by
  stage guidance, the spawn prompt or a `.cant` protocol does not exist, is
  not `install: harness`, or is not actually installed, and when
  `metadata.install` disagrees with what install does. Today's 15 known
  violations (ct-lead and six LOOM skills not installed, T12646; ct-grade
  installed although internal, T12649) are baselined; stale entries fail.

No install behaviour changes in this release.
