#!/usr/bin/env node
/**
 * @cleocode/animations demo CLI.
 *
 * Previews every primitive family in the terminal — generic spinners, canon
 * spinners, progress bars, and one-shot sparks. CommonJS so the shebang works
 * on every Node runtime without flags.
 *
 * Usage:
 *   cleocode-animations                  cycle through every primitive family
 *   cleocode-animations <name>           preview one spinner (generic OR canon)
 *   cleocode-animations spark <name>     play one spark and exit
 *   cleocode-animations progress         loop through all 3 progress styles
 *   cleocode-animations --list           list every registered primitive
 *   cleocode-animations --list-canon     list canon spinner aliases only
 *   cleocode-animations --list-sparks    list sparks only
 *   cleocode-animations --list-progress  list progress styles only
 *
 * Forked from gunnargray-dev/unicode-animations (MIT).
 */

const path = require('path');
const fs = require('fs');
const tty = require('tty');

const MODULES = {
  braille: 'braille.js',
  spark: 'spark.js',
  progress: 'progress.js',
};

function distPath(file) {
  return path.join(__dirname, '..', 'dist', 'src', file);
}

let pending;
try {
  for (const file of Object.values(MODULES)) {
    if (!fs.existsSync(distPath(file))) {
      console.error('@cleocode/animations: run `pnpm --filter @cleocode/animations build` first.');
      process.exit(1);
    }
  }
  pending = Promise.all([
    import(distPath(MODULES.braille)),
    import(distPath(MODULES.spark)),
    import(distPath(MODULES.progress)),
  ]);
} catch (err) {
  console.error('@cleocode/animations: failed to load the built module.', err);
  process.exit(1);
}

(async () => {
  const [brailleMod, sparkMod, progressMod] = await pending;

  const SPINNERS = brailleMod.spinners;
  const CANON = brailleMod.canonSpinners;
  const CANON_TO_GENERIC = brailleMod.CANON_TO_GENERIC;
  const SPARKS = sparkMod.sparks;
  const PROGRESS_STYLES = ['tapestry', 'cascade', 'refinery'];
  const renderProgressBar = progressMod.renderProgressBar;

  const spinnerNames = Object.keys(SPINNERS);
  const canonNames = Object.keys(CANON);
  const sparkNames = Object.keys(SPARKS);
  const args = process.argv.slice(2);

  // Color codes used by both list output (always to stdout) and the live
  // animation surface (TTY-only). When the destination is not a TTY (e.g.
  // piped to grep), `process.stdout.write` strips ANSI cleanly.
  const bold = '\x1B[1m';
  const dim = '\x1B[2m';
  const magenta = '\x1B[35m';
  const cyan = '\x1B[36m';
  const yellow = '\x1B[33m';
  const green = '\x1B[32m';
  const reset = '\x1B[0m';

  // ──────────────────────────────────────────────────────────────────────
  // --list family — pipe-safe, writes to stdout regardless of TTY state.
  // Handled BEFORE the TTY-only animation path so `cleocode-animations
  // --list | grep braille` works correctly.
  // ──────────────────────────────────────────────────────────────────────
  if (args[0] === '--list' || args[0] === '-l') {
    process.stdout.write(`\n${bold}@cleocode/animations${reset} ${dim}— primitives:${reset}\n\n`);
    process.stdout.write(`  ${bold}Spinners (generic) · ${spinnerNames.length}${reset}\n`);
    for (const name of spinnerNames) {
      const s = SPINNERS[name];
      process.stdout.write(`    ${magenta}${s.frames[0]}${reset}  ${name} ${dim}(${s.frames.length}f, ${s.interval}ms)${reset}\n`);
    }
    process.stdout.write(`\n  ${bold}Spinners (canon) · ${canonNames.length}${reset}\n`);
    for (const name of canonNames) {
      const s = CANON[name];
      const generic = CANON_TO_GENERIC[name];
      process.stdout.write(`    ${yellow}${s.frames[0]}${reset}  ${name} ${dim}→ ${generic}${reset}\n`);
    }
    process.stdout.write(`\n  ${bold}Sparks (one-shot) · ${sparkNames.length}${reset}\n`);
    for (const name of sparkNames) {
      const s = SPARKS[name];
      process.stdout.write(`    ${green}${s.frames[Math.floor(s.frames.length / 2)]}${reset}  ${name} ${dim}(${s.frames.length}f × ${s.interval}ms)${reset}\n`);
    }
    process.stdout.write(`\n  ${bold}Progress styles · ${PROGRESS_STYLES.length}${reset}\n`);
    for (const style of PROGRESS_STYLES) {
      process.stdout.write(`    ${cyan}${renderProgressBar(style, 0.5, 8)}${reset}  ${style}\n`);
    }
    process.stdout.write('\n');
    process.exit(0);
  }

  if (args[0] === '--list-canon') {
    for (const name of canonNames) process.stdout.write(`${name}\n`);
    process.exit(0);
  }
  if (args[0] === '--list-sparks') {
    for (const name of sparkNames) process.stdout.write(`${name}\n`);
    process.exit(0);
  }
  if (args[0] === '--list-progress') {
    for (const name of PROGRESS_STYLES) process.stdout.write(`${name}\n`);
    process.exit(0);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Below this line: animation paths that require a writable TTY for the
  // live frame replacement. If stdout is piped/redirected, fall back to
  // /dev/tty when available, otherwise print a one-line summary and exit
  // (matching the upstream's behavior for non-TTY usage).
  // ──────────────────────────────────────────────────────────────────────
  let out = process.stdout;
  if (!out.isTTY) {
    try {
      const fd = fs.openSync('/dev/tty', 'w');
      out = new tty.WriteStream(fd);
    } catch {
      console.log(
        `spinners: ${spinnerNames.length} · canon: ${canonNames.length} · sparks: ${sparkNames.length} · progress: ${PROGRESS_STYLES.length}`,
      );
      console.log('(no TTY — pipe to a terminal or run --list to see the registry)');
      process.exit(0);
    }
  }

  const hide = '\x1B[?25l';
  const show = '\x1B[?25h';
  out.write(hide);
  const cleanup = () => {
    try {
      out.write(show);
    } catch {}
  };
  process.on('SIGINT', () => {
    cleanup();
    out.write('\n');
    process.exit(0);
  });
  process.on('exit', cleanup);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      if (key[0] === 0x71 || key[0] === 0x03 || key[0] === 0x1b) {
        cleanup();
        out.write('\n');
        process.exit(0);
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // `cleocode-animations spark <name>` — play one spark and exit
  // ──────────────────────────────────────────────────────────────────────
  if (args[0] === 'spark') {
    const name = args[1];
    if (!name || !SPARKS[name]) {
      cleanup();
      out.write(`Usage: cleocode-animations spark <name>\nAvailable: ${sparkNames.join(', ')}\n`);
      process.exit(name ? 1 : 0);
    }
    const s = SPARKS[name];
    for (const frame of s.frames) {
      out.write(`\r\x1B[2K  ${green}${frame}${reset}  ${bold}${name}${reset}`);
      await new Promise((r) => setTimeout(r, s.interval));
    }
    out.write('\n');
    cleanup();
    process.exit(0);
  }

  // ──────────────────────────────────────────────────────────────────────
  // `cleocode-animations progress` — loop through every progress style
  // ──────────────────────────────────────────────────────────────────────
  if (args[0] === 'progress') {
    let t = 0;
    setInterval(() => {
      const lines = PROGRESS_STYLES.map((style) => {
        const ratio = (Math.sin(t * 0.05) + 1) / 2;
        const bar = renderProgressBar(style, ratio, 36);
        return `  ${cyan}${bar}${reset}  ${dim}${style}${reset}  ${Math.round(ratio * 100)}%`;
      });
      // Move cursor up to redraw all lines in place
      if (t > 0) out.write(`\x1B[${PROGRESS_STYLES.length}A`);
      out.write(`${lines.join('\n')}\n`);
      t++;
    }, 80);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────
  // `cleocode-animations <name>` — preview one spinner (generic OR canon)
  // ──────────────────────────────────────────────────────────────────────
  function resolveAny(name) {
    if (SPINNERS[name]) return { spinner: SPINNERS[name], color: magenta, label: name };
    if (CANON[name])
      return {
        spinner: CANON[name],
        color: yellow,
        label: `${name} ${dim}→ ${CANON_TO_GENERIC[name]}${reset}`,
      };
    return null;
  }

  if (args[0]) {
    const resolved = resolveAny(args[0]);
    if (!resolved) {
      cleanup();
      out.write(
        `Unknown name: "${args[0]}"\nRun --list to see every spinner / canon alias / spark / progress style.\n`,
      );
      process.exit(1);
    }
    let i = 0;
    setInterval(() => {
      const f = resolved.spinner.frames[i++ % resolved.spinner.frames.length];
      out.write(
        `\r\x1B[2K  ${resolved.color}${f}${reset}  ${bold}${resolved.label}${reset} ${dim}${resolved.spinner.interval}ms${reset}`,
      );
    }, resolved.spinner.interval);
    return;
  }

  // ──────────────────────────────────────────────────────────────────────
  // No arg — cycle through every spinner (generic + canon, deduped on object identity)
  // ──────────────────────────────────────────────────────────────────────
  const tour = [];
  for (const name of spinnerNames) tour.push({ kind: 'generic', name, spinner: SPINNERS[name] });
  for (const name of canonNames) tour.push({ kind: 'canon', name, spinner: CANON[name] });

  let current = 0;
  let i = 0;
  let ticksOnCurrent = 0;
  const TICKS_PER = 40;

  setInterval(() => {
    const entry = tour[current];
    const f = entry.spinner.frames[i % entry.spinner.frames.length];
    const tag = entry.kind === 'canon' ? `${yellow}canon${reset}` : `${magenta}generic${reset}`;
    const count = `${dim}[${current + 1}/${tour.length}]${reset}`;
    const label =
      entry.kind === 'canon'
        ? `${entry.name} ${dim}→ ${CANON_TO_GENERIC[entry.name]}${reset}`
        : entry.name;
    const color = entry.kind === 'canon' ? yellow : magenta;
    out.write(
      `\r\x1B[2K  ${color}${f}${reset}  ${tag}  ${bold}${label}${reset} ${dim}${entry.spinner.interval}ms${reset}  ${count}`,
    );
    i++;
    ticksOnCurrent++;
    if (ticksOnCurrent >= TICKS_PER) {
      ticksOnCurrent = 0;
      i = 0;
      current = (current + 1) % tour.length;
    }
  }, 80);
})();
