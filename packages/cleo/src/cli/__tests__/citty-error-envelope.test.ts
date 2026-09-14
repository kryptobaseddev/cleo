/**
 * Regression tests for gh#1391 — three defects in the citty-error envelope path.
 *
 * Measured on 2026.9.1 with `cleo issue "a bare title probe"` (`issue` is a real
 * command; the quoted string is not one of its four subcommands):
 *
 * ```json
 * {"success":false,
 *  "error":{"code":1,
 *    "message":"Unknown command \x1b[36ma bare title probe\x1b[39m",
 *    "codeName":"E_E_UNKNOWN_COMMAND",
 *    "fix":"Run 'cleo <command> --help' to see required arguments."}}
 * ```
 *
 * 1. **`E_E_UNKNOWN_COMMAND`** — the prefix was applied unconditionally as
 *    `` `E_${code}` ``. Citty's codes are not uniformly prefixed: `EARG` is bare
 *    and `E_UNKNOWN_COMMAND` already carries the prefix. Agents branch on
 *    `codeName`, so a lookup table built from the docs misses the doubled name.
 *
 * 2. **Raw ANSI inside a JSON envelope field.** ADR-086 makes stdout exactly one
 *    parseable envelope; escape bytes mid-string defeat that, and they land
 *    verbatim in any log or task description an agent writes the message into.
 *    The comment at the callsite already guarded against citty's usage BLOCK
 *    reaching stdout and missed that its MESSAGE carries colour.
 *
 * 3. **A `fix` that withholds what the command knows.** Every citty error got
 *    the same note about required arguments, including the case where the
 *    caller named a group correctly and a verb wrongly — where the actionable
 *    hint is the verb list.
 *
 * ## Why these test the helpers rather than spawning the CLI
 *
 * The three defects are pure string transforms on the error's `code` and
 * `message`. Spawning `cleo` to observe them would test the process harness —
 * startup, envelope funnel, teardown — none of which is the subject, and would
 * turn a sub-millisecond assertion into seconds of process launch per case.
 *
 * ## Why this file contains no literal ESC byte
 *
 * The first draft did - seven of them, because the editor wrote the
 * escape as an actual control character. A test asserting that control
 * characters are stripped, carrying control characters in its own source,
 * is the same shape as the defects it covers. They are source escapes now,
 * verified by COUNTING chr(27) occurrences rather than by looking at the
 * file - a literal ESC is invisible in every renderer, which is exactly
 * why it survived the first read.
 *
 * @task T12184 (gh#1391)
 */

import { describe, expect, it } from 'vitest';
import { cittyErrorCodeName, cittyErrorFix, stripAnsi } from '../citty-error-envelope.js';

describe('gh#1391 — codeName is prefixed exactly once', () => {
  it('does not double a code that already carries E_', () => {
    // THE regression. Before the fix this returned 'E_E_UNKNOWN_COMMAND'.
    expect(cittyErrorCodeName('E_UNKNOWN_COMMAND')).toBe('E_UNKNOWN_COMMAND');
  });

  it('prefixes a bare citty code', () => {
    expect(cittyErrorCodeName('ESOMETHING')).toBe('E_ESOMETHING');
  });

  it('keeps the explicit EARG mapping', () => {
    // `E_EARG` would be a name nothing documents either, so EARG is mapped
    // rather than prefixed.
    expect(cittyErrorCodeName('EARG')).toBe('E_VALIDATION');
  });

  it('never produces a doubled prefix for any input', () => {
    for (const code of ['EARG', 'E_UNKNOWN_COMMAND', 'ESOMETHING', 'E_FOO', 'X']) {
      expect(cittyErrorCodeName(code)).not.toMatch(/^E_E_/);
    }
  });
});

describe('gh#1391 — the envelope message carries no ANSI', () => {
  it('strips the SGR sequences citty wraps around the offending token', () => {
    const cittyMessage = 'Unknown command \u001b[36ma bare title probe\u001b[39m';

    // Assert on the CHARACTER, not on a rendering of it: a test that compared
    // against a literal with escapes could pass while escapes survived.
    expect(cittyMessage).toContain('\u001b');
    expect(stripAnsi(cittyMessage)).toBe('Unknown command a bare title probe');
    expect(stripAnsi(cittyMessage)).not.toContain('\u001b');
  });

  it('leaves text without escapes untouched', () => {
    expect(stripAnsi('Missing required argument: taskId')).toBe(
      'Missing required argument: taskId',
    );
  });

  it('handles several sequences and bare resets', () => {
    expect(stripAnsi('\u001b[1m\u001b[31mred bold\u001b[0m tail')).toBe('red bold tail');
  });

  it('is a no-op on the empty string', () => {
    expect(stripAnsi('')).toBe('');
  });
});

describe('gh#1391 — the fix line matches the failure', () => {
  it('an unknown subcommand is told to list subcommands, not to check arguments', () => {
    const fix = cittyErrorFix('E_UNKNOWN_COMMAND');
    expect(fix).toMatch(/subcommand/i);
    // The caller named a group correctly and a verb wrongly; a note about
    // required ARGUMENTS sends them to the wrong part of the help.
    expect(fix).not.toMatch(/required arguments/);
  });

  it('names a concrete worked example so the shape is unambiguous', () => {
    expect(cittyErrorFix('E_UNKNOWN_COMMAND')).toContain('cleo issue --help');
  });

  it('other citty errors keep the argument hint', () => {
    expect(cittyErrorFix('EARG')).toMatch(/required arguments/);
    expect(cittyErrorFix('ESOMETHING')).toMatch(/required arguments/);
  });
});
