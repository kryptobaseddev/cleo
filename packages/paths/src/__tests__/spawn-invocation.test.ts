/**
 * T12618 — spawning CLIs on win32: resolved absolute path, `.cmd`/`.bat`
 * through cmd.exe with injection-safe quoting. The platform is injected, so
 * this runs on any host.
 *
 * cmd.exe is not available here, so the quoting is checked against a model
 * of its two relevant parse passes (caret escapes, with operators live only
 * when unescaped outside quotes) followed by MSVCRT argv splitting — the
 * route an argument takes into a batch file's program.
 */

import { win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { quoteCmdArg, resolveSpawnInvocation } from '../exec-path.js';

const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const GIT = 'C:\\Program Files\\Git\\cmd';
const env = {
  Path: `${GIT};${NPM}`,
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  ComSpec: 'C:\\Windows\\cmd.exe',
};
const present = new Set([win32.join(NPM, 'codex.cmd'), win32.join(GIT, 'git.exe')]);
const winOpts = { platform: 'win32' as const, env, isExecutable: (p: string) => present.has(p) };

/**
 * One cmd.exe caret pass: `^x` → `x`, quotes toggle a region in which carets
 * are literal. Throws if an operator is reached unescaped outside quotes —
 * that is exactly command injection.
 */
function cmdPass(line: string): string {
  let out = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (c === '"') {
      quoted = !quoted;
      out += c;
    } else if (!quoted && c === '^') {
      out += line[++i] ?? '';
    } else if (!quoted && '&|<>()'.includes(c)) {
      throw new Error(`live operator ${c} in ${line}`);
    } else {
      out += c;
    }
  }
  return out;
}

/** MSVCRT / CommandLineToArgvW splitting. */
function msvcrtArgv(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    let slashes = 0;
    while (line[i] === '\\') {
      slashes++;
      i++;
    }
    const c = line[i];
    if (c === '"') {
      cur += '\\'.repeat(Math.floor(slashes / 2));
      started = true;
      if (slashes % 2) cur += '"';
      else quoted = !quoted;
    } else {
      cur += '\\'.repeat(slashes);
      if (c === undefined) break;
      if (!quoted && (c === ' ' || c === '\t')) {
        if (started || cur) args.push(cur);
        cur = '';
        started = false;
      } else {
        cur += c;
        started = true;
      }
    }
  }
  if (started || cur) args.push(cur);
  return args;
}

/** What the batch file's program would receive for the tokens after the command. */
function roundTrip(args: string[]): string[] {
  const line = args.map(quoteCmdArg).join(' ');
  return msvcrtArgv(cmdPass(cmdPass(line)));
}

const HOSTILE = [
  'plain',
  'has space',
  'say "hi"',
  'a & calc.exe',
  'x | whoami > out.txt',
  'caret ^ here',
  '100%',
  '%PATH%',
  '%USERPROFILE%\\x',
  'C:\\path with space\\',
  'trailing\\\\',
  '"',
  '',
  '(sub) !bang! <in> ;,=',
];

describe('quoteCmdArg (T12618)', () => {
  it.each(HOSTILE)('round-trips %j with no live operator', (arg) => {
    expect(roundTrip([arg])).toEqual([arg]);
  });

  it('round-trips a whole hostile argv in order', () => {
    expect(roundTrip(HOSTILE)).toEqual(HOSTILE);
  });

  it('caret-escapes every metacharacter twice', () => {
    expect(quoteCmdArg('a b')).toBe('^^^"a^^^ b^^^"');
    expect(quoteCmdArg('%PATH%')).toBe('^^^"^^^%PATH^^^%^^^"');
  });

  it('refuses line breaks, which cmd.exe cannot carry', () => {
    expect(() => quoteCmdArg('line1\nline2')).toThrow(/E_UNSAFE_BATCH_ARG/);
    expect(() => quoteCmdArg('a\rb')).toThrow(/E_UNSAFE_BATCH_ARG/);
  });

  it('unescaped (the pre-fix form) would leave `&` live (red-on-broken)', () => {
    expect(() => cmdPass('codex a & calc.exe')).toThrow(/live operator &/);
  });
});

describe('resolveSpawnInvocation (T12618)', () => {
  it('.cmd: spawns %ComSpec% /d /s /c with the resolved path and quoted args', () => {
    const inv = resolveSpawnInvocation(
      'codex',
      ['--full-auto', 'C:\\Temp\\my prompt.txt'],
      winOpts,
    );
    expect(inv.file).toBe('C:\\Windows\\cmd.exe');
    expect(inv.windowsVerbatimArguments).toBe(true);
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const line = inv.args[3] as string;
    expect(line.startsWith('"') && line.endsWith('"')).toBe(true);
    // cmd /s strips the outer quotes; the rest must round-trip.
    const inner = line.slice(1, -1);
    const argv = msvcrtArgv(cmdPass(cmdPass(inner.slice(inner.indexOf(' ') + 1))));
    expect(argv).toEqual(['--full-auto', 'C:\\Temp\\my prompt.txt']);
    expect(cmdPass(inner.slice(0, inner.indexOf(' ')))).toBe(`${NPM}\\codex.cmd`);
  });

  it('.exe: spawns the resolved absolute path directly, args untouched', () => {
    expect(resolveSpawnInvocation('git', ['commit', '-m', 'a "b" & c'], winOpts)).toEqual({
      file: 'C:\\Program Files\\Git\\cmd\\git.exe',
      args: ['commit', '-m', 'a "b" & c'],
      windowsVerbatimArguments: false,
    });
  });

  it('bare name not on PATH: falls back to the name, no shell', () => {
    expect(resolveSpawnInvocation('missing', ['x'], winOpts)).toEqual({
      file: 'missing',
      args: ['x'],
      windowsVerbatimArguments: false,
    });
  });

  it('explicit .bat path is routed through cmd.exe', () => {
    const inv = resolveSpawnInvocation('D:\\tools\\run it.bat', ['a&b'], {
      ...winOpts,
      isExecutable: (p) => p === 'D:\\tools\\run it.bat',
    });
    expect(inv.windowsVerbatimArguments).toBe(true);
    expect(inv.args[3]).toContain('D:\\tools\\run^ it.bat');
  });

  it('POSIX is unchanged: bare name, literal args, no lookup', () => {
    expect(resolveSpawnInvocation('codex', ['a & b'], { platform: 'linux', env })).toEqual({
      file: 'codex',
      args: ['a & b'],
      windowsVerbatimArguments: false,
    });
  });
});
