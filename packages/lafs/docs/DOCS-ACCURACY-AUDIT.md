# Documentation Accuracy Audit

This file tracks known doc-to-code mismatches and the canonical replacements.

## High-impact mismatches found

| Topic | Mismatch | Code truth | Canonical doc |
|---|---|---|---|
| Envelope creation helper | Docs referenced `createEnvelope` before API existed | Added `createEnvelope` export in `src/envelope.ts` | `docs/getting-started/quickstart.md` |
| Response parser helper | Docs referenced `parseLafsResponse` before API existed | Added `parseLafsResponse` export in `src/envelope.ts` | `docs/guides/llm-agent-guide.md` |
| Error class | Docs referenced `LafsError` before API existed | Added exported `LafsError` class | `docs/sdk/typescript.md` |
| CLI commands | Docs referenced `lafs validate`, `lafs create`, etc. | CLI accepts only `--envelope` and `--flags` on `lafs-conformance` | `docs/sdk/cli.md`, `src/cli.ts` |
| Custom schema extension guidance | Missing practical extension pattern | Base validation is envelope-only; extension must be layered | `docs/guides/schema-extension.md` |
| Outgoing agent compliance pipeline | Missing middleware-level pattern and retries | Validation + conformance APIs available for gate enforcement | `docs/guides/compliance-pipeline.md` |

## Status

- Added missing envelope-first APIs in source and exported them.
- Added tests in `tests/envelopeApi.test.ts`.
- Updated canonical pages and `docs/llms.txt`.
- Legacy pages still require full migration to remove stale examples.

## Legacy pages queued for migration

- `docs/integrations/mcp.md`
- `docs/integrations/a2a.md`
- `docs/integrations/rest.md`
- `docs/programmatic-construction.md`
- `docs/error-handling-implementation.md`
- `docs/getting-started/error-handling.md`
- `docs/CONFORMANCE.md`
- `docs/ARCHITECTURE.md`
- `docs/troubleshooting.md`
