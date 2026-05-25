# ADR-087: Release Pipeline Coherence

## Status

Accepted.

## Date

2026-05-25.

## Tasks

T10440, T10443, T10453, T10454.

## Context

The release pipeline had three coherence gaps:

1. worktree-napi prebuild artifacts were produced by a separate `worktree-napi-prebuild.yml` workflow and then assumed by `release.yml`, creating a race between two independently-triggered workflows.
2. `auto-tag-on-release-merge.yml` pushed a release tag from a GitHub Actions `GITHUB_TOKEN` context and expected that tag push to trigger `release.yml`; this is a fragile two-hop Actions chain.
3. The deployed `.github/workflows/release-prepare.yml` had drifted from the canonical `packages/core/templates/workflows/release-prepare.yml.tmpl` template. The T9860 parity gate accepted that drift through an eight-finding baseline.

## Decision

1. `release.yml` is the release-publish authority. It contains an in-run `prebuild` matrix, and the `release` job declares `needs: prebuild` before downloading the `worktree-napi-*` artifacts and publishing npm packages.
2. `worktree-napi-prebuild.yml` remains available for PR/path dogfood validation only. It is not part of the release publish chain.
3. `auto-tag-on-release-merge.yml` is retired to a manual-dispatch no-op. Release tags are created explicitly after the release-prepare PR merges, or `release.yml` is manually dispatched against an already-existing tag.
4. `.github/workflows/release-prepare.yml` must remain the rendered output of `packages/core/templates/workflows/release-prepare.yml.tmpl` using the cleocode defaults in `scripts/lint-deployed-template-parity.mjs`.
5. The deployed-template parity baseline is reset to zero findings; new drift is a regression.

## Current Trigger Contract

| Workflow | Trigger | Release role |
| --- | --- | --- |
| `release-prepare.yml` | `workflow_dispatch` | Preflight, cut `release/<version>`, run plan/version/changelog, open bump PR. |
| `release.yml` | push tag `v*` or manual `workflow_dispatch` | Build worktree-napi prebuilds, validate artifacts, build, publish npm packages, create GitHub Release, run post-deploy payload. |
| `worktree-napi-prebuild.yml` | PR/push path filters, tags, manual, merge queue | Dogfood validation only; not consumed by release publish. |
| `auto-tag-on-release-merge.yml` | manual only | Retired no-op documenting the old two-hop chain. |

## Forensic Evidence Captured

`gh run list --workflow=release.yml --limit 10` showed recent release runs failing in the `Build & Publish` job while all integrated prebuild jobs completed successfully in the newest inspected run:

- Run 26373649118 (`workflow_dispatch`, head `decf96b393c9d739c3dabc0f2607865f173d79bd`, 2026-05-24T21:47:48Z): `Prebuild linux-x64-gnu`, `linux-arm64-gnu`, `darwin-arm64`, and `win32-x64-msvc` all succeeded; `Build & Publish` failed; post-deploy was skipped.
- Run 26373649089 (tag push `v2026.5.121`, same head SHA): the same four prebuild jobs succeeded; `Build & Publish` failed; post-deploy was skipped.

Artifact audit for run 26373649118 found the required in-run artifact names and non-zero sizes:

| Artifact | Size bytes |
| --- | ---: |
| `worktree-napi-linux-x64-gnu` | 1191709 |
| `worktree-napi-linux-arm64-gnu` | 1134202 |
| `worktree-napi-darwin-arm64` | 1033942 |
| `worktree-napi-win32-x64-msvc` | 918173 |

The observed failure is therefore post-prebuild; it does not invalidate the integrated prebuild artifact flow.

## Consequences

- A release cannot publish unless the same workflow run produced and downloaded all required worktree-napi artifacts.
- The old auto-tag workflow cannot silently fail to trigger the downstream release workflow because it no longer runs on release PR merges.
- Release operators must perform an explicit tag push after the release-prepare PR merge.
- Template drift is no longer normalized by a baseline; the parity gate can be run in strict mode and must pass with zero findings.

## Validation

- `node scripts/lint-deployed-template-parity.mjs --strict`
- `node scripts/lint-deployed-template-parity.mjs --update-baseline`
- `gh run view 26373649118 --json jobs,...`
- `gh api repos/kryptobaseddev/cleo/actions/runs/26373649118/artifacts`
