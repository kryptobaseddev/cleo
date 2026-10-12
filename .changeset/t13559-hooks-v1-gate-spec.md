---
id: t13559-hooks-v1-gate-spec
tasks: [T13559]
kind: docs
summary: "The unified project hooks spec documents the hooks-v1 release gate"
---

The `unified-project-hooks-v1` spec now describes the T13557 gate: a stable
build refuses activation with `E_HOOKS_V1_UNRELEASED`, existing receipts never
run (a required CI check fails), and the gate opens on a `-canary.N` build or
the `cleo.releasedFeatures` stamp of the hooks-v1 promotion release. A test now
pins that the gate reads `@cleocode/core`'s own manifest.
