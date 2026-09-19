/**
 * Test CLEO-INJECTION.md template structure and size budgets.
 *
 * Validates the template:
 * 1. Has the current major-minor version with CLI-only dispatch
 * 2. Contains all essential sections (session start, work loop, discovery, memory, errors)
 * 3. Uses `cleo` prefix exclusively (no `ct` prefix, no MCP syntax)
 * 4. Contains escalation section with skill pointers
 * 5. Stays within the token-efficient size envelope
 *
 * @task T5096
 * @task T882 (v2.6.0 bumped cap to 250 lines to accommodate the "Spawn Prompt Contents" section)
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisFile = fileURLToPath(import.meta.url);
const corePackageRoot = resolve(dirname(thisFile), '..', '..');
const injectionPath = join(corePackageRoot, 'templates', 'CLEO-INJECTION.md');

const templateExists = existsSync(injectionPath);

describe('CLEO-INJECTION CLI-only template', () => {
  const content = templateExists ? readFileSync(injectionPath, 'utf-8') : '';

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

    it('includes Task Discovery', () => {
      expect(content).toContain('## Task Discovery');
      expect(content).toContain('cleo find');
      expect(content).toContain('cleo list');
    });

    it('includes Session Commands', () => {
      expect(content).toContain('## Session Commands');
      expect(content).toContain('cleo briefing');
    });

    it('includes Memory (BRAIN)', () => {
      expect(content).toContain('## Memory (BRAIN)');
      expect(content).toContain('cleo memory find');
      expect(content).toContain('cleo memory timeline');
      expect(content).toContain('cleo memory fetch');
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
    ])('retains $rule', ({ clauses }) => {
      const text = content.replace(/\s+/g, ' ');
      for (const clause of clauses) expect(text).toMatch(clause);
    });
  });

  describe('Template size', () => {
    it('is under 470 lines (raised from 450 for the killed-write section — T12162)', () => {
      const lines = content.split('\n').length;
      expect(
        lines,
        `CLEO-INJECTION.md is ${lines} lines against a cap of 470. This file is embedded ` +
          'verbatim into every tier-1 spawn prompt, so every line costs tokens on every agent ' +
          'CLEO spawns. Prefer compressing in place — reshaping fenced blocks and bullet lists ' +
          'into tables or prose recovered 23 lines in PR #1350 without dropping a single fact — ' +
          'over raising the cap. If you do raise it, say so explicitly in the commit message.',
      ).toBeLessThanOrEqual(470);
    });

    it('is at least 50 lines (not accidentally empty)', () => {
      const lines = content.split('\n').length;
      expect(lines).toBeGreaterThan(50);
    });
  });

  describe('Spawn Prompt Contents (T882 / v2.6.0)', () => {
    it('documents the spawn prompt tier system', () => {
      expect(content).toContain('Spawn Prompt Contents');
      expect(content).toContain('tier 0');
      expect(content).toContain('tier 1');
      expect(content).toContain('tier 2');
    });

    it('lists the required sections every spawn prompt contains', () => {
      expect(content).toContain('## Task Identity');
      expect(content).toContain('## File Paths');
      expect(content).toContain('## Session Linkage');
      expect(content).toContain('## Stage-Specific Guidance');
      expect(content).toContain('## Evidence-Based Gate Ritual');
      expect(content).toContain('## Quality Gates');
      expect(content).toContain('## Return Format Contract');
    });
  });
});
