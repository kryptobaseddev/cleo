# T9087 — Fix scaffold.ts cleanEnv git identity fallback

## Summary

Fixed `ensureProjectGitInitialCommit` in `packages/core/src/scaffold.ts` (lines 898-914).

## Root Cause

The read-check for `user.email` / `user.name` used plain `git config user.email` (no scope flag).
While this command searches all config scopes (local → global → system), it requires `HOME` to be
set in the executing process environment so git can locate `~/.gitconfig`. In environments where
`HOME` is absent from `process.env`, git cannot find the global config and exits non-zero — causing
the fallback to unconditionally write `cleo@local / CLEO` to the project's `.git/config` even when
a valid global identity exists.

## Fix

Replaced the single-scope check with an explicit two-scope helper `hasIdentity()`:

1. `git config --global <field>` using `process.env` (real env, preserves HOME)
2. `git config --local <field>` using the cleaned env (no GIT_DIR leak)

The fallback write only fires when BOTH scopes return nothing — i.e. on true CI/container systems
with no git identity at all. The fallback values (`cleo@local`, `CLEO`) are unchanged.

## Lines Changed

- `packages/core/src/scaffold.ts` lines 898-915 (original) → 898-944 (new)

## Notes on Lines 831-832

`ensureCleoGitRepo` (lines 831-832) always writes `cleo@local / CLEO` to `.cleo/.git/config` (the
isolated CLEO checkpoint repo, not the project repo). This is intentional and was not changed.

## Commit

`334e537dec90fa71d907b9c34959e43a7e330a7d` on branch `task/T9087`

## Acceptance Criteria Status

- [x] Read check uses real env with HOME preserved (`process.env` passed to `--global` check)
- [x] Fallback only writes when no global or local identity exists (two-scope check)
- [x] No regression in CI/container path (local scope still checked as fallback)
