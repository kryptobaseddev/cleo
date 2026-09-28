---
id: t10483-release-shared-surface-contract
tasks: [T10483, T10476]
kind: feat
summary: Define the release command/template shared-surface contract (RELEASE_SHARED_SURFACE_CONTRACT) and document the consumer workflow/hook template contract.
---

`@cleocode/contracts` now exports `RELEASE_SHARED_SURFACE_CONTRACT`, pinning the
four release verbs (`plan`, `open`, `reconcile`, `rollback`) to their dispatch
operations and classifying the four shipped release workflow templates. No LLM
call may block any release surface, and `cleo release plan` stays
deterministic and network-free. `docs/release/consumer-workflow-hook-contract.md`
separates shipped consumer workflow/hook surfaces from cleocode's dogfood-only
CI, and the workflow template README now names the commands that exist today.
