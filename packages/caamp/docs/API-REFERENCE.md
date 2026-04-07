# CAAMP API Reference

> **@cleocode/caamp** — Central AI Agent Managed Packages

This file is **not hand-maintained**. The canonical API reference is
generated from TSDoc in source via [forge-ts][forge-ts] and written to:

- [`docs/generated/api-reference.md`](./generated/api-reference.md) —
  full single-file markdown API reference (every exported symbol).
- [`docs/generated/llms.txt`](./generated/llms.txt) — token-compact
  agent digest of the public surface.
- [`docs/generated/llms-full.txt`](./generated/llms-full.txt) — full
  agent digest with every `@example` block inlined.

## Quick Links

- **Install**: `npm install @cleocode/caamp` (or `pnpm add @cleocode/caamp`)
- **Import**: `import { ... } from "@cleocode/caamp";`
- **Barrel source**: [`src/index.ts`](../src/index.ts) — the authoritative
  public export surface.
- **Generated reference**:
  [`docs/generated/api-reference.md`](./generated/api-reference.md)
- **Regenerate**: `pnpm --filter @cleocode/caamp run docs`

## Regenerating These Docs

```bash
# From the repo root:
pnpm --filter @cleocode/caamp run docs

# Or directly inside packages/caamp:
pnpm run docs
```

The `docs` script runs `forge-ts check` (TSDoc coverage gate) followed
by `forge-ts build` (regenerates `docs/generated/`). If TSDoc coverage
fails, the script exits non-zero and the generated directory is **not**
touched — fix the reported TSDoc gaps in source, then rerun.

### Editing the API reference

**Do not edit `docs/generated/api-reference.md` directly.** Every run of
`pnpm run docs` overwrites it. To change what appears there:

1. Edit the TSDoc comment on the exported symbol in `src/…`.
2. Re-run `pnpm run docs`.
3. Commit the regenerated file alongside the source change.

See [`AGENTS.md`](../AGENTS.md) for the full doc-regeneration workflow.

## forge-ts Configuration

The forge-ts config lives at
[`forge-ts.config.ts`](../forge-ts.config.ts) in the package root. Key
decisions:

- **Enforced at error severity**: `require-summary`, `require-param`,
  `require-returns`, `require-example`, `require-class-member-doc`,
  `require-interface-member-doc`. These are load-bearing for the
  generated API reference.
- **Enforced at warn severity**: `require-remarks`,
  `require-tsdoc-syntax`, `require-fresh-examples`.
- **Turned off (paused)**: `require-release-tag`, `require-since`,
  `require-see`, `require-default-value`. These are nice-to-have but
  would drown the signal from the real coverage gates. They will be
  re-enabled in a follow-up once the `@public`/`@beta`/`@internal`
  audit lands.

[forge-ts]: https://github.com/kryptobaseddev/forge-ts
