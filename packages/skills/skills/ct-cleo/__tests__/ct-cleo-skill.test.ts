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

  it('documents docs path policy and runtime doc kind discovery', () => {
    expect(skillContent).toContain('Docs path policy and strict preflight');
    expect(skillContent).toContain('Do not pass arbitrary external absolute paths');
    expect(skillContent).toContain('cleo docs list-types');
    expect(skillContent).toContain('DocKindRegistry');
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

  it('mentions task-relationships section (PM-Core V2 relationship systems)', () => {
    expect(skillContent).toContain('task-relationships');
  });
});

// ---------------------------------------------------------------------------
// PM-Core V2 doctrine coverage (T10645)
// ---------------------------------------------------------------------------

describe('ct-cleo SKILL.md — PM-Core V2 doctrine (T10645)', () => {
  it('documents PM-Core V2 task hierarchy with type=saga canonical', () => {
    expect(skillContent).toContain('PM-Core V2');
    expect(skillContent).toContain('ADR-088');
    // Table shows `saga` as the type value in the hierarchy table
    expect(skillContent).toMatch(/`saga`/);
    expect(skillContent).toContain('parent_id');
  });

  it('documents I1 containment invariant (parent_id is only containment edge)', () => {
    expect(skillContent).toContain('containment edge');
    expect(skillContent).toContain('I1');
  });

  it('documents I3 non-containment invariant (task_relations is secondary only)', () => {
    expect(skillContent).toContain('I3');
    expect(skillContent).toContain('MUST NOT satisfy containment');
  });

  it('documents Saga operations via parent_id containment', () => {
    expect(skillContent).toContain('cleo orchestrate ready <sagaId>');
    expect(skillContent).toContain('cleo orchestrate waves <sagaId>');
    expect(skillContent).toContain('cleo saga rollup <sagaId>');
  });

  it('does NOT present task_relations.groups as active hierarchy guidance', () => {
    // Migration context references (e.g. "T10638 migration removes legacy groups")
    // are acceptable; active guidance must not recommend groups for hierarchy.
    // Must contain explicit anti-groups guidance.
    expect(skillContent).toMatch(/not.*task_relations\.groups|Do not use.*task_relations\.groups/);
    expect(skillContent).not.toMatch(/^[^#]*use.*task_relations\.groups.*for hierarchy/);
  });

  it('documents Task Context subsystem (T10629/T10630/T10631)', () => {
    expect(skillContent).toContain('Task Context');
    expect(skillContent).toContain('T10629');
    expect(skillContent).toContain('cleo context');
  });

  it('documents WorkGraph scaffold subsystem (T10632/T10633/T10634)', () => {
    expect(skillContent).toContain('WorkGraph');
    expect(skillContent).toContain('T10632');
    expect(skillContent).toContain('cleo graph validate');
    expect(skillContent).toContain('cleo graph apply');
  });

  it('documents Completion Criteria with typed ACs (child_task / text / evidence_bound)', () => {
    expect(skillContent).toContain('child_task');
    expect(skillContent).toContain('evidence_bound');
    expect(skillContent).toContain('typed acceptance criteria');
    expect(skillContent).toContain('T10639');
  });

  it('indicates T10638 migration removed legacy groups hierarchy reads', () => {
    expect(skillContent).toContain('T10638');
  });

  it('documents epic-level fallback for saga orchestrate', () => {
    expect(skillContent).toContain('cleo saga members');
    expect(skillContent).toMatch(/[Ee]pic-level/);
  });
});
