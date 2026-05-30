---
id: t11388-e1-publish-quick-wins
tasks: [T11388, T11397, T11398, T11399, T11400, T11401]
kind: chore
summary: Reduce npm publish surface 20→18 (drop studio + mcp-adapter, delete 5 dead worktree-napi stubs), declare latent cleo→core dep, add publish-surface CI guard (Gate 9)
---

E1 quick-wins for SG-PACKAGE-ARCH (T11387). First step toward the owner's single-artifact publish target (1). Adds scripts/lint-publish-surface.mjs locking the publish_pkg list against growth + napi-stub re-introduction. Forward-only: EXPECTED_PUBLISH_COUNT decrements as R8/R10 internalize the workspace graph.
