# Changelog

All notable changes to `@cleocode/animations` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow the **monorepo-wide CalVer** (`YYYY.M.PATCH`) — the version
shipped on npm is set by the git tag at release time via
`.github/workflows/release.yml`. **Do not bump `package.json` by hand.**

## [2026.5.29] — initial release

Initial published version. The 2026.5.29 line on npm has three patches
because trusted-publisher setup required claiming the package name manually
before the OIDC pipeline could take over; subsequent `2026.5.30` and
`2026.5.31` patches were also hand-published while iterating on the API
surface. From the next monorepo release tag onward, the central pipeline
drives every version bump.

### Added
- Initial port of [`gunnargray-dev/unicode-animations`](https://github.com/gunnargray-dev/unicode-animations) (MIT)
  into `packages/animations/` as a workspace package.
- 18 braille spinner animations: 3 hand-curated single-char classics
  (`braille`, `braillewave`, `dna`) + 15 procedurally generated grid
  animations (`scan`, `rain`, `pulse`, `helix`, `cascade`, `orbit`, …).
- Grid utilities `gridToBraille(grid)` and `makeGrid(rows, cols)` for
  composing custom braille animations.
- **Canon spinner aliases** — 9 workshop-vocabulary names pointing at the
  same `Spinner` objects as the generic registry (aliases, not copies):
  `looming → helix`, `weaving → braillewave`, `heartbeat → breathe`,
  `awakening → pulse`, `sweeping → scan`, `watching → orbit`,
  `cascade → cascade`, `tapestry → waverows`, `refinery → columns`.
  Exposed as `canonSpinners`, `CANON_TO_GENERIC`, `resolveSpinner(name)`.
- **`AnimateContext`** — pure-data render gate consumed by every primitive.
  Disables animations when `format !== 'human'`, `quiet`, `!isTTY`, or
  `NO_COLOR`. Carries `reason` for diagnostics. `SILENT_CONTEXT` exported
  as a frozen always-disabled context.
- **Progress bar primitives** — three canon styles via
  `renderProgressBar(style, ratio, width)`:
  - `tapestry` — coarse Unicode blocks (`░▒▓█`)
  - `cascade` — 1/8 gradient steps (`▏▎▍▌▋▊▉█`)
  - `refinery` — braille block stages (`⠀⡀⡄⡆⡇⣇⣧⣷⣿`)
- **Spark primitives** — 4 one-shot canon flares: `awaken`, `sweep`,
  `cascade`, `weave`. Helper `sparkDurationMs(name)`.
- **`createSpinnerHandle(ctx, name, label, options?)`** — the canonical
  owner of `\r` writes for this package. Wraps a `Spinner` with a managed
  timer, cursor hide/show, exit-handler restoration, idempotent `start()` /
  `stop()`, and `update(label)`. Returns a frozen no-op handle when
  `AnimateContext.enabled` is `false`.
- **`scripts/demo.html`** — Cleo-themed self-contained vitrine page (open
  in any browser, no build step). Previews every primitive animating live,
  with API tables, code samples, and a light/dark theme toggle.
- **`scripts/demo.cjs`** (`cleocode-animations` bin) — terminal preview CLI
  covering generic + canon spinners, sparks, and progress bars. Subcommands:
  `--list` / `--list-canon` / `--list-sparks` / `--list-progress` /
  `spark <name>` / `progress`.
- **`exports` map subpaths** for every public module —
  `./animate-context`, `./progress`, `./spark`, `./spinner-handle`,
  `./braille`, `./package.json` — for tree-shaking and discoverability.
- **`README.md`** — install, quick start, AnimateContext, registries,
  canon mapping, full API surface, custom-spinner recipe, attribution.
- 150 tests covering frame-data snapshots, canon contract, AnimateContext
  precedence, progress-bar boundaries, spark decay, and SpinnerHandle
  idempotency / cursor management / context-disabled no-op behavior.
- LICENSE: MIT, dual-copyright (Gunnar Gray + CLEO Code).
- ESM-only, built via `tsc -p tsconfig.build.json` (matches monorepo
  conventions; dropped upstream's `tsup` + CJS/IIFE bundling).
- Wired into `.github/workflows/release.yml` (version-sync iterator and
  publish chain, positioned between `git-shim` and `core`) and
  `scripts/execute-payload.mjs` (`PUBLISHED_PACKAGES` list).

[2026.5.29]: https://www.npmjs.com/package/@cleocode/animations/v/2026.5.29
