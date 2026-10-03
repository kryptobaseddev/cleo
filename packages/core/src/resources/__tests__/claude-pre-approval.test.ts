/**
 * Tests for the Claude Code pre-approval check behind the heavy-command hook's
 * `permissionDecision: "allow"` rewrite (T13124).
 *
 * The hook may only claim a command is pre-approved when Claude Code would run
 * it without a prompt, so most cases here pin a REFUSAL: anything wider than
 * Claude Code's documented allow-rule matching must not pass.
 *
 * @task T13124
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeBashRuleMatches, claudePreApproval } from '../heavy-command.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-pre-approval-'));
  mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('claudeBashRuleMatches', () => {
  it('follows the documented wildcard rules', () => {
    // A trailing ` *` matches the bare command and anything after a space.
    expect(claudeBashRuleMatches('pnpm test *', 'pnpm test')).toBe(true);
    expect(claudeBashRuleMatches('pnpm test *', 'pnpm test --run a.test.ts')).toBe(true);
    expect(claudeBashRuleMatches('pnpm test *', 'pnpm testing')).toBe(false);
    // `:*` equals a trailing ` *`.
    expect(claudeBashRuleMatches('pnpm test:*', 'pnpm test')).toBe(true);
    expect(claudeBashRuleMatches('pnpm test:*', 'pnpm test -- --run')).toBe(true);
    expect(claudeBashRuleMatches('npm run test:*', 'npm run test:unit')).toBe(false);
    // No space before `*`: a plain prefix.
    expect(claudeBashRuleMatches('ls*', 'lsof')).toBe(true);
    expect(claudeBashRuleMatches('ls *', 'lsof')).toBe(false);
    // No `*`: one exact command.
    expect(claudeBashRuleMatches('npm run build', 'npm run build')).toBe(true);
    expect(claudeBashRuleMatches('npm run build', 'npm run build --watch')).toBe(false);
    // Two wildcards: the bare form needs the text the rule requires.
    expect(claudeBashRuleMatches('* --help *', 'npm --help x')).toBe(true);
    expect(claudeBashRuleMatches('* --help *', 'npm --help')).toBe(false);
    // The bare `Bash` rule.
    expect(claudeBashRuleMatches('*', 'anything at all')).toBe(true);
    // Regex metacharacters in a rule are literal.
    expect(claudeBashRuleMatches('vitest run a.test.ts', 'vitest run aXtestXts')).toBe(false);
  });
});

describe('claudePreApproval', () => {
  const opts = () => ({ cwd: dir, workingDir: dir });
  const ok = (command: string, rules: readonly string[], o = opts()) =>
    claudePreApproval(command, rules, o);

  it('approves a command every subcommand of which an allow rule covers', () => {
    expect(ok('pnpm test', ['pnpm test *'])).toEqual({ approved: true });
    expect(ok('pnpm vitest run a.test.ts', ['pnpm vitest *'])).toEqual({ approved: true });
    expect(ok('pnpm test && pnpm exec tsc --noEmit', ['pnpm test *', 'pnpm exec tsc *'])).toEqual({
      approved: true,
    });
    expect(ok('pnpm test', ['*'])).toEqual({ approved: true });
  });

  it('accepts the narrow read-only forms Claude Code runs unprompted', () => {
    expect(ok('pnpm test 2>&1 | tail -50', ['pnpm test *'])).toEqual({ approved: true });
    expect(ok('pnpm test 2>/dev/null | grep -v PASS | wc -l', ['pnpm test *'])).toEqual({
      approved: true,
    });
    expect(ok('cd packages/core && pnpm test', ['pnpm test *'])).toEqual({ approved: true });
    expect(ok(`cd ${join(dir, 'packages')} && pnpm test`, ['pnpm test *'])).toEqual({
      approved: true,
    });
  });

  it('refuses a subcommand no rule covers', () => {
    const r = ok('pnpm test && rm -rf dist', ['pnpm test *']);
    expect(r).toEqual({ approved: false, reason: '`rm` is not approved by an allow rule' });
    expect(ok('pnpm test; curl https://x.example', ['pnpm test *']).approved).toBe(false);
    expect(ok('pnpm test | sh', ['pnpm test *']).approved).toBe(false);
    expect(ok('pnpm test\nrm x', ['pnpm test *']).approved).toBe(false);
    expect(ok('pnpm test', []).approved).toBe(false);
  });

  it('never lets a wildcard swallow an operator', () => {
    // `*` must not match across `&&`: the split happens first.
    expect(ok('pnpm test && rm -rf ~', ['pnpm *']).approved).toBe(false);
    // Quoted operators are words, so they stay inside one subcommand.
    expect(ok('pnpm test -t "a && b"', ['pnpm test *'])).toEqual({ approved: true });
  });

  it('refuses what Claude Code would prompt for regardless of rules', () => {
    const rules = ['pnpm test *', 'echo *'];
    for (const command of [
      'pnpm test > out.log', // a file redirect needs Edit approval
      'pnpm test < in.txt',
      'pnpm test &> /tmp/x',
      'pnpm test $(echo x)', // substitution
      'pnpm test `echo x`',
      'pnpm test "$FILE"', // expansion
      'FOO=1 pnpm test', // allow rules do not match past an unknown assignment
      'timeout 60 pnpm test', // no wrapper stripping (narrower than Claude Code)
      '(pnpm test)', // subshell
      'pnpm test &', // background job
      'pnpm test &&', // dangling operator
      'if true; then pnpm test; fi', // compound command
      'pnpm test <<EOF\nx\nEOF', // heredoc
      `pnpm test ${'a'.repeat(10_001)}`, // past the parse limit
      'pnpm test "unterminated',
    ]) {
      expect(ok(command, rules).approved, command).toBe(false);
    }
  });

  it('keeps a cd inside the working directory, once, and never before git', () => {
    const rules = ['pnpm test *', 'git status *'];
    expect(ok('cd .. && pnpm test', rules).approved).toBe(false);
    expect(ok('cd / && pnpm test', rules).approved).toBe(false);
    expect(ok('cd ~ && pnpm test', rules).approved).toBe(false);
    expect(ok('cd - && pnpm test', rules).approved).toBe(false);
    expect(ok('cd missing-dir && pnpm test', rules).approved).toBe(false);
    expect(ok('cd packages && cd core && pnpm test', rules).approved).toBe(false);
    expect(ok('cd packages && git status && pnpm test', rules).approved).toBe(false);
    // A symlink that leaves the working directory is outside it.
    const outside = mkdtempSync(join(tmpdir(), 'cleo-pre-approval-out-'));
    try {
      symlinkSync(outside, join(dir, 'escape'));
      expect(ok('cd escape && pnpm test', rules).approved).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts read-only commands only in their narrow form', () => {
    const rules = ['pnpm test *'];
    expect(ok('pnpm test | tail -n 20', rules).approved).toBe(true);
    expect(ok('pnpm test | grep -E "FAIL|Error"', rules).approved).toBe(true);
    expect(ok('pnpm test | tail /etc/passwd', rules).approved).toBe(false); // a path
    expect(ok('pnpm test | grep x ~/.ssh/id_rsa', rules).approved).toBe(false);
    expect(ok('pnpm test | grep x ..', rules).approved).toBe(false);
    expect(ok('pnpm test | grep x *.log', rules).approved).toBe(false); // a glob
    expect(ok('pnpm test | tee out.log', rules).approved).toBe(false); // not read-only
    // Outside the working directory, read-only forms are not accepted at all.
    const elsewhere = { cwd: tmpdir(), workingDir: dir };
    expect(claudePreApproval('pnpm test | tail -5', rules, elsewhere).approved).toBe(false);
  });

  it('refuses ANSI-C quoting, whose escapes hide the real argument (review HIGH-1)', () => {
    const rules = ['pnpm test *'];
    for (const command of [
      "pnpm test && cat $'\\x2fetc\\x2fpasswd'",
      "pnpm test && cat $'\\057etc\\057passwd'",
      "pnpm test | grep --file=$'\\x2fetc\\x2fpasswd' x",
      "pnpm test | grep -r secret $'\\x2e\\x2e'",
      "pnpm test && ls $'\\x2e\\x2e'",
      "cd $'\\x2e\\x2e' && pnpm test",
      "pnpm test $'--run'",
    ]) {
      expect(ok(command, rules).approved, command).toBe(false);
    }
  });

  it('refuses glob and brace characters outside quotes, even in a partly quoted word (review MED-2)', () => {
    const rules = ['pnpm test *'];
    for (const command of [
      'pnpm test && grep -r secret ""..*',
      'pnpm test | grep x ""*',
      'pnpm test | cat ""{..,.}',
      'pnpm test | grep x a?b',
      'pnpm test | grep x ab[c]',
      'pnpm test | grep -E ^FAIL', // zsh EXTENDED_GLOB
      'cd ""..* && pnpm test',
    ]) {
      expect(ok(command, rules).approved, command).toBe(false);
    }
    // Quoted or escaped, they are plain text.
    expect(ok('pnpm test | grep -E "^FAIL|x*"', rules).approved).toBe(true);
    expect(ok("pnpm test | grep 'a?b'", rules).approved).toBe(true);
    // Fail-closed: an escape is outside the strict grammar even when harmless.
    expect(ok('pnpm test | grep a\\*b', rules).approved).toBe(false);
  });

  it('still approves the plain and simply quoted forms agents use', () => {
    const rules = ['pnpm test *', 'pnpm vitest *', 'pnpm --filter *'];
    for (const command of [
      'pnpm test',
      'pnpm vitest run src/a.test.ts src/b.test.ts',
      'pnpm test 2>&1 | tail -50',
      'pnpm test > /dev/null 2>&1',
      'cd packages/core && pnpm vitest run src/x.test.ts',
      'pnpm --filter @cleocode/core exec vitest run "src/with space.test.ts"',
      'pnpm test -t \'a && b\' | grep -E "FAIL|Error" | wc -l',
      'pnpm test --reporter=verbose; pnpm test --run',
      'pnpm test | tail -n +5',
    ]) {
      expect(ok(command, rules), command).toEqual({ approved: true });
    }
  });

  it('needs the stage as written and its words alone to match the same rule', () => {
    // An exact rule does not cover the command with a redirect added.
    expect(ok('pnpm test 2>&1', ['pnpm test']).approved).toBe(false);
    expect(ok('pnpm test', ['pnpm test'])).toEqual({ approved: true });
  });
});

/**
 * Fail-closed property (T13124 review): no construct outside the strict
 * grammar can yield an approval, wherever it sits, even under rules whose
 * trailing `*` matches any text. Every construct is tried in every position,
 * then a seeded random mix of several at once.
 */
describe('claudePreApproval is fail-closed', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-pre-approval-fuzz-'));
    mkdirSync(join(dir, 'packages', 'core'), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Rules a permissive user might hold: each matches anything after its prefix. */
  const RULES = ['pnpm test *', 'pnpm test:*', 'grep *', 'cd *', 'echo *'];

  /** Constructs outside the strict grammar (each must forbid approval). */
  const CONSTRUCTS: readonly string[] = [
    "$'\\x2fetc\\x2fpasswd'", // ANSI-C escapes
    "$'\\057etc'",
    '$"locale"', // locale translation
    '\\/etc/passwd', // backslash escape
    'a\\ b',
    '"a\\"b"',
    '$HOME', // parameter expansion
    '$\u{7B}HOME}', // ${HOME}, spelled so no lint reads it as a template
    '$\u{7B}HOME:-/}',
    '"$HOME"',
    '$1',
    '$(cat /etc/passwd)', // command substitution
    '`id`',
    '"$(id)"',
    '<(id)', // process substitution
    '>(id)',
    '$((1+1))', // arithmetic expansion
    '*', // globs, bare and partly quoted
    '""*',
    '""..*',
    'a?b',
    '[ab]',
    'x[a]',
    '{a,b}', // brace expansion
    '""{..,.}',
    '{1..3}',
    '~', // tilde
    '~/.ssh/id_rsa',
    '~root',
    '!x', // history / negation
    '^x', // zsh EXTENDED_GLOB
    'a#b',
    '# comment', // comment
    '> out.txt', // redirections outside /dev/null and fds
    '>> /tmp/x',
    '< /etc/passwd',
    '2> err.log',
    '&> all.log',
    '<<< here',
    '<<EOF',
    '&', // background
    '|& cat',
    '(id)', // subshell
    '{ id; }',
    '\nid', // newline
    '\\\nid', // line continuation
    ';;',
  ];

  /** Where a construct can sit in an otherwise approvable line. */
  const POSITIONS: ReadonlyArray<(c: string) => string> = [
    (c) => `pnpm test ${c}`,
    (c) => `pnpm test --x=${c}`,
    (c) => `pnpm test${c}`,
    (c) => `pnpm test | grep ${c}`,
    (c) => `pnpm test && echo ${c}`,
    (c) => `pnpm test && ${c}`,
    (c) => `cd ${c} && pnpm test`,
    (c) => `${c} pnpm test`,
  ];

  it('no construct, in any position, yields an approval', () => {
    const opts = { cwd: dir, workingDir: dir };
    const approved: string[] = [];
    for (const c of CONSTRUCTS) {
      for (const at of POSITIONS) {
        const line = at(c);
        if (claudePreApproval(line, RULES, opts).approved) approved.push(line);
      }
    }
    expect(approved).toEqual([]);
  });

  it('nor does any random mix of them (seeded)', () => {
    let seed = 0x13124;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const SAFE = [
      'pnpm',
      'test',
      '--run',
      'src/a.test.ts',
      '"quoted words"',
      "'single'",
      '|',
      'grep',
      'FAIL',
      '&&',
      'echo',
      'ok',
    ];
    const opts = { cwd: dir, workingDir: dir };
    const approved: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const parts = ['pnpm', 'test'];
      const n = 1 + rand(5);
      for (let k = 0; k < n; k++) parts.push(SAFE[rand(SAFE.length)] as string);
      const c = CONSTRUCTS[rand(CONSTRUCTS.length)] as string;
      parts.splice(2 + rand(parts.length - 1), 0, c);
      const glued = rand(3) === 0;
      const line = glued ? parts.join(' ').replace(` ${c}`, c) : parts.join(' ');
      if (claudePreApproval(line, RULES, opts).approved) approved.push(line);
    }
    expect(approved).toEqual([]);
  });
});
