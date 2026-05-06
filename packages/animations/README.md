# @cleocode/animations

**Unicode terminal animations for the cleo CLI and CleoOS** — woven on the LOOM, gated by LAFS.

Provides four primitive surfaces, each gated by a single `AnimateContext` so the
LAFS protocol invariant ("JSON output is the default; human rendering requires
explicit opt-in") holds uniformly:

- **18 generic braille spinners** — frame-cycled loaders ported from
  [`unicode-animations`](https://github.com/gunnargray-dev/unicode-animations) (MIT, Gunnar Gray)
- **9 canon spinner aliases** — workshop vocabulary (`looming`, `weaving`, `heartbeat`, …) on the same frame data
- **3 progress bar styles** — `tapestry`, `cascade`, `refinery` (canon-themed segmented gauges)
- **4 sparks** — one-shot accents (`awaken`, `sweep`, `cascade`, `weave`)

[![npm](https://img.shields.io/npm/v/@cleocode/animations)](https://www.npmjs.com/package/@cleocode/animations)

## Install

```bash
pnpm add @cleocode/animations
# or
npm install @cleocode/animations
```

ESM-only. Requires Node ≥ 22.

## Quick start

### Spinner during async work — `createSpinnerHandle`

`createSpinnerHandle` is the canonical owner of `\r` writes for this package.
It manages the timer, hides/restores the cursor, installs an exit handler so
`Ctrl-C` doesn't leave a hidden cursor, and routes everything through the
LAFS render gate. **Calling `process.stdout.write` of a string starting with
`\r` outside this package is a contract violation** — always go through the
handle.

```ts
import { resolveOutputFormat } from '@cleocode/lafs';
import { createAnimateContext, createSpinnerHandle } from '@cleocode/animations';

const ctx = createAnimateContext({
  flagResolution: resolveOutputFormat({ humanFlag: true }),
});

const spinner = createSpinnerHandle(ctx, 'looming', 'Weaving tasks…');
spinner.start();
try {
  await doWork();
  spinner.stop('✔ Tapestry complete.');
} catch (err) {
  spinner.stop();
  throw err;
}
```

Under `--json` / `--quiet` / non-TTY / `NO_COLOR` the handle is a frozen no-op
and emits zero output — call sites stay branch-free.

### Progress bar with a known ratio

```ts
import { renderProgressBar } from '@cleocode/animations';

function tick(done: number, total: number) {
  const ratio = done / total;
  const bar = renderProgressBar('refinery', ratio, 36);
  process.stdout.write(`\r\x1B[2K  ${bar}  ${done}/${total}`);
}
```

### One-shot spark on success

```ts
import { sparks } from '@cleocode/animations';

async function playSpark(name: 'awaken' | 'sweep' | 'cascade' | 'weave') {
  const { frames, interval } = sparks[name];
  for (const f of frames) {
    process.stdout.write(`\r\x1B[2K  ${f}`);
    await new Promise(r => setTimeout(r, interval));
  }
  process.stdout.write('\n');
}

await shipRelease();
await playSpark('cascade');
```

## LAFS-aware rendering — `AnimateContext`

Every primitive routes through an `AnimateContext` so the package obeys the
LAFS protocol uniformly. The context is **pure data** — no I/O, no timers —
derived from the LAFS `FlagResolution` plus environment signals.

```ts
import { resolveOutputFormat } from '@cleocode/lafs';
import { createAnimateContext, createSpinnerHandle } from '@cleocode/animations';

const flags = resolveOutputFormat({ humanFlag: true });
const ctx = createAnimateContext({ flagResolution: flags });

// Hand `ctx` to any primitive — they all become no-ops when `ctx.enabled === false`.
const spinner = createSpinnerHandle(ctx, 'looming', 'Loading…');

if (!ctx.enabled) {
  // ctx.reason ∈ 'format-json' | 'quiet' | 'no-tty' | 'no-color' | 'enabled'
  console.log(`silent: ${ctx.reason}`);
}
```

| Signal | Source | Effect | `reason` |
|---|---|---|---|
| `format !== 'human'` | LAFS flags | Disable (machine output) | `format-json` |
| `quiet === true` | LAFS flags | Disable (script-friendly) | `quiet` |
| `!isTTY` | `process.stdout.isTTY` | Disable (piped/redirected) | `no-tty` |
| `NO_COLOR` set | `process.env.NO_COLOR` | Disable ([no-color.org](https://no-color.org)) | `no-color` |

`SILENT_CONTEXT` is exported as a frozen always-disabled context for tests and
libraries that want to opt out without constructing a full LAFS resolution.

## Spinner registry

### Generic — 18 braille loaders

| Name | Frames | Interval | Name | Frames | Interval |
|---|---|---|---|---|---|
| `braille` | 10 | 80ms | `cascade` | 14 | 60ms |
| `braillewave` | 8 | 100ms | `columns` | 26 | 60ms |
| `dna` | 12 | 80ms | `orbit` | 8 | 100ms |
| `scan` | 10 | 70ms | `breathe` | 17 | 100ms |
| `rain` | 12 | 100ms | `waverows` | 16 | 90ms |
| `scanline` | 6 | 120ms | `checkerboard` | 4 | 250ms |
| `pulse` | 5 | 180ms | `helix` | 16 | 80ms |
| `snake` | 16 | 80ms | `fillsweep` | 11 | 100ms |
| `sparkle` | 6 | 150ms | `diagswipe` | 16 | 60ms |

### Canon — 9 workshop aliases

| Canon name | → Generic | Cleo lore role |
|---|---|---|
| `looming` | `helix` | Twin strands weaving — task on the LOOM |
| `weaving` | `braillewave` | Pattern threading across columns |
| `heartbeat` | `breathe` | Organic in-out pulse — Hearth presence |
| `awakening` | `pulse` | Radial bloom — first dream / `cleo init` |
| `sweeping` | `scan` | Left→right beam — BRAIN integrity Sweep |
| `watching` | `orbit` | Circular sentinel — sentient daemon tick |
| `cascade` | `cascade` | Diagonal fall — command-success accent |
| `tapestry` | `waverows` | Multi-row sinusoidal — wave of tasks shipping |
| `refinery` | `columns` | Filling stages — memory promotion pipeline |

Canon entries are **aliases**, not copies — they reference the same `Spinner`
objects as the generic registry. Renaming a generic spinner automatically
updates the canon view. The mapping is exposed as `CANON_TO_GENERIC` and
`resolveSpinner(name)` accepts either form.

## Progress bars

`renderProgressBar(style, ratio, width)` returns a fixed-width string. Three
canon styles:

| Style | Characters | Feel |
|---|---|---|
| `tapestry` | `░ ▒ ▓ █` | Coarse blocks — woven cloth filling cell-by-cell |
| `cascade` | `▏ ▎ ▍ ▌ ▋ ▊ ▉ █` | 1/8 gradient steps — smooth waterfall edge |
| `refinery` | `⠀ ⡀ ⡄ ⡆ ⡇ ⣇ ⣧ ⣷ ⣿` | Braille block stages — BRAIN memory promotion pipeline |

Inputs outside `[0, 1]` are clamped. `width` ≤ 0 returns `''`.

## Sparks — one-shot accents

```ts
import { sparks, sparkDurationMs } from '@cleocode/animations';

sparkDurationMs('cascade'); // → ~980ms (frames * interval)
```

| Spark | Frames | Duration | Played on |
|---|---|---|---|
| `awaken` | 13 × 90ms | ~1.17s | `cleo init` · first dream · sentient wake |
| `sweep` | 7 × 80ms | ~560ms | BRAIN integrity sweep complete |
| `cascade` | 14 × 70ms | ~980ms | Release shipped · task complete |
| `weave` | 18 × 70ms | ~1.26s | Playbook stage transition · CANT directive accepted |

## Browser demo

A self-contained vitrine page lives at `scripts/demo.html`. Open it in any
browser to preview every spinner, canon alias, progress style, and spark
animating live, with API reference tables and code samples.

```bash
# After cloning the repo:
open packages/animations/scripts/demo.html        # macOS
xdg-open packages/animations/scripts/demo.html    # Linux
```

The page is fully self-contained (no build step, no fetch, no node_modules) so
it can be emailed or hosted as a static asset for design reviews.

## Terminal demo

```bash
npx cleocode-animations              # cycle through every spinner
npx cleocode-animations looming      # preview a single spinner
npx cleocode-animations --list       # list every registered spinner
```

## API surface

### Spinners

| Export | Type |
|---|---|
| `spinners` | `Record<BrailleSpinnerName, Spinner>` |
| `canonSpinners` | `Record<CanonSpinnerName, Spinner>` |
| `CANON_TO_GENERIC` | `Record<CanonSpinnerName, BrailleSpinnerName>` |
| `resolveSpinner(name)` | `(string) => Spinner \| undefined` |
| `gridToBraille(grid)` | `(boolean[][]) => string` |
| `makeGrid(rows, cols)` | `(number, number) => boolean[][]` |
| `Spinner` | `{ frames: readonly string[]; interval: number }` |
| `BrailleSpinnerName` · `CanonSpinnerName` | TS string-literal unions |

### SpinnerHandle (canonical `\r` owner)

| Export | Type |
|---|---|
| `createSpinnerHandle(ctx, name, label, options?)` | `(AnimateContext, name, string, SpinnerHandleOptions?) => SpinnerHandle` |
| `SpinnerHandle` | `{ start(); stop(finalLine?); update(label); enabled: boolean }` |
| `SpinnerHandleOptions` | `{ delayMs?: number }` — defaults to `150` |

### AnimateContext

| Export | Type |
|---|---|
| `createAnimateContext(input)` | `(AnimateContextInput) => AnimateContext` |
| `SILENT_CONTEXT` | Frozen `AnimateContext` — always disabled |
| `AnimateContext` | `{ enabled, reason, inputs }` |
| `AnimateContextInput` | `{ flagResolution, isTTY?, noColor? }` |
| `FlagResolutionLike` | `{ format: 'json' \| 'human'; quiet: boolean }` |

### Progress + Sparks

| Export | Type |
|---|---|
| `progressBars` | `Record<ProgressBarStyle, ProgressBarRenderer>` |
| `renderProgressBar(style, ratio, width)` | `(style, number, number) => string` |
| `ProgressBarStyle` | `'tapestry' \| 'cascade' \| 'refinery'` |
| `sparks` | `Record<SparkName, Spark>` |
| `sparkDurationMs(name)` | `(SparkName) => number` |
| `SparkName` | `'awaken' \| 'sweep' \| 'cascade' \| 'weave'` |

## Custom spinners

Every animation here is built from two primitives — compose your own:

```ts
import { gridToBraille, makeGrid } from '@cleocode/animations';

const grid = makeGrid(4, 4);
grid[0][0] = true;
grid[1][1] = true;
grid[2][2] = true;
grid[3][3] = true;

console.log(gridToBraille(grid)); // diagonal braille pattern
```

`makeGrid(rows, cols)` returns a `boolean[][]`. Set cells to `true` to raise
braille dots. `gridToBraille(grid)` packs them into a braille string (2 dot
columns per character, U+2800 base).

## License

MIT — dual copyright:

- © 2024 Gunnar Gray (original `unicode-animations` project)
- © 2026 CLEO Code (`@cleocode/animations` fork)

See `LICENSE`.
