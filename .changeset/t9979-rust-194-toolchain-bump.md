---
id: t9979-rust-194-toolchain-bump
tasks: [T9979]
kind: feat
summary: "bump Rust toolchain to 1.94 workspace-wide"
---

chore(T9979): bump Rust toolchain to 1.94 workspace-wide

Workspace-wide bump from 1.88 → 1.94 to unblock Saga T9977 SG-WORKTRUNK-OWN
(donor worktrunk requires 1.94). Updates rust-toolchain.toml, per-crate
rust-version fields, regenerates Cargo.lock, updates CI matrix.

Saga: T9977
Decision: D010
Closes: T9994, T9995, T9996, T9997, T9998
