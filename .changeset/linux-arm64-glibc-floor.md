---
id: linux-arm64-glibc-floor
tasks: [T12382]
kind: breaking
summary: "linux-arm64 native binaries now require glibc ≥ 2.39 (Ubuntu 24.04+ / Debian 13+); older ARM64 Linux uses the WASI fallback for .cant, and the worktree helper is unavailable there."
prs: [1718]
breaking: "On ARM64 Linux with glibc older than 2.39 (Ubuntu 22.04, Debian 12 and older), the bundled linux-arm64-gnu native binaries no longer load. @cleocode/cant falls back to its WebAssembly (WASI) build automatically — parsing and validation are unchanged, but cantExecutePipelineNative resolves to success: false. The native worktree helper in @cleocode/worktree is unavailable on those hosts. Upgrade to Ubuntu 24.04+ / Debian 13+ (or any glibc ≥ 2.39 distribution) to keep the native binaries."
---

The linux-arm64-gnu binaries of the cant and worktree napi addons are now built
on GitHub's native `ubuntu-24.04-arm` runner instead of being cross-compiled,
which removes the cross toolchain from the release critical path. Binaries link
against the build host's glibc, so they now require glibc ≥ 2.39 (Ubuntu 24.04+
/ Debian 13+). musl (Alpine) ARM64 builds are unaffected. Older ARM64 Linux
uses the WASI fallback for `.cant`, and the worktree helper is unavailable
there.
