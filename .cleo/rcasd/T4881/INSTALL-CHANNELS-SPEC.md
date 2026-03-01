# INSTALL-CHANNELS-SPEC

**Date**: 2026-02-25
**Task**: T4884
**Epic**: T4881
**Type**: Specification
**Status**: complete

This specification is canonically published at `docs/specs/CLEO-INSTALL-CHANNELS-SPEC.md`.

## Normative Outcome

- CLEO runtime behavior SHALL follow ADR-016.
- Channel definitions SHALL remain consistent across CLI and MCP surfaces.
- Provider profile installation details SHALL be delegated to CAAMP.
- Contributor dev mode SHALL use `cleo-dev` naming and SHALL NOT create `ct` alias.
- Installer links SHALL be managed by `installer/lib/link.sh` as single source.
- Raw `npm link` is treated as a package-bin workflow, not the canonical isolated dev-channel workflow.

## Linked Deliverables

- `docs/specs/CLEO-INSTALL-CHANNELS-SPEC.md`
- `docs/specs/CAAMP-CLEO-INTEGRATION-REQUIREMENTS.md`
