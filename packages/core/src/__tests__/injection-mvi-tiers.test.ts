/**
 * Test CLEO-INJECTION.md template structure and size budgets.
 *
 * Validates the template:
 * 1. Has the current major-minor version with CLI-only dispatch
 * 2. Contains all essential sections (session start, work loop, discovery, memory, errors)
 * 3. Uses `cleo` prefix exclusively (no `ct` prefix, no MCP syntax)
 * 4. Contains escalation section with skill pointers
 * 5. Stays within the token-efficient size envelope
 * 6. Splits into an always-loaded core (CLEO-INJECTION.md) and an on-demand
 *    reference (CLEO-REFERENCE.md) whose sections every core pointer resolves
 *
 * @task T5096
 * @task T12580 (core/on-demand split; retention clauses judged over core + reference)
 * @task T882 (v2.6.0 bumped cap to 250 lines to accommodate the "Spawn Prompt Contents" section)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisFile = fileURLToPath(import.meta.url);
const corePackageRoot = resolve(dirname(thisFile), '..', '..');
const injectionPath = join(corePackageRoot, 'templates', 'CLEO-INJECTION.md');
const referencePath = join(corePackageRoot, 'templates', 'CLEO-REFERENCE.md');

const templateExists = existsSync(injectionPath);

/** Section anchor names declared in a template, in order. */
function sectionNames(text: string): string[] {
  return [...text.matchAll(/<!-- CLEO-INJECTION:section=([a-z0-9-]+) -->/g)].map(
    (m) => m[1] as string,
  );
}

describe('CLEO-INJECTION CLI-only template', () => {
  /** Always-loaded core: every session and every tier-1 spawn prompt pays for it. */
  const content = templateExists ? readFileSync(injectionPath, 'utf-8') : '';
  /** On-demand reference: `cleo briefing inject --section <name>`, tier-2 embed. */
  const reference = existsSync(referencePath) ? readFileSync(referencePath, 'utf-8') : '';
  /** Everything an agent can reach: facts may move to the reference, never vanish. */
  const reachable = `${content}\n${reference}`;

  it('template file exists at templates/CLEO-INJECTION.md', () => {
    expect(templateExists).toBe(true);
  });

  describe('Version and identity', () => {
    it('declares a release version matching the packaged protocol skill', () => {
      const version = /^Version: ((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)) \|/m.exec(
        content,
      )?.[1];
      expect(version).toBeDefined();
      const skill = readFileSync(
        join(corePackageRoot, '..', 'skills', 'skills', 'ct-cleo', 'SKILL.md'),
        'utf-8',
      );
      expect(/^ {2}version: (.+)$/m.exec(skill)?.[1]).toBe(version);
      expect(/^Version: (\S+) \|/m.exec(reference)?.[1]).toBe(version);
    });

    it('declares CLI-only dispatch', () => {
      expect(content).toContain('CLI-only dispatch');
      expect(content).toContain('cleo <command>');
    });
  });

  describe('Contains essential sections', () => {
    it('includes Session Start sequence', () => {
      expect(content).toContain('## Universal protocol');
      expect(content).toContain('cleo briefing');
      expect(content).toContain('cleo session status');
      expect(content).toContain('cleo current');
      expect(content).toContain('cleo next');
      expect(content).toContain('cleo show');
    });

    it('includes Work Loop', () => {
      expect(content).toContain('## Work Loop');
      expect(content).toContain('cleo complete');
    });

    it('includes Task Discovery (quick form in core, detail on demand)', () => {
      expect(content).toContain('cleo find');
      expect(content).toContain('cleo list');
      expect(reference).toContain('## Task Discovery');
    });

    it('includes Session Commands', () => {
      expect(content).toContain('## Session Commands');
      expect(content).toContain('cleo briefing');
    });

    it('includes Memory (BRAIN)', () => {
      expect(reference).toContain('## Memory (BRAIN)');
      expect(reference).toContain('cleo memory find');
      expect(reference).toContain('cleo memory timeline');
      expect(reference).toContain('cleo memory fetch');
      // v2.4.1: corrected from bare `cleo observe` to actual CLI command
      expect(content).toContain('cleo memory observe');
    });

    it('includes Error Handling', () => {
      expect(content).toContain('## Error Handling');
      expect(content).toContain('exit code');
      expect(content).toContain('E_NOT_FOUND');
    });

    it('includes Rules', () => {
      expect(content).toContain('## Rules');
      expect(content).toContain('small');
      expect(content).toContain('medium');
      expect(content).toContain('large');
    });
  });

  describe('CLI-only — no legacy MCP or ct syntax', () => {
    it('does not use ct prefix for commands', () => {
      expect(content).not.toMatch(/`ct /);
    });

    it('does not contain MCP query/mutate syntax', () => {
      expect(content).not.toContain('query({');
      expect(content).not.toContain('mutate({');
      expect(content).not.toContain('orchestrate.bootstrap');
    });

    it('does not contain TIER markers', () => {
      expect(content).not.toMatch(/<!-- TIER:\w+ -->/);
    });

    it('does not contain removed standard/orchestrator content', () => {
      expect(content).not.toContain('## RCASD-IVTR+C');
      expect(content).not.toContain('ORC-001');
      expect(content).not.toContain('## Spawn Pipeline');
    });
  });

  describe('Contains escalation section', () => {
    it('has Escalation section', () => {
      expect(content).toContain('## Escalation');
    });

    it('points to ct-cleo skill', () => {
      expect(content).toContain('ct-cleo');
    });

    it('points to ct-orchestrator skill', () => {
      expect(content).toContain('ct-orchestrator');
    });
  });

  describe('Mandatory protocol semantics survive compact delivery', () => {
    it.each([
      {
        rule: 'authority and static-analysis limitations',
        clauses: [
          /Recency or similarity alone does not establish authority/,
          /`UNKNOWN` means assessment is incomplete; `NONE` means no impact detected/,
          /Static analysis cannot prove all runtime callers/,
          /Preserve historical handoffs; present corrections separately/,
        ],
      },
      {
        rule: 'projection and population disclosure',
        clauses: [
          /`_withheld` maps omitted fields to UTF-8 content bytes/,
          /Budgeting preserves coverage, diagnostic failures, authority corrections and pending repair facts before examples/,
          /List\/find default to excluding archived rows/,
          /`data.population` separates matched\/returned counts and archive scope/,
        ],
      },
      {
        rule: 'mutation outcomes and safe retry',
        clauses: [
          /An impossible internal mutation budget rejects before execution/,
          /`_budgetEnforcement.withinBudget: false`; overflow does not mean rollback/,
          /Never retry a killed mutation blindly/,
          /a MISS proves nothing until (?:the writer|it) exits/,
          /Deletion is a soft archive/,
          /`--force` alone (?:preserves them as orphaned tasks|orphans children) and permits dependents/,
        ],
      },
      {
        rule: 'canonical acceptance and transactional control evidence',
        clauses: [
          /Array entries preserve literal pipes and quoted unions/,
          /nonstring entries or malformed explicit JSON arrays reject the whole mutation/,
          /never split historical records without original-input provenance and a guarded repair receipt/,
          /failed writes leave no committed receipt/,
        ],
      },
      {
        rule: 'gate evidence and parent protection',
        clauses: [
          /Documentation-only PRs cannot implement a code-fix task/,
          /Record `testsPassed` and `qaPassed` separately with actual verification results and explicit criterion links/,
          /changed criteria require fresh evidence/,
          /a child waiver does not waive parent criteria/,
        ],
      },
      {
        rule: 'guarded repair and model-independent learning',
        clauses: [
          /Automatic repairs must be bounded and reversible/,
          /owner decisions stay explicit/,
          /No background LLM is required for repair/,
          /Avoid empty completion traces/,
        ],
      },
      {
        rule: 'owner questions through the ask tool (T12481)',
        clauses: [
          /goes through the ask tool \(`AskUserQuestion` or the provider equivalent\) with concrete selectable options, recommended first/,
          /Never ask in prose or bury a question in a response/,
          /Subagents never ask the human; they return the question and options to their orchestrator, which asks/,
          /emit one LAFS `hitl\.request` envelope `\{question, options\[\{label, description\}\], recommended\}` and stop/,
        ],
      },
    ])('retains $rule', ({ clauses }) => {
      const text = reachable.replace(/\s+/g, ' ');
      for (const clause of clauses) expect(text).toMatch(clause);
    });

    // Rules an agent needs on EVERY turn must not be one command away.
    it.each([
      /\*\*Ask the owner\.\*\*/,
      /Never ask in prose or bury a question in a response/,
      /Recency or similarity alone does not establish authority/,
      /Automatic repairs must be bounded and reversible/,
      /Never retry a killed mutation blindly/,
      /Deletion is a soft archive/,
      /Record `testsPassed` and `qaPassed` separately/,
      /--limit 0` means EVERY match/,
    ])('keeps %s in the always-loaded core', (clause) => {
      expect(content.replace(/\s+/g, ' ')).toMatch(clause);
    });
  });

  describe('Core / on-demand split (T12580)', () => {
    it('ships the on-demand reference beside the core', () => {
      expect(reference.length).toBeGreaterThan(0);
    });

    it('every section the core points at resolves in the reference', () => {
      const table = content.slice(content.indexOf('## On-demand reference'));
      // First column of each table row names the sections; later columns are prose.
      const pointed = table
        .slice(0, table.indexOf('\n## ', 5))
        .split('\n')
        .filter((line) => line.startsWith('| `'))
        .flatMap((line) =>
          [...(line.split('|')[1] ?? '').matchAll(/`([a-z][a-z0-9-]+)`/g)].map(
            (m) => m[1] as string,
          ),
        );
      expect(pointed.length).toBeGreaterThanOrEqual(10);
      const referenceSections = new Set(sectionNames(reference));
      for (const name of pointed) expect(referenceSections, name).toContain(name);
    });

    it('no section name is declared in both files', () => {
      const core = new Set(sectionNames(content));
      for (const name of sectionNames(reference)) expect(core, name).not.toContain(name);
    });

    it('the pointer command is the one documented in the core', () => {
      expect(content).toContain('cleo briefing inject --section <name>');
    });

    it('the reference is never @-referenced, so no harness auto-loads it', () => {
      expect(reachable).not.toMatch(/^@.*CLEO-REFERENCE\.md/m);
    });
  });

  describe('Template size', () => {
    it('core stays under 14,000 characters (~3,600 cl100k tokens — T12580)', () => {
      expect(
        content.length,
        `CLEO-INJECTION.md is ${content.length} characters against a cap of 14,000. It is ` +
          'loaded into EVERY session and embedded into every tier-1 spawn prompt; T12580 cut it ' +
          'from 9,045 to ~3,360 cl100k tokens by moving reference material to ' +
          'CLEO-REFERENCE.md. New reference material belongs there, behind a section in the ' +
          "core's On-demand reference table — not here. If you raise the cap, say so " +
          'explicitly in the commit message.',
      ).toBeLessThanOrEqual(14000);
    });

    it('is at least 50 lines (not accidentally empty)', () => {
      const lines = content.split('\n').length;
      expect(lines).toBeGreaterThan(50);
    });
  });

  describe('Spawn Prompt Contents (T882 / v2.6.0)', () => {
    it('documents the spawn prompt tier system', () => {
      expect(reference).toContain('Spawn Prompt Contents');
      expect(reference).toContain('tier 0');
      expect(reference).toContain('tier 1');
      expect(reference).toContain('tier 2');
    });

    it('lists the required sections every spawn prompt contains', () => {
      expect(reference).toContain('## Task Identity');
      expect(reference).toContain('## File Paths');
      expect(reference).toContain('## Session Linkage');
      expect(reference).toContain('## Stage-Specific Guidance');
      expect(reference).toContain('## Evidence-Based Gate Ritual');
      expect(reference).toContain('## Quality Gates');
      expect(reference).toContain('## Return Format Contract');
    });
  });
});
