/**
 * Regression tests for ct-cleo/SKILL.md (SKILL-14).
 *
 * Asserts that all required protocol markers are present in the skill file,
 * protecting against content drift as the file evolves.
 *
 * After T9148 (ct-cleo thin-pointer collapse), the SKILL.md became a ~31-line
 * pointer to CLEO-INJECTION.md rather than a 615-line embedded protocol.
 * These tests validate the thin-pointer structure's required elements.
 *
 * @task T808
 * @skill-version SKILL-14
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const thisFile = fileURLToPath(import.meta.url);

/** Absolute path to the ct-cleo skill root directory */
const skillRoot = resolve(dirname(thisFile), '..');

/** Full path to the SKILL.md file under test */
const skillPath = join(skillRoot, 'SKILL.md');

/** Read once — all assertions operate on this string */
const skillContent = readFileSync(skillPath, 'utf-8');

// ---------------------------------------------------------------------------
// Required structural elements (post-T9148 thin-pointer design)
// ---------------------------------------------------------------------------

describe('ct-cleo SKILL.md — thin-pointer structure (post-T9148)', () => {
  it('has a Quick Reference table or section', () => {
    expect(skillContent).toContain('Quick Reference');
  });

  it('points to CLEO-INJECTION.md canonical source', () => {
    expect(skillContent).toContain('CLEO-INJECTION.md');
  });

  it('lists supported sections or emit command', () => {
    expect(skillContent).toContain('cleo briefing');
  });
});

// ---------------------------------------------------------------------------
// Command usage correctness (SKILL-11 / SKILL-12)
// ---------------------------------------------------------------------------

describe('ct-cleo SKILL.md — command correctness', () => {
  it('uses "cleo memory observe" not bare "cleo observe" for memory writes', () => {
    // Must contain the correct form
    expect(skillContent).toContain('cleo memory observe');

    // The bare `cleo observe` form should only appear as a deprecated anti-pattern
    // in a table row (prefixed with `| `), never as an instruction to execute.
    const lines = skillContent.split('\n');
    const badLines = lines.filter((line) => {
      if (/^\s*\|/.test(line)) return false;
      return /\bcleo observe\b/.test(line);
    });
    expect(badLines).toHaveLength(0);
  });

  it('references cleo orchestrate spawn (the canonical spawn command)', () => {
    expect(skillContent).toContain('cleo orchestrate spawn');
  });

  it('documents add-batch input as a top-level JSON array', () => {
    expect(skillContent).toContain('The top-level JSON MUST be an array of task objects');
    expect(skillContent).toContain('not an object wrapper like `{ "tasks": [...] }`');
  });

  it('uses mutation projection field paths instead of legacy full-record paths', () => {
    expect(skillContent).toContain('/data/created/0');
    expect(skillContent).toContain('/data/updated/0');
    expect(skillContent).toContain('/data/deleted/0');
    expect(skillContent).not.toContain('--field /data/task/id');
  });

  it('documents add-batch dry-run count semantics', () => {
    expect(skillContent).toContain('/data/wouldCreate');
    expect(skillContent).toContain('/data/insertedCount');
    expect(skillContent).toContain('`0` for dry-run');
  });
});

// ---------------------------------------------------------------------------
// Command diversity — at least 4 distinct cleo <verb> patterns
// ---------------------------------------------------------------------------

describe('ct-cleo SKILL.md — command diversity', () => {
  it('contains at least 4 distinct "cleo <verb>" command patterns', () => {
    const verbs = new Set<string>();
    const pattern = /\bcleo\s+([a-z][a-z0-9-]*)/g;
    let match: RegExpExecArray | null;

    // eslint-disable-next-line no-cond-assign
    while ((match = pattern.exec(skillContent)) !== null) {
      verbs.add(match[1]);
    }

    expect(verbs.size).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------
// Phase coverage — section names are emittable (post-T9148 pointer design)
// ---------------------------------------------------------------------------

describe('ct-cleo SKILL.md — phase coverage via emittable sections', () => {
  it('mentions pre-complete gate section (emittable via cleo briefing inject)', () => {
    expect(skillContent).toContain('pre-complete-gate');
  });

  it('mentions session-start section (research phase entry point)', () => {
    expect(skillContent).toContain('session-start');
  });

  it('mentions orchestration section (orchestrate commands)', () => {
    expect(skillContent).toContain('orchestration');
  });

  it('mentions task-creation section (task creation guidance)', () => {
    expect(skillContent).toContain('task-creation');
  });

  it('mentions work-loop section (core workflow loop)', () => {
    expect(skillContent).toContain('work-loop');
  });
});
