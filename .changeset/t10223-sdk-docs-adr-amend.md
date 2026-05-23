---
id: t10223-sdk-docs-adr-amend
tasks: [T10223]
kind: feat
summary: "worktrunk-core public API doc + ADR-078 amendment (SAGA T10176, closes E3-PREREQ)"
---

docs(T10223): worktrunk-core public API doc + ADR-078 amendment (SAGA T10176, closes E3-PREREQ)

- crates/worktrunk-core/README.md documents complete SDK surface (config, git Repo+ProcessRepo, step plan-then-execute primitives, cache, remove_dir, sync, diff, paths, copy, path, progress, worktreeinclude, git_wt)
- ADR-078 amendment records SoC refactor decision + implementation PR chain (T10219/#507, T10220/#517, T10221/#518, T10222/#525, T10223/this)
- BOUNDARY_REGISTRY worktrunk-core entry rationale refreshed post-refactor with README link

Closes T10218 epic. Unblocks T10203 + T10204 under Saga T10176.
