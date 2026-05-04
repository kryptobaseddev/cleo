# Extractor Regression Fixtures

**Task**: T1841 | **Added**: 2026-05-04 | **Owner**: CLEO

This directory contains pinned fixture source files used by the extractor
regression test suite and the `pnpm bench:nexus` parity gate.

## Purpose

Before this infrastructure existed, zero automated tests prevented a regression
in any of the four language extractors (TypeScript, Python, Go, Rust). A
refactor that silently dropped 50% of CALLS resolution would not be caught
until human review.

These fixtures and their associated snapshot baselines lock the _current_
extractor output as a floor. Any decrease in node counts, import edge counts,
or heritage edge counts vs the baseline fails CI.

## Fixture Files

| File | Language | Extractor |
|------|----------|-----------|
| `typescript/sample.ts` | TypeScript | `typescript-extractor.ts` |
| `python/sample.py` | Python | `python-extractor.ts` |
| `go/sample.go` | Go | `go-extractor.ts` |
| `rust/sample.rs` | Rust | `rust-extractor.ts` |

Each fixture is a minimal but realistic sample that exercises:
- Functions / standalone `fn` / `def` / `func`
- Classes / structs with fields (property nodes)
- Constructors (`constructor` / `__init__` / `new`)
- Methods
- Interfaces / traits
- Enums
- Type aliases
- Explicit imports (`import` / `use` / `from … import`)
- Inheritance / embedding / trait impls (heritage edges)

## v1 Snapshot Baselines

Captured 2026-05-04 from the fixtures at this commit.

| Language | Total defs | Imports | Heritage |
|----------|-----------|---------|---------|
| TypeScript | 30 | 3 | 0 |
| Python | 24 | 7 | 3 |
| Go | 34 | 5 | 2 |
| Rust | 53 | 8 | 4 |

Full kind-level breakdown is stored as `const TS_SNAPSHOT / PY_SNAPSHOT / ...`
in `../extractor-regression.test.ts`.

## Running the Regression Suite

```bash
# Run as part of the normal test suite
pnpm --filter @cleocode/nexus run test

# Run only the regression tests
pnpm --filter @cleocode/nexus run test -- src/__tests__/extractor-regression.test.ts
```

Tests skip gracefully when `tree-sitter` native bindings are unavailable
(environments without native module builds). When bindings are present, all
snapshot assertions are enforced with ZERO tolerance for count decreases.

## Running the Parity Bench

```bash
pnpm --filter @cleocode/nexus run bench:nexus
```

Emits JSON to stdout with actual counts and deltas vs baseline.
Exits non-zero if any count drops below the snapshot floor.
Use as a CI gate before merge.

## Updating Snapshots

If an extractor improvement legitimately increases counts:

1. Run the bench to confirm the increase:
   ```bash
   pnpm --filter @cleocode/nexus run bench:nexus
   ```

2. Update the snapshot constants in `extractor-regression.test.ts`:
   - `TS_SNAPSHOT`, `PY_SNAPSHOT`, `GO_SNAPSHOT`, `RUST_SNAPSHOT`

3. Update the `BASELINES` object in `bench-nexus.ts`.

4. Update the v1 table in this README.

5. Commit with a message referencing the extractor task that improved the counts.

**Never decrease a snapshot value without a deliberate, reviewed decision.**

## Adding a New Language (e.g. Swift — T1843)

1. Create `fixtures/swift/sample.swift` exercising the full symbol inventory
   for the new extractor.

2. Run the extractor against the fixture manually (use `tsx` + `tree-sitter`).

3. Record the baseline counts in `extractor-regression.test.ts` as
   `SWIFT_SNAPSHOT`.

4. Add a `describe('Swift extractor regression ...')` block following the
   existing pattern.

5. Add a `swift` entry to `BASELINES` in `bench-nexus.ts`.

6. Update this README table.
