# release-test-npm-lib

Single-package npm library archetype for release-pipeline tests.

A minimal TypeScript library used by T9543/T9544 to exercise the
`single-npm-lib` archetype path defined in SPEC-T9345 §9.1.

This fixture is **not** runnable on its own — no lockfile, no installed
deps. It exists purely so tests can read its `.cleo/*.json` config +
TS source layout and assert correct archetype resolution.
