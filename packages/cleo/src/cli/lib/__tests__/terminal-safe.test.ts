/**
 * `terminalSafe` / `terminalSafeLines` (T13295): server-supplied text loses
 * every escape sequence, control and bidi override before a terminal sees it.
 *
 * @task T13295
 */

import { describe, expect, it } from 'vitest';
import { terminalSafe, terminalSafeLines } from '../terminal-safe.js';

/** A device name another account could register: clear screen, an OSC 8 link, C1 CSI/OSC, RLO, a forged line. */
const PLANTED =
  'evil\x1b[2J\x1b]8;;https://attacker.test\x07click\x1b]8;;\x1b\\\x9b31m\x9d0;pwned\x07\u202etxt.exe\nwarning: forged';

describe('terminalSafe (T13295)', () => {
  it('drops CSI, OSC 8 (BEL and ST), C1 CSI/OSC and bidi overrides, keeps the text', () => {
    expect(terminalSafe(PLANTED)).toBe('evilclicktxt.exe warning: forged');
  });

  it('a value cannot forge a line: tabs and line breaks become one space', () => {
    expect(terminalSafe('a\r \n\tb')).toBe('a b');
    expect(terminalSafeLines('a\nb')).toBe('a\nb');
  });

  it('strips DCS/APC strings, two-byte escapes, other C0, DEL and lone C1 bytes', () => {
    expect(terminalSafe('a\x1bP1;2|data\x1b\\b\x1bc\x1b_apc\x1b\\')).toBe('ab');
    expect(terminalSafe('a\x00\x07\x08\x7f\x85\x9cb')).toBe('ab');
    expect(terminalSafe('x\u2066y\u2069\u202az')).toBe('xyz');
  });

  it('strips the direction marks and folds the Unicode line separators (#1958 LOW-2)', () => {
    expect(terminalSafe('a\u200eb\u200fc\u061cd')).toBe('abcd');
    expect(terminalSafe('a\u2028b\u2029c')).toBe('a b c');
    expect(terminalSafeLines('a\u2028b')).toBe('a\nb');
  });

  it('leaves ordinary text, punctuation and non-Latin scripts alone', () => {
    const plain = 'Dev’s MacBook — café 日本 (arm64) [ok] ~/proj';
    expect(terminalSafe(plain)).toBe(plain);
    expect(terminalSafeLines(plain)).toBe(plain);
  });
});
