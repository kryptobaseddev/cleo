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

describe('CLEO-INJECTION v2.6.0 CLI-only template', () => {
  const content = templateExists ? readFileSync(injectionPath, 'utf-8') : '';

  it('template file exists at templates/CLEO-INJECTION.md', () => {
    expect(templateExists).toBe(true);
  });

  describe('Version and identity', () => {
    it('has version 2.6.0 (T882 spawn prompt rebuild — Spawn Prompt Contents section)', () => {
      // v2.6.0 (T882): documents the canonical spawn prompt contract + tier system.
      // v2.5.0 (T832/ADR-051) introduced evidence-based gate verification.
      expect(content).toContain('Version: 2.6.0');
    });

    it('declares CLI-only dispatch', () => {
      expect(content).toContain('CLI-only dispatch');
      expect(content).toContain('cleo <command>');
    });
  });

  describe('Contains essential sections', () => {
    it('includes Session Start sequence', () => {
      expect(content).toContain('## Session Start');
      expect(content).toContain('cleo session status');
      expect(content).toContain('cleo dash');
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

  describe('Template size', () => {
    it('is under 280 lines (token-optimized; v2026.4.116 T1252 adds CONDUIT Subscription guidance — currently ~268 lines)', () => {
      const lines = content.split('\n').length;
      expect(lines).toBeLessThanOrEqual(280);
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
