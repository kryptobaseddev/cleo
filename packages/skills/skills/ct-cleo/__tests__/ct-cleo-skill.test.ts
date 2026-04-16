/**
 * Regression tests for ct-cleo/SKILL.md (SKILL-14).
 *
 * Asserts that all required protocol markers are present in the skill file,
 * protecting against content drift as the file evolves.
 *
 * Checks:
 * - Required section markers exist: Decision Tree, Pre-Complete Gate Ritual,
 *   Multi-Agent Coordination, Greenfield Bootstrap
 * - `cleo memory observe` is used (not the deprecated bare `cleo observe`)
 * - `cleo orchestrate ivtr` is referenced at least once
 * - At least 4 distinct `cleo <verb>` command patterns exist
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
// Required section markers (SKILL-10 through SKILL-13)
// ---------------------------------------------------------------------------

describe('ct-cleo SKILL.md — required section markers', () => {
  it('contains "Decision Tree" section', () => {
    expect(skillContent).toContain('Decision Tree');
  });

  it('contains "Pre-Complete Gate Ritual" section', () => {
    expect(skillContent).toContain('Pre-Complete Gate Ritual');
  });

  it('contains "Multi-Agent Coordination" section', () => {
    expect(skillContent).toContain('Multi-Agent Coordination');
  });

  it('contains "Greenfield Bootstrap" section', () => {
    expect(skillContent).toContain('Greenfield Bootstrap');
  });

  it('Decision Tree is the first H2 heading', () => {
    // Find the position of the first H2 (## ...) after the frontmatter
    const afterFrontmatter = skillContent.replace(/^---[\s\S]*?---\n/, '');
    const firstH2Match = /^## (.+)$/m.exec(afterFrontmatter);
    expect(firstH2Match).not.toBeNull();
    expect(firstH2Match![1]).toContain('Decision Tree');
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
    // Count bare `cleo observe` occurrences that are NOT inside table pipe columns.
    const lines = skillContent.split('\n');
    const badLines = lines.filter((line) => {
      // Skip table rows — those document deprecated patterns intentionally
      if (/^\s*\|/.test(line)) return false;
      // Skip comment-style lines and code-block lines showing anti-patterns
      return /\bcleo observe\b/.test(line);
    });
    expect(badLines).toHaveLength(0);
  });

  it('references "cleo orchestrate ivtr" at least once', () => {
    expect(skillContent).toMatch(/cleo orchestrate ivtr/);
  });
});

// ---------------------------------------------------------------------------
// Command diversity — at least 4 distinct cleo <verb> patterns
// ---------------------------------------------------------------------------

describe('ct-cleo SKILL.md — command diversity', () => {
  it('contains at least 4 distinct "cleo <verb>" command patterns', () => {
    // Extract all `cleo <word>` patterns (first word after cleo)
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
// Phase mapping (SKILL-10 enhancement)
// ---------------------------------------------------------------------------

describe('ct-cleo SKILL.md — phase mapping', () => {
  it('includes phase mapping for research phase', () => {
    expect(skillContent).toContain('research');
  });

  it('includes phase mapping for implement phase', () => {
    expect(skillContent).toMatch(/implement/i);
  });

  it('includes phase mapping for validate phase', () => {
    expect(skillContent).toMatch(/validate|validation/i);
  });

  it('includes phase mapping for test phase', () => {
    expect(skillContent).toMatch(/\btest\b/i);
  });

  it('includes phase mapping for release phase', () => {
    expect(skillContent).toContain('release');
  });
});
