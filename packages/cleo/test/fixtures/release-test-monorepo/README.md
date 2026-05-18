# release-test-monorepo

Monorepo archetype for release-pipeline integration tests.

Mimics a pnpm-workspaces project (like cleocode itself) so the release pipeline
matrix in T9543/T9544 can exercise the `monorepo-w-workspaces` archetype path
defined in SPEC-T9345 §9.1.

This fixture is **not** runnable on its own — it has no lockfile and no
installed dependencies. It exists purely so tests can read its `.cleo/*.json`
config + package.json layout and assert correct archetype resolution.
