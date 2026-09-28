/**
 * Regression tests for CLEO-INJECTION.md content (T778).
 *
 * Asserts that the CLEO protocol template file contains required content
 * and uses correct command forms, protecting against accidental simplification
 * or command-form drift.
 *
 * Checks:
 * - Contains `cleo memory observe` (not bare `cleo observe`)
 * - Contains `cleo orchestrate start` in Session Start section
 * - Contains "Memory Protocol (JIT)" H2 section
 * - Contains "Escalation" H2 section
 * - At least 6 distinct `cleo <verb>` command patterns
 *
 * @task T778
 * @injectable-file /home/keatonhoskins/.local/share/cleo/templates/CLEO-INJECTION.md
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Resolve the CLEO-INJECTION.md template from the in-repo source of truth.
 * The template is authored at `packages/core/templates/` and mirrored by
 * `cleo init` into `~/.local/share/cleo/templates/` + `~/.cleo/templates/`.
 * We test the in-repo source directly — portable across dev machines and
 * CI runners without any filesystem provisioning.
 */
const thisDir = dirname(fileURLToPath(import.meta.url));
const injectionPath = resolve(
  thisDir,
  '../../../../core/templates/CLEO-INJECTION.md',
);

/** Read once — all assertions operate on this string */
const injectionContent = readFileSync(injectionPath, 'utf-8');

/**
 * T12580: CLEO-INJECTION.md is the always-loaded core; reference sections
 * moved to CLEO-REFERENCE.md and are printed on demand with
 * `cleo briefing inject --section <name>`. Content that moved is asserted
 * where it now lives AND through the core's pointer table, so the test still
 * proves an agent can reach it.
 */
const referenceContent = readFileSync(
  resolve(thisDir, '../../../../core/templates/CLEO-REFERENCE.md'),
  'utf-8',
);

/** Body of one on-demand section in the reference, or '' when absent. */
function referenceSection(name: string): string {
  const open = `<!-- CLEO-INJECTION:section=${name} -->`;
  const start = referenceContent.indexOf(open);
  if (start === -1) return '';
  const end = referenceContent.indexOf(`<!-- /CLEO-INJECTION:section=${name} -->`, start);
  return end === -1 ? '' : referenceContent.slice(start + open.length, end);
}

/** Section names the core's "On-demand reference" table points at (first column). */
function corePointers(): Set<string> {
  const table = injectionContent.slice(injectionContent.indexOf('## On-demand reference'));
  const rows = table.slice(0, table.indexOf('\n## ', 5)).split('\n');
  return new Set(
    rows
      .filter((line) => line.startsWith('| `'))
      .flatMap((line) => [...(line.split('|')[1] ?? '').matchAll(/`([a-z][a-z0-9-]+)`/g)])
      .map((m) => m[1] as string),
  );
}

/** Assert `name` is pointed at by the core AND declared in the reference; return its body. */
function onDemand(name: string): string {
  expect(injectionContent).toContain('cleo briefing inject --section <name>');
  expect(corePointers()).toContain(name);
  const body = referenceSection(name);
  expect(body, `reference section ${name}`).not.toBe('');
  return body;
}

// ---------------------------------------------------------------------------
// Required section markers
// ---------------------------------------------------------------------------

describe('CLEO-INJECTION.md — required section markers', () => {
  it('delivers "Memory Protocol (JIT)" on demand (core pointer → reference section)', () => {
    expect(onDemand('memory-jit')).toMatch(/^## Memory Protocol \(JIT\)/m);
  });

  it('contains "Escalation" H2 section', () => {
    expect(injectionContent).toMatch(/^## Escalation/m);
  });

  it('contains the universal evidence and repair protocol', () => {
    expect(injectionContent).toMatch(/^## Universal protocol/m);
    for (const rule of ['**Orient.**', '**Check authority and coverage.**', '**Inspect evidence.**', '**Act.**', '**Verify.**', '**Learn.**']) expect(injectionContent).toContain(rule);
  });

  it('contains "Work Loop" H2 section', () => {
    expect(injectionContent).toMatch(/^## Work Loop/m);
  });

  it('delivers "Task Discovery" on demand, with the discovery quick form in the core', () => {
    expect(onDemand('task-discovery')).toMatch(/^## Task Discovery/m);
    expect(injectionContent).toContain('cleo find "query"');
    expect(injectionContent).toContain('cleo list --parent <id>');
  });
});

// ---------------------------------------------------------------------------
// Command correctness
// ---------------------------------------------------------------------------

describe('CLEO-INJECTION.md — command correctness', () => {
  it('contains "cleo memory observe" (not bare "cleo observe")', () => {
    // Must contain the correct form
    expect(injectionContent).toContain('cleo memory observe');

    // The bare `cleo observe` form should NOT appear as an active command
    // (it may appear historically in comments, but check context)
    const lines = injectionContent.split('\n');
    const bareObserveInstructions = lines.filter((line) => {
      // Skip table rows and markdown formatting
      if (/^\s*\|/.test(line)) return false;
      if (line.trim().startsWith('-')) return false;
      // Check for bare `cleo observe` in code examples or instructions
      return (
        /\bcleo observe\b/.test(line) &&
        !line.includes('cleo memory observe')
      );
    });

    // Should be zero or only in legacy/comment context
    expect(bareObserveInstructions).toHaveLength(0);
  });

  it('contains "cleo orchestrate start" in documentation', () => {
    expect(injectionContent).toMatch(/cleo orchestrate start/);
  });

  it('contains "cleo session status" command', () => {
    expect(injectionContent).toContain('cleo session status');
  });

  it('contains "cleo show" command', () => {
    expect(injectionContent).toContain('cleo show');
  });

  it('contains "cleo find" command', () => {
    expect(injectionContent).toContain('cleo find');
  });

  it('documents add-batch array input and dry-run count fields (task-creation, on demand)', () => {
    const section = onDemand('task-creation');
    expect(section).toContain('top-level JSON array of task objects');
    expect(section).toContain('/data/wouldCreate');
    expect(section).toContain('/data/insertedCount');
  });

  it('documents docs path policy, strict preflight, and runtime doc kinds (documents, on demand)', () => {
    const section = onDemand('documents');
    expect(section).toContain('repo-relative paths');
    expect(section).toContain('arbitrary external absolute paths');
    expect(section).toContain('cleo docs list-types');
    expect(section).toContain('DocKindRegistry');
    // The canonical-doc write/read triggers stay in the core.
    expect(injectionContent).toContain('cleo docs add --type <kind> --slug <kebab-handle>');
    expect(injectionContent).toContain('cleo docs fetch <slug>');
  });

  it('uses contract-backed mutate field paths', () => {
    expect(injectionContent).toContain('/data/created/0');
    expect(injectionContent).toContain('/data/updated/0');
    expect(injectionContent).toContain('/data/deleted/0');
    expect(injectionContent).not.toContain('--field /data/task/id');
  });
});

// ---------------------------------------------------------------------------
// Command diversity — at least 6 distinct cleo <verb> patterns
// ---------------------------------------------------------------------------

describe('CLEO-INJECTION.md — command diversity', () => {
  it('contains at least 6 distinct "cleo <verb>" command patterns', () => {
    // Extract all `cleo <word>` patterns (first word after cleo)
    const verbs = new Set<string>();
    const pattern = /\bcleo\s+([a-z][a-z0-9-]*)/g;
    let match: RegExpExecArray | null;

    // eslint-disable-next-line no-cond-assign
    while ((match = pattern.exec(injectionContent)) !== null) {
      verbs.add(match[1]);
    }

    // List them for debugging if needed
    const verbsArray = Array.from(verbs).sort();
    expect(verbs.size).toBeGreaterThanOrEqual(6);
    expect(verbsArray).toContain('session');
    expect(verbsArray).toContain('show');
    expect(verbsArray).toContain('find');
    expect(verbsArray).toContain('memory');
  });
});

// ---------------------------------------------------------------------------
// Content completeness
// ---------------------------------------------------------------------------

describe('CLEO-INJECTION.md — content completeness', () => {
  it('references Protocol version in header', () => {
    expect(injectionContent).toMatch(/Version:\s*[\d.]+/);
  });

  it('contains error handling section', () => {
    expect(injectionContent).toMatch(/## Error Handling/);
  });

  it('contains Rules section', () => {
    expect(injectionContent).toMatch(/## Rules/);
  });

  it('mentions worktree or isolation pattern', () => {
    // The protocol should reference some form of process isolation
    expect(injectionContent).toMatch(
      /worktree|isolation|scope|namespace|context|dedicated/i
    );
  });
});
