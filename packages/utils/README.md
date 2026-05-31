# @cleocode/utils

Shared, **pure**, **zero-dependency** utility leaf for the CLEO monorepo.

This package is the single home for small stateless helpers that were
previously copy-pasted inline across packages. It is a graph **leaf**: it must
never import another `@cleocode/*` package, perform I/O, or hold global state.

It is **not published** independently — it is bundled into `@cleocode/cleo` at
build time (owner decision: a single published artifact). Hence
`"private": true`.

## Contents

| Export | Replaces | Notes |
|--------|----------|-------|
| `formatBytes(bytes)` | inline copies in `cleo/src/cli/commands/gc.ts` and `core/src/docs/export-document.ts` | Behaviour-preserving union of both former copies (whole bytes < 1 KiB, one-decimal binary steps up to TB). |

## Adding a helper

1. One file per helper under `src/` with full TSDoc.
2. Must be pure + dependency-free + unit-tested (`src/__tests__/`).
3. Re-export it from `src/index.ts`.

Part of **E5 — SOLID/DRY package hygiene** (T11392, Saga T11387 SG-PACKAGE-ARCH).
