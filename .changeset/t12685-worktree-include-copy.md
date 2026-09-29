---
"@cleocode/worktree": patch
---

Fix `.worktreeinclude` never copying anything into new worktrees (T12685). `applyIncludePatterns` called a bare `require()` from ESM, which threw on every call and routed every worktree through the literal-only legacy symlinker, so glob patterns such as `crates/worktree-napi/*.node` copied nothing. Fresh worktrees therefore lacked the native addon, and the worktree merge/audit/complete tests fell back to a stub that reported every merge as a conflict. The binding is now imported statically, the applied-pattern list no longer counts missing or pre-existing literal paths, stderr lines end in a real newline, and the test-fallback merge error names its cause.
