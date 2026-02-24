# Documentation Drift Staged Plan

This plan defines how CLEO reaches full documentation parity without allowing canonical vision drift.

## Objective

- Lock canonical identity and product contract immediately.
- Reduce operational drift in staged phases.
- Move from partial coverage to strict full-doc enforcement.

## Hard Gate (Effective Immediately)

The following are release-blocking:

1. Canonical vision markers in `docs/concepts/vision.mdx`
2. Canonical contract in `docs/specs/PORTABLE-BRAIN-SPEC.md`
3. Source-of-truth hierarchy in `README.md` and `docs/INDEX.md`
4. Canonical term set consistency:
   - Portable Memory
   - Provenance by Default
   - Interoperable Interfaces
   - Deterministic Safety
   - Cognitive Retrieval

CI enforcement: `detect-drift.sh --canonical --strict`

## Phase 1: Metadata Integrity (Now)

- Keep `docs/commands/COMMANDS-INDEX.json` synchronized with script headers.
- Require zero index metadata drift.
- Keep command registry generated from script header source-of-truth.

Exit criteria:
- `detect-drift.sh --full` shows no INDEX metadata warnings.

## Phase 2: Command Doc Coverage (Incremental)

Approach:

1. Prioritize high-usage commands (`add`, `list`, `show`, `update`, `complete`, `session`, `focus`, `next`, `analyze`, `find`, `orchestrator`, `nexus*`, `research`).
2. Add remaining write/read/maintenance command docs.
3. Ensure each command has one doc entry in `docs/commands/<command>.md`.

Exit criteria:
- 100% command doc coverage.

## Phase 3: Full Strict Drift Mode

After Phase 2 completion:

- Promote full drift check to strict in CI.
- Keep canonical strict gate in place as separate check.

Target CI sequence:

1. `detect-drift.sh --canonical --strict` (identity gate)
2. `detect-drift.sh --full --strict` (full doc integrity gate)

## Operational Rules

1. Never represent planned features as shipped.
2. Vision-level changes require synchronized edits to:
   - `docs/concepts/vision.mdx`
   - `docs/specs/PORTABLE-BRAIN-SPEC.md`
   - `README.md`
3. Roadmap/spec updates must not redefine product identity.

## Ownership

- Product identity governance: maintainers responsible for vision and portable-brain spec.
- Command reference parity: CLI command owners.
- CI drift policy: repository maintainers.
