#!/usr/bin/env node
/**
 * @cleocode/animations demo CLI.
 *
 * Cycles through every registered spinner in the terminal. CommonJS so that the
 * shebang works without `--experimental-loader` flags on older Node runtimes.
 *
 * Usage:
 *   cleocode-animations              cycle through all spinners
 *   cleocode-animations <name>       preview one spinner
 *   cleocode-animations --list       list all spinners
 *
 * Forked from gunnargray-dev/unicode-animations (MIT).
 */

const path = require('path');
const fs = require('fs');
const tty = require('tty');

let registry;
try {
  // The ESM build is loaded via dynamic import below so that this CJS shim
  // does not need a CJS build artifact. We resolve the dist path eagerly to
  // surface a clear error if the package was never built.
  const distPath = path.join(__dirname, '..', 'dist', 'src', 'braille.js');
  if (!fs.existsSync(distPath)) {
    console.error('@cleocode/animations: run `pnpm --filter @cleocode/animations build` first.');
    process.exit(1);
  }
  // eslint-disable-next-line no-undef
  registry = import(distPath);
} catch (err) {
  console.error('@cleocode/animations: failed to load the built module.', err);
  process.exit(1);
}

(async () => {
  const mod = await registry;
  const S = mod.spinners || mod.default;
  const names = Object.keys(S);
  const args = process.argv.slice(2);

  let out = process.stdout;
  if (!out.isTTY) {
    try {
      const fd = fs.openSync('/dev/tty', 'w');
      out = new tty.WriteStream(fd);
    } catch {
      console.log(`${names.length} spinners: ${names.join(', ')}`);
      process.exit(0);
    }
  }

  const hide = '\x1B[?25l';
  const show = '\x1B[?25h';
  const bold = '\x1B[1m';
  const dim = '\x1B[2m';
  const magenta = '\x1B[35m';
  const reset = '\x1B[0m';

  out.write(hide);
  const cleanup = () => { try { out.write(show); } catch {} };
  process.on('SIGINT', () => { cleanup(); out.write('\n'); process.exit(0); });
  process.on('exit', cleanup);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (key) => {
      if (key[0] === 0x71 || key[0] === 0x03 || key[0] === 0x1B) {
        cleanup();
        out.write('\n');
        process.exit(0);
      }
    });
  }

  if (args[0] === '--list' || args[0] === '-l') {
    cleanup();
    out.write(`\n${bold}${names.length} spinners available:${reset}\n\n`);
    for (const name of names) {
      const s = S[name];
      out.write(`  ${magenta}${s.frames[0]}${reset}  ${name} ${dim}(${s.frames.length} frames, ${s.interval}ms)${reset}\n`);
    }
    out.write('\n');
    process.exit(0);
  }

  if (args[0] && !names.includes(args[0])) {
    cleanup();
    out.write(`Unknown spinner: "${args[0]}"\nRun with --list to see all spinners.\n`);
    process.exit(1);
  }

  let current = args[0] ? names.indexOf(args[0]) : 0;
  const single = !!args[0];
  let i = 0;
  let ticksOnCurrent = 0;

  const TICKS_PER_SPINNER = 40;

  setInterval(() => {
    const name = names[current];
    const s = S[name];
    const frame = s.frames[i % s.frames.length];
    const count = single ? '' : `${dim}[${current + 1}/${names.length}]${reset}`;

    out.write(`\r\x1B[2K  ${magenta}${frame}${reset}  ${bold}${name}${reset} ${dim}${s.interval}ms${reset}  ${count}`);

    i++;
    ticksOnCurrent++;

    if (!single && ticksOnCurrent >= TICKS_PER_SPINNER) {
      ticksOnCurrent = 0;
      i = 0;
      current = (current + 1) % names.length;
    }
  }, 80);
})();
