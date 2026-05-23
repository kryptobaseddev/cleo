---
id: t10222-parity-tests
tasks: [T10222]
kind: feat
summary: "parity test suite for worktrunk-core SDK primitives (SAGA T10176, T10218)"
---

test(T10222): parity test suite for worktrunk-core SDK primitives (SAGA T10176, T10218)

`cargo test --test parity` verifies each extracted SDK primitive matches the
original worktrunk binary's behavior on canonical fixtures. Covers prune,
promote, squash, copy_ignored, relocate, cache, remove_dir, sync, diff.
