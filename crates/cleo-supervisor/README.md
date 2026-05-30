# cleo-supervisor

Native Rust process supervisor for CLEO — the R1 foundation of the
SG-RUNTIME-UNIFICATION saga (T11243 / epic T11252). It ports the proven
`StudioSupervisor` shape (`packages/core/src/sentient/daemon.ts`) to
tokio/Rust and is distributed as a standalone binary via the worktree-napi-style
packaging pattern (decision D14′) — **not** a napi `.node` addon and **not** a
Bun process (D8′).

## What it does

- **Atomic pidfile** under the canonical CLEO home (`<cleo_home>/cleo-supervisor.pid`),
  written tmp-then-rename, with stale-pid detection that refuses a double-launch.
- **Crash-restart** of child workers spawned via `tokio::process`, with
  exponential backoff (1s → 2s → 4s …, capped at 30s — mirrors `STUDIO_*_RESTART_DELAY_MS`).
- **Graceful shutdown cascade**: SIGTERM → 10s grace → SIGKILL; SIGCHLD zombie
  reaping (Unix); Windows children attached to a Job Object so they die with
  the supervisor.
- **Rolling-file logging** via `tracing-appender` under `<cleo_home>/logs`.
- **FROZEN supervisor-ipc v1.0** message contract (mirror of
  `@cleocode/contracts/supervisor-ipc`) with a Unix-socket / Windows-pipe
  NDJSON fan-out (consumed by R2 / T11253).

## CLI

```bash
cleo-supervisor --version   # "cleo-supervisor <ver> (<triple> / <ipc-ver>)"
cleo-supervisor --help      # usage
cleo-supervisor             # boot: pidfile + logging + signal loop
```

## Building

```bash
cargo build -p cleo-supervisor                  # debug
cargo build -p cleo-supervisor --release        # release (distribution binary)
cargo clippy -p cleo-supervisor --all-targets -- -D warnings
```

## Testing

The crate is in the workspace `default-members`, so a plain `cargo test` from
the repo root includes it. Targeted runs:

```bash
# Unit tests (backoff, pidfile, paths, ipc, supervisor core) + fast smoke.
cargo test -p cleo-supervisor

# Integration smoke only (lifecycle + fast idle-RSS).
cargo test -p cleo-supervisor --tests

# Full idle-RSS budget (60s settle, no clients, RSS <= 15 MB). #[ignore]d by
# default so the normal test command stays fast; CI runs it on the 3-target
# matrix (linux-x64, linux-arm64, darwin-arm64).
cargo test -p cleo-supervisor --test idle_rss -- --ignored --nocapture
```

## Distribution (T11340)

- CI cross-compiles 5 targets (`linux-x64-gnu`, `linux-arm64-gnu`,
  `darwin-x64`, `darwin-arm64`, `win32-x64-msvc`) and attaches them to the
  GitHub Release via `GITHUB_TOKEN` (Pattern P2 — zero new OIDC).
- A checked-in sha256 manifest + the `@cleocode/core` postinstall picker
  (`packages/core/scripts/install-supervisor-binary.mjs`) resolve, download,
  and **fail-closed** verify the host binary, caching it under
  `~/.cache/cleo/napi-bin/<version>/`. `CLEO_NAPI_BINARY_MIRROR` overrides the
  base URL.
- Pattern P1 bundles the `linux-x64-gnu` binary into the tarball for
  `--ignore-scripts` installs; the 25 MB tarball budget is enforced by
  `packages/core/scripts/check-core-tarball-size.mjs` (T11342).

See `packages/core/binaries/README.md` for the full packaging contract.
