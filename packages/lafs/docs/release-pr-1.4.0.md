## Summary

- Add first-class envelope and compliance pipeline APIs to core TypeScript SDK for reusable agent output gating.
- Align Python envelope semantics with canonical schema behavior (MVI enum, required meta/error fields, strict and pagination validation).
- Remove stale documentation examples and migrate key docs to code-truth APIs and CLI behavior.

## Release Scope

- Version bump: `1.4.0` (root package)
- Changelog: `CHANGELOG.md` updated with Added/Changed/Documentation/Provenance sections.
- Version source of truth: root `package.json` now drives Python package version via `python/setup.py`.

## Key Changes

1. **Core SDK APIs**
   - Added `src/envelope.ts`:
     - `createEnvelope`
     - `parseLafsResponse`
     - `LafsError`
     - `LAFS_SCHEMA_URL`
   - Added `src/compliance.ts`:
     - `enforceCompliance`
     - `assertCompliance`
     - `withCompliance`
     - `createComplianceMiddleware`
     - `ComplianceError`
   - Exported from `src/index.ts`.

2. **Schema and packaging**
   - Exported schema subpaths in `package.json` for machine-readable consumption.
   - Python package version now derived from root `package.json` in `python/setup.py`.

3. **Python alignment**
   - Updated `python/lafs/envelope.py` semantics to reduce drift with canonical schema.
   - Updated `python/tests/test_client.py` fixtures to schema-valid forms.
   - `python/lafs/__init__.py` now uses package metadata for runtime version resolution.

4. **Documentation migration**
   - Updated stale or mismatched docs, including:
     - `docs/sdk/typescript.md`
     - `docs/getting-started/quickstart.md`
     - `docs/CONFORMANCE.md`
     - `docs/integrations/mcp.md`
     - `docs/integrations/a2a.md`
     - `docs/integrations/rest.md`
     - `docs/programmatic-construction.md`
     - `docs/troubleshooting.md`
     - `docs/ARCHITECTURE.md`
     - `docs/llms.txt`

## Validation

- TypeScript: `npm run typecheck` (pass)
- TypeScript tests: `npm test` (pass)
- Python tests: `pytest` in `python/` (pass)

## Provenance

- `T105` Envelope API hardening and docs provenance
- `T106` Implement first-class compliance middleware API
- `T107` Align Python envelope semantics with schema
- `T108` Eliminate stale examples across docs
