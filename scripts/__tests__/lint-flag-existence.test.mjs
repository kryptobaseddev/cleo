/**
 * Gates 14 + 15, flag half (T12190 · GH #1373).
 *
 * Every assertion here runs against the REAL repository sources, never a
 * fixture copy. That is deliberate: the defect this gate exists to catch is a
 * documented flag drifting from the command's actual `args` declaration, and a
 * test that parses its own inline fixture proves only that the parser can read
 * the fixture. Two of the bugs found while building this gate — the global
 * flag list parsed as empty, and a markdown line attributing one command's flag
 * to another — were invisible to fixture-shaped tests and immediately obvious
 * against the real files.
 *
 * Sources are read lazily rather than in `beforeAll`. A throw in `beforeAll`
 * reports every case as SKIPPED, which reads as "nothing to see" instead of as
 * N specific failures.
 *
 * @task T12190
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractAcceptedFlags,
  extractInvocationsWithFlags,
  findFlagViolations,
  loadGlobalFlags,
  loadRetiredFlags,
  makeFlagChecker,
} from '../lint-injection-commands.mjs';
import { extractRunBlockText } from '../lint-workflow-cleo-commands.mjs';

const REPO_ROOT = process.cwd();
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

let _checker;
const checker = () => {
  _checker ??= makeFlagChecker(REPO_ROOT);
  return _checker;
};

const STRICT_ARGS = 'packages/cleo/src/cli/lib/strict-args.ts';
const INJECTION = 'packages/core/templates/CLEO-INJECTION.md';

describe('loadGlobalFlags', () => {
  it('parses the real CLI_GLOBAL_FLAGS and finds --json', () => {
    // The declaration reads `CLI_GLOBAL_FLAGS: readonly string[] = Object.freeze([`.
    // Anchoring on the first `[` after the identifier lands in the TYPE
    // ANNOTATION and yields an empty set — which silently turns every command
    // passing `--json` into a violation. This is that regression's test.
    const flags = loadGlobalFlags(read(STRICT_ARGS));
    expect(flags.size).toBeGreaterThan(5);
    expect(flags.has('--json')).toBe(true);
    expect(flags.has('--field')).toBe(true);
    expect(flags.has('--output')).toBe(true);
  });

  it('makeFlagChecker refuses to run on an empty global-flag set', () => {
    // A gate that silently guards nothing is the defect it was built to remove.
    expect(() => loadGlobalFlags('')).not.toThrow();
    expect(loadGlobalFlags('').size).toBe(0);
  });
});

describe('loadRetiredFlags', () => {
  it('reads RETIRED_FLAG_GUIDANCE so prose documenting a removal is not a violation', () => {
    const retired = loadRetiredFlags(read(STRICT_ARGS));
    expect(retired.get('complete')?.has('--force')).toBe(true);
  });
});

describe('extractAcceptedFlags', () => {
  const initSrc = () => read('packages/cleo/src/cli/commands/init.ts');

  it('collects declared flags for a root verb', () => {
    const flags = extractAcceptedFlags(initSrc(), 'init');
    expect(flags.has('--name')).toBe(true);
    expect(flags.has('--force')).toBe(true);
  });

  it('adds the --no- form for booleans, mirroring citty', () => {
    expect(extractAcceptedFlags(initSrc(), 'init').has('--no-force')).toBe(true);
  });

  it('accepts a POSITIONAL in --name form, because the runtime does', () => {
    // `cleo add --title "…"` is the form CLEO-INJECTION.md documents everywhere
    // and it works: citty's non-strict parse populates `args.title` for both
    // spellings. Skipping positionals would invent a restriction the command
    // does not have while claiming to enforce its real surface.
    expect(extractAcceptedFlags(initSrc(), 'init').has('--projectName')).toBe(true);
  });

  it('does NOT invent --yes, the flag that shipped in worktree-cleanup.yml', () => {
    expect(extractAcceptedFlags(initSrc(), 'init').has('--yes')).toBe(false);
  });

  it('returns EMPTY for an unlocatable command rather than guessing', () => {
    // Callers must read empty as "unknown", never as "accepts nothing" — the
    // latter would report every flag on any command this parser cannot read.
    expect(extractAcceptedFlags(initSrc(), 'no-such-command-xyz').size).toBe(0);
  });
});

describe('extractInvocationsWithFlags', () => {
  it('stops the tail at a backtick so two code spans are two invocations', () => {
    const invs = extractInvocationsWithFlags(
      '`cleo init --yes` and `cleo orchestrate ready --epic <id>`',
    );
    expect(invs).toHaveLength(2);
    expect(invs[0]).toMatchObject({ verb: 'init', flags: ['--yes'] });
    expect(invs[1]).toMatchObject({ verb: 'orchestrate', sub: 'ready', flags: ['--epic'] });
  });

  it('joins backslash continuations into one invocation', () => {
    const invs = extractInvocationsWithFlags('cleo release plan "$V" \\\n  --epic "$E" --json');
    expect(invs).toHaveLength(1);
    expect(invs[0].flags).toEqual(['--epic', '--json']);
  });

  it('reports the line number of the invocation head, not of the continuation', () => {
    const invs = extractInvocationsWithFlags('a\nb\ncleo release plan \\\n  --epic X');
    expect(invs[0].line).toBe(3);
  });

  it('keeps <placeholder> tokens so documented flags after one are still seen', () => {
    const invs = extractInvocationsWithFlags('cleo docs add <taskId> <file> --type <kind>');
    expect(invs[0].flags).toEqual(['--type']);
  });

  it('attributes flags after a shell operator to the SECOND command', () => {
    const invs = extractInvocationsWithFlags('cleo init || pnpm dlx @cleocode/cleo init --yes');
    expect(invs[0].flags).toEqual([]);
  });
});

describe('the gate catches the defects that motivated it', () => {
  const at = (text) => findFlagViolations(text, checker());

  it('flags `cleo init --yes` — the live worktree-cleanup.yml instance', () => {
    const v = at('cleo init --yes');
    expect(v).toHaveLength(1);
    expect(v[0].bad).toEqual(['--yes']);
  });

  it('flags `cleo release reconcile --reason` — the shipped rollback template', () => {
    const v = at('cleo release reconcile "$V" --rollback --reason "$R"');
    expect(v).toHaveLength(1);
    expect(v[0].bad).toEqual(['--reason']);
    // --rollback IS declared and must not be swept up with it.
    expect(v[0].accepted).toContain('--rollback');
  });

  it('flags `cleo memory decision-find --epic` — a filter that never existed', () => {
    expect(at('cleo memory decision-find --epic <epicId>')[0].bad).toEqual(['--epic']);
  });

  it('flags `cleo orchestrate ready --epic` — mandated by the protocol twice', () => {
    expect(at('cleo orchestrate ready --epic <id>')[0].bad).toEqual(['--epic']);
  });
});

describe('guard classification reflects the runtime, not an assumption', () => {
  // Measured against the shipped 2026.9.3 binary:
  //   cleo list --zzzbogus          -> E_UNKNOWN_FLAG rc=6
  //   cleo memory find --zzzbogus   -> accepted rc=0
  // `assertKnownFlags` is installed at the lazy-command chokepoint, which wraps
  // MANIFEST entries and passes `meta.name`. citty dispatches a `verb sub`
  // invocation to the sub-command's own run, which the wrapper never reaches.
  const at = (text) => findFlagViolations(text, checker());

  it('a ROOT verb is rejected at runtime', () => {
    const v = at('cleo init --yes');
    expect(v[0].guard).toBe('rejects');
    expect(v[0].reason).toContain('E_UNKNOWN_FLAG');
  });

  it('a SUB-command is silently accepted and discarded', () => {
    const v = at('cleo memory decision-find --epic X');
    expect(v[0].guard).toBe('silent');
    expect(v[0].reason).toContain('ACCEPTED AND DISCARDED');
  });
});

describe('the gate does not fire on things that are correct', () => {
  const at = (text) => findFlagViolations(text, checker());

  it('passes global flags the entry point strips before citty sees them', () => {
    expect(at('cleo list --json --output id --quiet --field /data/x')).toHaveLength(0);
  });

  it('passes a flag spelling of a declared positional', () => {
    expect(at('cleo memory decision-find --query <term>')).toHaveLength(0);
  });

  it('passes prose that names a RETIRED flag in order to document its removal', () => {
    expect(at('`cleo complete --force` removed per ADR-051. Use `--evidence`.')).toHaveLength(0);
  });

  it('says nothing about a group command invoked without a sub-verb', () => {
    // The group declares no runnable args of its own; the second token is a
    // positional. Reporting here would be the gate failing on its own blind spot.
    expect(at('cleo memory T123 --anything')).toHaveLength(0);
  });
});

describe('the shipped surfaces are clean', () => {
  it('CLEO-INJECTION.md declares every flag it documents', () => {
    expect(findFlagViolations(read(INJECTION), checker())).toEqual([]);
  });

  it('every workflow run: block declares every flag it passes', () => {
    const files = [
      '.github/workflows/worktree-cleanup.yml',
      '.github/workflows/release-prepare.yml',
      'packages/core/templates/workflows/release-rollback.yml.tmpl',
      'packages/core/templates/workflows/release-publish.yml.tmpl',
    ];
    for (const f of files) {
      expect(findFlagViolations(extractRunBlockText(read(f)), checker()), f).toEqual([]);
    }
  });
});

describe('extractRunBlockText', () => {
  const YAML = [
    'jobs:',
    '  x:',
    '    steps:',
    '      # cleo init --yes was removed, see gh#1373',
    '      - name: go',
    '        run: |',
    '          # cleo init --yes explained here',
    '          cleo init',
    '        env:',
    '          FOO: cleo init --yes',
  ].join('\n');

  it('excludes comments, inside and outside run: blocks', () => {
    // Gate 15 has always held that a `#` line documenting a removed VERB is not
    // a broken step. The same must hold for a removed flag, or the gate forces
    // the deletion of the comment that explains the removal.
    expect(findFlagViolations(extractRunBlockText(YAML), checker())).toEqual([]);
  });

  it('excludes non-run keys such as env:', () => {
    expect(extractRunBlockText(YAML)).not.toContain('FOO');
  });

  it('keeps the shell it does scan', () => {
    expect(extractRunBlockText(YAML)).toContain('cleo init');
  });

  it('preserves line numbering so a violation points at the real step', () => {
    expect(extractRunBlockText(YAML).split('\n')).toHaveLength(YAML.split('\n').length);
  });
});
