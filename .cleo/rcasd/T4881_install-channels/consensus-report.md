# T4881: Installation Channels and Dev Runtime Isolation -- Consensus Report

**Date**: 2026-02-25
**Task**: T4882
**Epic**: T4881
**Type**: Consensus
**Status**: complete

## Decision Summary

Consensus is to adopt a three-channel model:

1. `stable` for general production usage
2. `beta` for prerelease validation
3. `dev` for contributor-local work with isolation

## Key Agreements

- CAAMP owns provider-specific MCP configuration workflows.
- CLEO owns channel contract semantics and contributor runtime guidance.
- Dev profile defaults to isolated naming and storage to prevent collisions with stable.
- Dev mode command surface is `cleo-dev` only (no `ct`, no default `cleo` symlink).
- Installer link behavior should be centralized in `installer/lib/link.sh`.
- Production install flows must not invoke scripts from `/dev` paths.
- Raw `npm link` is recognized as a package-bin workflow and not the canonical isolated dev-channel path.

## Risks Accepted

- Slightly increased onboarding complexity due to additional channel concepts.
- Additional cross-channel verification burden.

## Mitigations

- Standard naming conventions (`cleo`, `cleo-beta`, `cleo-dev`).
- Clear diagnostics and documentation.
- CAAMP install/update/uninstall and validation workflows.
