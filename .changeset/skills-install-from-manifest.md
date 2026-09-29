---
id: skills-install-from-manifest
tasks: [T12653]
kind: fix
summary: Install reads metadata.install from the skills manifest, so ct-lead and the LOOM stage skills reach harnesses; skills.json is removed
---

`initCoreSkills` used to install the `packages/skills/skills.json` entries with
`tier <= 2`. That catalogue omitted `ct-lead`, which every tier-1 lead spawn
loads, and six LOOM stage skills that stage guidance and the protocol files
name (`ct-adr-recorder`, `ct-consensus-voter`, `ct-ivt-looper`,
`ct-release-orchestrator`, `ct-artifact-publisher`, `ct-provenance-keeper`).
None of them was ever installed. It also installed `ct-grade`, which is
internal (D11157), and disagreed with SKILL.md on five versions.

Install now reads `packages/skills/skills/manifest.json`, which is generated
from SKILL.md frontmatter, and installs exactly the entries that declare
`metadata.install: harness`: 22 skills. `skills.json` is deleted.

- **Catalogue:** manifest entries now carry the catalogue fields CAAMP needs
  (`core` and `category`, both derived from `metadata.tier`; `dependencies`,
  `sharedResources`, `compatibility`, `license`). CAAMP's
  `buildLibraryFromFiles` falls back to deriving the catalogue from
  `skills/manifest.json` when a library ships no `skills.json`, via the newly
  exported `catalogEntryFromManifest`. Third-party libraries that ship a
  `skills.json` load as before. `@cleocode/skills`' `index.js` derives
  `skills` from the manifest.
- **Package discovery:** `init` and the CLI's library auto-registration now
  find the skills package by `skills/manifest.json`.
- **Aliases:** `SKILL_NAME_MAP` no longer maps aliases to three skills that
  never existed (`ct-test-writer-bats`, `ct-library-implementer-bash`,
  `ct-skill-lookup`) or to the internal `ct-skill-creator`.
- **Gate 29:** fails if a `packages/skills/skills.json` reappears, and rejects
  top-level `core` and `category` frontmatter keys (both are derived).
- **Gate 30:**
  - also reads `SKILL_NAME_MAP` and `dispatch.ts` skill names;
  - matches every quote style and stays inside its own literal;
  - mirrors the new install selection;
  - its baseline is now empty.

Install does not prune. A machine that already has `ct-grade` installed keeps
it until the skills are reinstalled or removed.
