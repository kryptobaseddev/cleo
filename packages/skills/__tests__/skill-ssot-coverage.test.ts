/**
 * Skill SSoT coverage — every doc-related skill MUST teach the docs SSoT contract.
 *
 * Pins the closure of Saga T9787 / Epic T9794. The four doc-related skills
 * — ct-documentor (coordinator), ct-docs-write, ct-docs-review,
 * ct-spec-writer, ct-adr-recorder — each MUST reference `cleo docs *`
 * commands at least three times so future agents cannot regress to raw
 * filesystem writes for canonical documentation types.
 *
 * ct-documentor additionally MUST coordinate every other doc-owning skill
 * (ct-docs-write, ct-docs-review, ct-spec-writer, ct-adr-recorder) and
 * declare the SSoT routing rule.
 *
 * @task T9794
 * @saga T9787
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisFile = fileURLToPath(import.meta.url);
const skillsRoot = resolve(dirname(thisFile), '..', 'skills');

/**
 * Read a skill file: `ct-documentor` reads its SKILL.md, and
 * `ct-documentor/references/writing.md` reads that file (T12649 merged
 * ct-docs-write and ct-docs-review into ct-documentor references).
 */
function readSkill(name: string): string {
  const rel = name.endsWith('.md') ? name : join(name, 'SKILL.md');
  return readFileSync(join(skillsRoot, rel), 'utf-8');
}

/** Count distinct `cleo docs <verb>` references in a skill body. */
function countDocsRefs(content: string): number {
  const matches = content.match(/cleo docs\s+\w+/g);
  return matches?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Every doc-related skill teaches the SSoT
// ---------------------------------------------------------------------------

describe('SSoT coverage — every doc-related skill references `cleo docs *`', () => {
  const docSkills = [
    'ct-documentor',
    'ct-documentor/references/writing.md',
    'ct-documentor/references/reviewing.md',
    'ct-spec-writer',
    'ct-adr-recorder',
  ] as const;

  for (const skill of docSkills) {
    it(`${skill} references \`cleo docs *\` at least 3 times`, () => {
      const content = readSkill(skill);
      const count = countDocsRefs(content);
      expect(count, `${skill} has only ${count} \`cleo docs *\` references`).toBeGreaterThanOrEqual(
        3,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// ct-documentor is the coordinator: MUST route through the other skills
// ---------------------------------------------------------------------------

describe('ct-documentor — coordinator contract (T9794)', () => {
  const content = readSkill('ct-documentor');

  it('teaches `cleo docs add` as the canonical write entry point', () => {
    expect(content).toContain('cleo docs add');
  });

  it('teaches `cleo docs publish` for git-tracked publication', () => {
    expect(content).toContain('cleo docs publish');
  });

  it('teaches `cleo docs fetch` for slug-based retrieval', () => {
    expect(content).toContain('cleo docs fetch');
  });

  it('declares the SSoT routing rule (canonical types via cleo docs add)', () => {
    // Either "SSoT" or "docs SSoT" must appear in the routing context.
    expect(content).toMatch(/SSoT/);
    // And the closed-set --type taxonomy must be present.
    expect(content).toMatch(
      /spec\s*\|\s*adr\s*\|\s*research\s*\|\s*handoff\s*\|\s*note\s*\|\s*llm-readme/,
    );
  });

  it('routes note/llm-readme content through its writing reference (T12649)', () => {
    expect(content).toContain('references/writing.md');
  });

  it('routes quality validation through its reviewing reference (T12649)', () => {
    expect(content).toContain('references/reviewing.md');
  });

  it('coordinates ct-spec-writer for REQ-XXX specifications', () => {
    expect(content).toContain('ct-spec-writer');
  });

  it('coordinates ct-adr-recorder for architecture decisions', () => {
    expect(content).toContain('ct-adr-recorder');
  });

  it('lists every coordinated skill in the dependencies frontmatter', () => {
    // Match the `dependencies:` YAML block at the top of the file.
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch, 'frontmatter missing').toBeTruthy();
    const frontmatter = frontmatterMatch?.[1] ?? '';
    // ct-docs-lookup is retired and ct-docs-write/ct-docs-review are now
    // references of this skill (T12649, D11157), so they are not dependencies.
    expect(frontmatter).not.toMatch(/- ct-docs-(lookup|write|review)/);
    expect(frontmatter).toMatch(/dependencies:[\s\S]*?- ct-spec-writer/);
    expect(frontmatter).toMatch(/dependencies:[\s\S]*?- ct-adr-recorder/);
  });

  it('marks the legacy direct-filesystem path as deprecated', () => {
    expect(content).toContain('Deprecated');
  });
});
