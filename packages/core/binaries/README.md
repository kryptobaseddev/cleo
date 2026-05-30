# cleo-supervisor native binary distribution (T11340 · SG-RUNTIME-UNIFICATION R1)

This directory carries the **distribution metadata + P1 fallback** for the
`cleo-supervisor` native binary (`crates/cleo-supervisor`). The supervisor is a
standalone executable distributed via the worktree-napi-style packaging pattern
(decision D14′), **not** a napi `.node` addon and **not** a Bun process (D8′).

## Layout

| Path | Produced by | Shipped in tarball? |
|------|-------------|---------------------|
| `cleo-supervisor-manifest.json` | CI (`gen-supervisor-manifest.mjs`) at publish time | **Yes** (Pattern P2 — pinned, not fetched) |
| `fallback/cleo-supervisor` | CI (`cargo build --release` linux-x64-gnu) | **Yes** (Pattern P1 — `--ignore-scripts` installs) |
| `fallback/.gitkeep` | repo | n/a (placeholder so the dir is tracked) |

Neither the manifest nor the fallback binary is committed to git — both are
generated/staged in CI. They are listed in `packages/core/package.json`
`files` so they land in the published `@cleocode/core` tarball.

## Pattern P2 — postinstall download + sha256 verify (primary)

1. CI cross-compiles 5 targets (`linux-x64-gnu`, `linux-arm64-gnu`,
   `darwin-x64`, `darwin-arm64`, `win32-x64-msvc`) in
   `.github/workflows/cleo-supervisor-prebuild.yml`.
2. CI attaches the 5 binaries to the **GitHub Release** for the matching
   `@cleocode/core` version using `GITHUB_TOKEN` only — **ZERO new OIDC trust
   configs** (no `@cleocode/cleo-supervisor-*` npm packages).
3. CI generates `cleo-supervisor-manifest.json` (per-triple sha256 + Release
   base URL) and checks it **into the tarball**.
4. On `npm install`, `scripts/install-supervisor-binary.mjs` (the package
   `postinstall`) resolves the host triple (platform + arch + libc), downloads
   the matching binary from the Release, **verifies the sha256 fail-closed**,
   and caches it under `~/.cache/cleo/napi-bin/<version>/` with `chmod +x`
   written atomically (tmp-then-rename).
5. `CLEO_NAPI_BINARY_MIRROR` overrides the download base URL for corporate
   proxies / air-gapped mirrors.

## Pattern P1 — bundled linux-x64-gnu fallback

For `npm install --ignore-scripts` (postinstall never runs) or an offline /
mirror-outage download failure, the picker falls back to the bundled
`fallback/cleo-supervisor` **iff** the host triple is `linux-x64-gnu`. Only one
fallback binary is bundled to keep the tarball under the 25 MB budget enforced
by `scripts/check-core-tarball-size.mjs` (T11342).

## Tarball size budget (T11342)

Only the `linux-x64-gnu` fallback is bundled. The CI gate
`scripts/check-core-tarball-size.mjs` fails the build if the packed
`@cleocode/core` tarball exceeds **25 MB** or if more than one platform binary
is found bundled.
