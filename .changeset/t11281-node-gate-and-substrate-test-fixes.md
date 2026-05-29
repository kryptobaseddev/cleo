---
id: t11281-node-gate-and-substrate-test-fixes
tasks: [T11281, T11242]
kind: fix
summary: Enforce Node >=24.16.0 via engines.node SSoT gate; fix node:sqlite 3.53.0 audit-test regression + cross-OS path canonicalization
---

PR #812 stabilization. (1) node:sqlite 3.53.0 DEFENSIVE mode broke saga-audit/invariant-audit test helpers that mutated sqlite_master — switched to PRAGMA ignore_check_constraints. (2) computeCanonicalProjectId crashed (ENOENT) on nonexistent paths — added canonicalizePath SSoT (realpath + lexical fallback) in @cleocode/paths covering macOS /private/var, Windows, Linux. (3) New Node-version enforcement gate in @cleocode/paths reads engines.node at runtime (full-semver, closes the 24.13.1<24.16 hole the major-only guards waved through); engines.node synced to >=24.16.0 across all packages + CI lint guardrail.
