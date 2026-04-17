# T861 Smoke Matrix — Parent Command Bare-Invocation Test

**Date**: 2026-04-17
**Build**: packages/cleo dist (development build)

## Parent Commands with subCommands — Bare Invocation Results

| Command | Before (exit code) | After (shows help) | Notes |
|---------|-------------------|-------------------|-------|
| `cleo admin` | exit 0, shows root help | exit 0, shows admin help | Fixed |
| `cleo cant` | exit 0, shows root help | exit 0, shows cant help | Fixed |
| `cleo complexity` | exit 0, shows root help | exit 0, shows complexity help | Fixed |
| `cleo conduit` | exit 0, shows root help | exit 0, shows conduit help | Fixed |
| `cleo decomposition` | exit 0, shows root help | exit 0, shows decomposition help | Fixed |
| `cleo diagnostics` | exit 0, shows root help | exit 0, shows diagnostics help | Fixed |
| `cleo implementation` | N/A (not wired) | N/A (deprecated, not in index.ts) | Dead code |
| `cleo migrate` | exit 0, shows root help | exit 0, shows migrate help | Fixed |
| `cleo specification` | N/A (not wired) | N/A (deprecated, not in index.ts) | Dead code |

## Commands with subCommands Already Having run() (Pre-existing, Verified)

| Command | Status |
|---------|--------|
| `cleo adapter` | HAS run() - shows adapter list |
| `cleo adr` | HAS run() |
| `cleo backup` | HAS run() |
| `cleo brain` | HAS run() |
| `cleo chain` | HAS run() |
| `cleo check` | HAS run({ cmd }) → showUsage |
| `cleo code` | HAS run() |
| `cleo compliance` | HAS run() |
| `cleo config` | HAS run({ cmd }) → showUsage |
| `cleo consensus` | HAS run() |
| `cleo context` | HAS run() |
| `cleo contribution` | HAS run() |
| `cleo daemon` | HAS run() |
| `cleo deps` | HAS run() |
| `cleo docs` | HAS run() |
| `cleo env` | HAS run() |
| `cleo gc` | HAS run() |
| `cleo history` | HAS run() |
| `cleo intelligence` | HAS run() |
| `cleo issue` | HAS run() |
| `cleo labels` | HAS run() |
| `cleo lifecycle` | HAS run() |
| `cleo memory` | HAS run() |
| `cleo nexus` | HAS run() |
| `cleo orchestrate` | HAS run() |
| `cleo otel` | HAS run({ cmd }) → showUsage |
| `cleo phase` | HAS run() |
| `cleo phases` | HAS run() (deprecated) |
| `cleo provider` | HAS run() |
| `cleo reason` | HAS run({ cmd }) → showUsage |
| `cleo relates` | HAS run({ cmd }) → showUsage |
| `cleo release` | HAS run({ cmd }) → showUsage |
| `cleo remote` | HAS run() |
| `cleo req` | HAS run({ cmd }) → showUsage |
| `cleo research` | HAS run({ cmd }) → showUsage |
| `cleo restore` | HAS run({ cmd }) → showUsage |
| `cleo sequence` | HAS run({ cmd }) → showUsage |
| `cleo session` | HAS run({ cmd }) → showUsage |
| `cleo skills` | HAS run() |
| `cleo snapshot` | HAS run({ cmd }) → showUsage |
| `cleo stats` | HAS run() |
| `cleo sticky` | HAS run({ cmd }) → showUsage |
| `cleo sync` | HAS run({ cmd }) → showUsage |
| `cleo testing` | HAS run({ cmd }) → showUsage |
| `cleo token` | HAS run({ cmd }) → showUsage |
| `cleo transcript` | HAS run({ cmd }) → showUsage |
| `cleo web` | HAS run({ cmd }) → showUsage |

## Registry params[] Coverage

| Metric | Count |
|--------|-------|
| Total operations | 270 |
| Operations with params[] | 270 |
| Coverage | 100% |
| Empty params (no params expected) | 134 |
| ops with full params including required | 136 |

## Test Suite Results

| Suite | Before | After |
|-------|--------|-------|
| Total passing | 8331 (baseline) | 8542 |
| Total failing | baseline | 2 (pre-existing from concurrent T832/T820) |
| Regressions introduced | 0 | 0 |
