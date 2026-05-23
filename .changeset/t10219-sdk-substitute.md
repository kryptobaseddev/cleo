---
id: t10219-sdk-substitute
tasks: [T10219]
kind: feat
summary: "worktrunk SDK substitute surface in worktrunk-core (hybrid DTO + git2 wrapper, SAGA T10176)"
---

feat(T10219): worktrunk SDK substitute surface in worktrunk-core (hybrid DTO + git2 wrapper, SAGA T10176)

Audit-first implementation per ADR-078 SoC contract. Vendored pure-data DTOs
(`BranchDeletionMode`, `CopyIgnoredConfig`, field-only `UserConfigDto`,
`RefSnapshot`) + substituted heavy types with a `worktrunk_core::git::Repo`
trait and `std::process::Command`-backed `ProcessRepo` default impl. NO
CLI/styling/hooks imports. Unblocks T10220 (step extraction) +
T10221 (lifecycle extraction).

The audit (`docs/research/t10219-worktrunk-sdk-interface-audit.md`,
slug `t10219-sdk-interface-audit`) catalogues 45+ `Repository` methods
called by step/* + worktree/* consumers and classifies each as
implementable-via-process-or-git2 vs deferred. The `ProcessRepo` default
impl implements 11 of the 45 methods today (worktree management +
config get/set + short-sha + run_command); the rest return a typed
`anyhow::Error` from `unimplemented_in_sdk()` so T10220/T10221 can
program against the contract and fill in implementations incrementally.
