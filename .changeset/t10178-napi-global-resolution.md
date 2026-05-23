---
id: t10178-napi-global-resolution
tasks: [T10178]
kind: fix
summary: @cleocode/worktree-napi resolves under global npm install — rayon hot-path active on installed binaries, not just dev fallback (SAGA T10176)
---

Closes the install-path gap discovered after v2026.5.101 shipped the worktrunk
vendor. Before this fix, `@cleocode/worktree@2026.5.101` published with a
literal `file:../../crates/worktree-napi` dependency that resolved to a broken
symlink under any non-workspace install — including the canonical `npm install
-g @cleocode/cleo` path. Any worktree-create operation against the installed
binary threw `MODULE_NOT_FOUND`, silently disabling the rayon parallel-copy
hot-path and forcing consumers onto the (deleted) TS fallback path.

### Root cause

`packages/worktree/package.json` declared `"@cleocode/worktree-napi":
"file:../../crates/worktree-napi"`. pnpm pack preserved that literal — npm
preserved it on install — and `crates/` does not exist in the published
tarball directory tree. Confirmed end-to-end by packing the v2026.5.101
tarball into a tmp prefix and observing the broken symlink at
`node_modules/@cleocode/worktree-napi -> ../crates/worktree-napi`.

### Fix

- `pnpm-workspace.yaml`: register `crates/worktree-napi` as a workspace member
  so pnpm can resolve `@cleocode/worktree` → `@cleocode/worktree-napi` via
  `workspace:*` (rewritten to a concrete version by pnpm pack).
- `crates/worktree-napi/package.json`: drop `private: true`, bump version,
  add `publishConfig.access=public`, rewrite optionalDependencies to
  `workspace:*` so per-triple wrappers also get concrete versions in the
  published tarball.
- `packages/worktree-napi-{linux-x64-gnu,linux-arm64-gnu,darwin-x64,darwin-arm64,win32-x64-msvc}/package.json`:
  version bump + publishConfig + repository metadata so each prebuilt
  wrapper is publishable from CI.
- `packages/worktree/package.json`: replace `file:../../crates/worktree-napi`
  with `workspace:*`.
- `.github/workflows/release.yml`: sync versions for napi + 5 per-triple
  packages; download prebuilt `.node` binaries from the
  worktree-napi-prebuild workflow and inject into per-triple package
  directories before publish; publish the napi root + 5 per-triple
  packages BEFORE `@cleocode/worktree` so consumers can resolve them.
- `scripts/probes/worktree-napi-rayon-probe.mjs`: new probe that loads the
  napi binding, asserts the 5 required exports are present, and exercises
  the rayon parallel-copy hot-path against a tmp fixture. Returns exit-code
  1/2/3 for module-not-found / missing-exports / FFI-throw so CI can
  distinguish failure modes.

### Verification

Reproduced the bug locally by `npm pack`-ing the workspace, installing the
tarballs into `/tmp/t10178-install/`, then running the rayon probe with
`--prefix /tmp/t10178-install`. Before the fix: `MODULE_NOT_FOUND`. After
the fix: `PASS — rayon hot-path active`. 63/63 worktree tests pass.
