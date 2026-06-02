# CLEO native binary distribution (T11340 · SG-RUNTIME-UNIFICATION R1 · T11580 · R10-L1)

This directory carries the **distribution metadata + P1 fallback** for the two
CLEO-managed native binaries, both distributed via the same packaging pattern
(decision D14′) through the single `@cleocode/core` postinstall picker:

- **`cleo-supervisor`** — a standalone executable (`crates/cleo-supervisor`).
  **Not** a napi `.node` addon and **not** a Bun process (D8′).
- **`worktree-napi`** — the napi-rs Node-API addon (`crates/worktree-napi`)
  consumed by `@cleocode/worktree`. As of R10-L1 (T11580) the host-triple
  `.node` is resolved by the SAME picker so `@cleocode/worktree` no longer has
  to bundle all four `.node` files in its own tarball.

## Layout

| Path | Produced by | Shipped in tarball? |
|------|-------------|---------------------|
| `cleo-supervisor-manifest.json` | CI (`gen-supervisor-manifest.mjs`) at publish time | **Yes** (Pattern P2 — pinned, not fetched) |
| `worktree-napi-manifest.json` | CI (`gen-napi-manifest.mjs`) at publish time | **Yes** (Pattern P2 — pinned, not fetched) |
| `fallback/cleo-supervisor` | CI (`cargo build --release` linux-x64-gnu) | **Yes** (Pattern P1 — `--ignore-scripts` installs) |
| `fallback/worktree-napi.linux-x64-gnu.node` | CI (`cargo build --release` linux-x64-gnu) | **Yes** (Pattern P1 — `--ignore-scripts` installs) |
| `fallback/.gitkeep` | repo | n/a (placeholder so the dir is tracked) |

Neither the manifests nor the fallback binaries are committed to git — all four
are generated/staged in CI. The `binaries/` directory is listed in
`packages/core/package.json` `files` so they land in the published
`@cleocode/core` tarball.

## Pattern P2 — postinstall download + sha256 verify (primary)

The shared picker module is `scripts/napi-binary-picker.mjs`, driven for both
binaries by the `postinstall` entrypoint `scripts/install-supervisor-binary.mjs`.

1. CI cross-compiles the supported targets:
   - `cleo-supervisor`: 5 triples (`linux-x64-gnu`, `linux-arm64-gnu`,
     `darwin-x64`, `darwin-arm64`, `win32-x64-msvc`) in
     `.github/workflows/cleo-supervisor-prebuild.yml`.
   - `worktree-napi`: 4 triples (`linux-x64-gnu`, `linux-arm64-gnu`,
     `darwin-arm64`, `win32-x64-msvc`; `darwin-x64` dropped per T10479) in the
     release prebuild matrix.
2. CI attaches the binaries to the **GitHub Release** for the matching
   `@cleocode/core` version using `GITHUB_TOKEN` only — **ZERO new OIDC trust
   configs** (no `@cleocode/cleo-supervisor-*` / `@cleocode/worktree-napi-*`
   npm packages).
3. CI generates the per-binary manifest (per-triple sha256 + Release base URL)
   and checks it **into the tarball**.
4. On `npm install`, the `postinstall` picker resolves the host triple
   (platform + arch + libc), downloads the matching binary from the Release,
   **verifies the sha256 fail-closed**, and caches it under
   `~/.cache/cleo/napi-bin/<version>/` written atomically (tmp-then-rename;
   `chmod +x` for the supervisor executable, no exec bit for the `.node` addon).
5. `CLEO_NAPI_BINARY_MIRROR` overrides the download base URL for corporate
   proxies / air-gapped mirrors (shared by both binaries).

At runtime `@cleocode/worktree`'s loader (`src/napi-binding.ts`) resolves, in
order: the bundled `native/worktree-napi.cjs`, the repo-local crate loader, then
the **core-managed cached `.node`** written by the picker (newest version first).

## Pattern P1 — bundled linux-x64-gnu fallback

For `npm install --ignore-scripts` (postinstall never runs) or an offline /
mirror-outage download failure, the picker falls back to the bundled
`fallback/cleo-supervisor` / `fallback/worktree-napi.linux-x64-gnu.node`
**iff** the host triple is `linux-x64-gnu`. Only one fallback per binary is
bundled to keep the tarball under the 25 MB budget enforced by
`scripts/check-core-tarball-size.mjs` (T11342 / T11580).

## Tarball size budget (T11342 · T11580)

Only the `linux-x64-gnu` fallback is bundled for each binary family. The CI gate
`scripts/check-core-tarball-size.mjs` fails the build if the packed
`@cleocode/core` tarball exceeds **25 MB** or if more than one platform binary
of either family is found bundled (or one targets a non-`linux-x64-gnu` triple).
