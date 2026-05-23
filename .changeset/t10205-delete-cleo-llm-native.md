---
id: t10205-delete-cleo-llm-native
tasks: [T10205]
kind: feat
summary: "delete verified-dead cleo-llm-native crate + JS loader (SAGA T10176)"
---

chore(T10205): delete verified-dead cleo-llm-native crate + JS loader (SAGA T10176)

Removes 1209 LOC of verified-dead code per ADR-078 / Decision D010:
- `crates/cleo-llm-native/` (Rust crate — 559 LOC)
- `packages/core/src/llm/rust/` (JS loader + .d.ts + tests — 650 LOC)
- `Cargo.toml` `[workspace] members` + `default-members` entries
- All `CLEO_USE_RUST` env-var references (already 0 in production)

Verified-safe deletion: production transports
(`chat-completions.ts`, `gemini.ts`, `openai.ts`) import
`StreamingThinkScrubber` from the TS path (`../think-scrubber.js`)
NOT the rust loader. The native binary distribution was never wired
(no `packages/cleo-llm-native-<platform>/` artifacts, unlike
`lafs-napi` / `cant-napi` / `worktree-napi`). CLEO_USE_RUST was a
speculative perf-opt-in flag that never reached production.
