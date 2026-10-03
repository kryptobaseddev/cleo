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
      expect(ok(command, rules), command).toEqual({
        approved: false,
        reason: "it has ANSI-C quoting ($'…')",
      });
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
    expect(ok('pnpm test | grep a\\*b', rules).approved).toBe(true);
  });

  it('needs the stage as written and its words alone to match the same rule', () => {
    // An exact rule does not cover the command with a redirect added.
    expect(ok('pnpm test 2>&1', ['pnpm test']).approved).toBe(false);
    expect(ok('pnpm test', ['pnpm test'])).toEqual({ approved: true });
  });
});
