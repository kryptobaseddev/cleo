---
id: cant-parser-every-os-wasi-fallback
tasks: [T12382]
kind: fix
summary: "`.cant` parsing works on every OS: native binaries for 8 triples plus an automatic WebAssembly fallback, bundled in @cleocode/cant"
---

`@cleocode/cant` shipped exactly one native binary,
`napi/cant.linux-x64-gnu.node`, committed to git. On macOS, Windows and ARM
Linux every `.cant` parse threw, so `cleo cant *`, CAAMP's Pi harness
(`caamp pi cant validate|install`), agent identity loading and `.cantbook`
parsing were all broken there.

The existing Rust parser (crates/cant-napi) is now built, with no parser
rewrite, for linux x64/arm64 (glibc and musl), darwin x64/arm64 and win32
x64/arm64, plus `wasm32-wasip1-threads` from the same crate. All nine
artifacts are bundled inside `@cleocode/cant` (no new npm packages). The
napi-rs generated loader uses the native binary for the host and falls back
to the WebAssembly build automatically when none matches; set
`NAPI_RS_FORCE_WASI=error` to force it. `cantAddonBackend()` reports which
backend loaded, and `cleo doctor`'s dependency check now reports it too.

Both backends give identical results for every `.cant` and `.cantbook` file
in the repository. One function is native-only: `cantExecutePipelineNative`
spawns subprocesses through cant-runtime's multi-thread tokio runtime, which
WASI cannot provide, so under WASI it resolves to `success: false` with an
explanatory `error` instead of running.

No binary is committed any more. Arch gate 24
(`scripts/lint-no-committed-native-binaries.mjs`) fails on a tracked
`.node`/`.wasm`, and in `--packed` mode fails the release unless every triple
is packed and each binary carries the `cant-napi-source-rev:<sha>` stamp of
the released commit, so a stale binary cannot ship.
