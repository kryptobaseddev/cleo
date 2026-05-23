---
id: t10177-release-prepare-fix
tasks: [T10177]
kind: feat
summary: "fix(T10177)!: release-prepare.yml scoped to @cleocode/* workspaces (SAGA T10176)"
---

fix(T10177)!: release-prepare.yml scoped to @cleocode/* workspaces (SAGA T10176)

Makes the v5.101 surgical revert (commit d26b76751) permanent. release-prepare.yml
now only bumps @cleocode/* workspace versions — external deps (tree-sitter,
drizzle-orm, @forge-ts/cli, @biomejs/biome, @types/node, typedoc, simple-git,
etc.) are never touched.

- Extract bump logic from inline jq into scripts/bump-workspace-deps.mjs (testable).
- Filter is now key-based (key starts with `@cleocode/`) instead of the previous
  value-based "starts with a digit" heuristic that ate 10 externals in v5.100.
- Add scripts/__tests__/bump-workspace-deps.test.mjs (21 regression cases) covering
  every external dep the v5.100 workflow bumped + every @cleocode/* ref-shape.
- Reattach scripts/__tests__/*.test.mjs to the vitest workspace via a dedicated
  `scripts` project; previously these tests silently dropped out of CI shards
  after T9079 switched to projects-mode.
- Add `(strict mode)` label to lint-cli-package-boundary fail banner (latent
  T10076 test now exercised by the re-attached scripts project).
