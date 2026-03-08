/**
 * Test CLEO-INJECTION.md v2.1.0 minimal-only template.
 *
 * Validates the trimmed template:
 * 1. Has version 2.1.0
 * 2. Contains all minimal sections
 * 3. Does NOT contain standard/orchestrator content
 * 4. Contains escalation section with skill pointers
 * 5. Does NOT contain TIER markers
 *
 * @task T5096
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const thisFile = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(thisFile), '..', '..', '..');
const injectionPath = join(packageRoot, 'templates', 'CLEO-INJECTION.md');

const templateExists = existsSync(injectionPath);

describe('CLEO-INJECTION v2.1.0 minimal-only template', () => {
  const content = templateExists ? readFileSync(injectionPath, 'utf-8') : '';

  it('template file exists at templates/CLEO-INJECTION.md', () => {
    expect(templateExists).toBe(true);
  });

  describe('Version and metadata', () => {
    it('has version 2.1.0', () => {
      expect(content).toContain('Version: 2.1.0');
    });

    it('has status ACTIVE', () => {
      expect(content).toContain('Status: ACTIVE');
    });
  });

  describe('Contains all minimal sections', () => {
    it('includes CLEO Identity section', () => {
      expect(content).toContain('## CLEO Identity');
      expect(content).toContain('query');
      expect(content).toContain('mutate');
    });

    it('includes Mandatory Efficiency Sequence', () => {
      expect(content).toContain('## Mandatory Efficiency Sequence');
      expect(content).toContain('query session status');
      expect(content).toContain('query admin dash');
      expect(content).toContain('query tasks current');
      expect(content).toContain('query tasks next');
      expect(content).toContain('query tasks show');
    });

    it('includes Agent Work Loop', () => {
      expect(content).toContain('## Agent Work Loop');
      expect(content).toContain('tasks current');
      expect(content).toContain('tasks complete');
      expect(content).toContain('tasks next');
    });

    it('includes Context Ethics', () => {
      expect(content).toContain('## Context Ethics');
      expect(content).toContain('Anti-patterns');
    });

    it('includes Error Handling', () => {
      expect(content).toContain('## Error Handling');
      expect(content).toContain('exit code');
    });

    it('includes Task Discovery', () => {
      expect(content).toContain('## Task Discovery');
      expect(content).toContain('tasks find');
    });

    it('includes Time Estimates Prohibited', () => {
      expect(content).toContain('## Time Estimates Prohibited');
      expect(content).toContain('MUST NOT');
    });
  });

  describe('Does NOT contain standard/orchestrator content', () => {
    it('does not contain Session Protocol section', () => {
      expect(content).not.toContain('## Session Protocol');
    });

    it('does not contain CLI Fallback section', () => {
      expect(content).not.toContain('## CLI Fallback');
    });

    it('does not contain RCASD lifecycle', () => {
      expect(content).not.toContain('## RCASD-IVTR+C');
      expect(content).not.toContain('RCASD-IVTR+C Lifecycle');
    });

    it('does not contain ORC constraints', () => {
      expect(content).not.toContain('ORC-001');
      expect(content).not.toContain('## ORC Constraints');
    });

    it('does not contain BASE constraints', () => {
      expect(content).not.toContain('BASE-001');
      expect(content).not.toContain('## BASE Constraints');
    });

    it('does not contain Spawn Pipeline section', () => {
      expect(content).not.toContain('## Spawn Pipeline');
    });

    it('does not contain Architecture Overview section', () => {
      expect(content).not.toContain('## Architecture Overview');
    });

    it('does not contain Token Pre-Resolution section', () => {
      expect(content).not.toContain('## Token Pre-Resolution');
    });

    it('does not contain Subagent Lifecycle section', () => {
      expect(content).not.toContain('## Subagent Lifecycle');
    });
  });

  describe('Does NOT contain TIER markers', () => {
    it('has no TIER opening markers', () => {
      expect(content).not.toMatch(/<!-- TIER:\w+ -->/);
    });

    it('has no TIER closing markers', () => {
      expect(content).not.toMatch(/<!-- \/TIER:\w+ -->/);
    });

    it('does not contain MVI Progressive Disclosure comment', () => {
      expect(content).not.toContain('MVI Progressive Disclosure');
    });
  });

  describe('Contains escalation section', () => {
    it('has Escalation section header', () => {
      expect(content).toContain('## Escalation');
    });

    it('points to ct-cleo skill', () => {
      expect(content).toContain('ct-cleo');
    });

    it('points to ct-orchestrator skill', () => {
      expect(content).toContain('ct-orchestrator');
    });

    it('points to admin help', () => {
      expect(content).toContain('admin help');
    });

    it('points to operations reference', () => {
      expect(content).toContain('CLEO-OPERATIONS-REFERENCE.md');
    });
  });

  describe('References section', () => {
    it('has References section', () => {
      expect(content).toContain('## References');
    });

    it('references VERB-STANDARDS.md', () => {
      expect(content).toContain('VERB-STANDARDS.md');
    });
  });

  describe('Template size', () => {
    it('is under 120 lines', () => {
      const lines = content.split('\n').length;
      expect(lines).toBeLessThan(120);
    });

    it('is at least 60 lines (not accidentally empty)', () => {
      const lines = content.split('\n').length;
      expect(lines).toBeGreaterThan(60);
    });
  });
});
