---
id: t9937-release-validate-changelog
tasks: [T9937]
kind: feat
summary: cleo release validate-changelog verb + workflow integration (Saga T9862)
---

Replaces the brittle inline grep -qF '## [VERSION]' step in .github/workflows/release.yml with a typed CLEO verb. Caught during the v2026.5.94 hotfix-2 ship: the aggregator emitted ## [vVERSION] (with v) while the workflow grep expected ## [VERSION] (no v) per ADR-028 §2.5. Centralising the canonical-header check inside CLEO removes the shell-quoting + format-drift risk and gives consumer projects a single source of truth that travels with the SDK.
