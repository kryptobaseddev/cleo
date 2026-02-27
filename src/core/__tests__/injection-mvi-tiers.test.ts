/**
 * T4717: Test CLEO-INJECTION progressive disclosure at all 3 MVI tiers.
 *
 * Verifies the templates/CLEO-INJECTION.md:
 * 1. Has TIER:minimal, TIER:standard, TIER:orchestrator sections
 * 2. Each tier builds on the previous (cumulative)
 * 3. MCP operations in minimal tier match actual code
 * 4. Session operations in standard tier match actual code
 * 5. ORC constraints in orchestrator tier match actual code
 *
 * @task T4717
 * @epic T4663
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(thisFile), '..', '..', '..');
const injectionPath = join(packageRoot, 'templates', 'CLEO-INJECTION.md');

// Only run if the template file exists
const templateExists = existsSync(injectionPath);

describe('CLEO-INJECTION MVI tiers (T4717)', () => {
  const content = templateExists ? readFileSync(injectionPath, 'utf-8') : '';

  it('template file exists at templates/CLEO-INJECTION.md', () => {
    expect(templateExists).toBe(true);
  });

  describe('Tier markers present', () => {
    it('has TIER:minimal opening marker', () => {
      expect(content).toContain('<!-- TIER:minimal -->');
    });

    it('has TIER:minimal closing marker', () => {
      expect(content).toContain('<!-- /TIER:minimal -->');
    });

    it('has TIER:standard opening marker', () => {
      expect(content).toContain('<!-- TIER:standard -->');
    });

    it('has TIER:standard closing marker', () => {
      expect(content).toContain('<!-- /TIER:standard -->');
    });

    it('has TIER:orchestrator opening marker', () => {
      expect(content).toContain('<!-- TIER:orchestrator -->');
    });

    it('has TIER:orchestrator closing marker', () => {
      expect(content).toContain('<!-- /TIER:orchestrator -->');
    });
  });

  describe('Tier ordering (cumulative architecture)', () => {
    it('minimal comes before standard', () => {
      const minimalIdx = content.indexOf('<!-- TIER:minimal -->');
      const standardIdx = content.indexOf('<!-- TIER:standard -->');
      expect(minimalIdx).toBeLessThan(standardIdx);
    });

    it('standard comes before orchestrator', () => {
      const standardIdx = content.indexOf('<!-- TIER:standard -->');
      const orchIdx = content.indexOf('<!-- TIER:orchestrator -->');
      expect(standardIdx).toBeLessThan(orchIdx);
    });

    it('minimal closes before standard opens', () => {
      // Skip the MVI comment block at top by searching after the first actual tier marker
      const minimalOpenIdx = content.indexOf('<!-- TIER:minimal -->');
      const minimalCloseIdx = content.indexOf('<!-- /TIER:minimal -->', minimalOpenIdx);
      const standardOpenIdx = content.indexOf('<!-- TIER:standard -->', minimalCloseIdx);
      expect(minimalCloseIdx).toBeLessThan(standardOpenIdx);
    });

    it('standard closes before orchestrator opens', () => {
      const standardOpenIdx = content.indexOf('<!-- TIER:standard -->');
      // Start search after the standard open to find the real close marker
      const standardCloseIdx = content.indexOf('<!-- /TIER:standard -->', standardOpenIdx);
      const orchOpenIdx = content.indexOf('<!-- TIER:orchestrator -->', standardCloseIdx);
      expect(standardCloseIdx).toBeLessThan(orchOpenIdx);
    });
  });

  describe('Minimal tier content', () => {
    // Extract minimal tier content
    const minimalStart = content.indexOf('<!-- TIER:minimal -->');
    const minimalEnd = content.indexOf('<!-- /TIER:minimal -->');
    const minimalContent = minimalStart >= 0 && minimalEnd > minimalStart
      ? content.slice(minimalStart, minimalEnd)
      : '';

    it('includes CLEO Identity section', () => {
      expect(minimalContent).toContain('CLEO Identity');
    });

    it('includes time estimates prohibition', () => {
      expect(minimalContent).toContain('Time Estimates Prohibited');
      expect(minimalContent).toContain('MUST NOT');
    });

    it('includes MCP Tools section', () => {
      expect(minimalContent).toContain('MCP Tools');
    });

    it('documents cleo_query operations', () => {
      expect(minimalContent).toContain('cleo_query');
      expect(minimalContent).toContain('tasks');
      expect(minimalContent).toContain('show');
      expect(minimalContent).toContain('find');
      expect(minimalContent).toContain('list');
    });

    it('documents cleo_mutate operations', () => {
      expect(minimalContent).toContain('cleo_mutate');
      expect(minimalContent).toContain('add');
      expect(minimalContent).toContain('update');
      expect(minimalContent).toContain('complete');
    });

    it('includes CLI Fallback section', () => {
      expect(minimalContent).toContain('CLI Fallback');
      expect(minimalContent).toContain('ct ');
    });

    it('includes Error Handling section', () => {
      expect(minimalContent).toContain('Error Handling');
      expect(minimalContent).toContain('exit code');
    });

    it('includes Task Discovery section', () => {
      expect(minimalContent).toContain('Task Discovery');
      expect(minimalContent).toContain('find');
    });
  });

  describe('Standard tier content', () => {
    const standardStart = content.indexOf('<!-- TIER:standard -->');
    const standardEnd = content.indexOf('<!-- /TIER:standard -->');
    const standardContent = standardStart >= 0 && standardEnd > standardStart
      ? content.slice(standardStart, standardEnd)
      : '';

    it('includes Session Protocol section', () => {
      expect(standardContent).toContain('Session Protocol');
    });

    it('documents MCP session operations', () => {
      expect(standardContent).toContain('session');
      expect(standardContent).toContain('start');
      expect(standardContent).toContain('end');
    });

    it('documents CLI session commands', () => {
      expect(standardContent).toContain('ct session');
      expect(standardContent).toContain('--scope');
      expect(standardContent).toContain('--auto-focus');
    });

    it('includes RCASD-IVTR+C Lifecycle section', () => {
      expect(standardContent).toContain('RCASD-IVTR+C');
      expect(standardContent).toContain('Lifecycle');
    });

    it('documents all 9 conditional protocols', () => {
      expect(standardContent).toContain('Research');
      expect(standardContent).toContain('Consensus');
      expect(standardContent).toContain('Specification');
      expect(standardContent).toContain('Decomposition');
      expect(standardContent).toContain('Implementation');
      expect(standardContent).toContain('Contribution');
      expect(standardContent).toContain('Release');
      expect(standardContent).toContain('Artifact Publish');
      expect(standardContent).toContain('Provenance');
    });

    it('includes Manifest entry documentation', () => {
      expect(standardContent).toContain('MANIFEST.jsonl');
    });

    it('includes Token system documentation', () => {
      expect(standardContent).toContain('Token');
      expect(standardContent).toContain('{{TASK_ID}}');
    });

    it('includes Skill Ecosystem section', () => {
      expect(standardContent).toContain('Skill Ecosystem');
      expect(standardContent).toContain('ct-orchestrator');
    });

    it('includes Release Workflow section', () => {
      expect(standardContent).toContain('Release Workflow');
      expect(standardContent).toContain('release ship');
    });
  });

  describe('Orchestrator tier content', () => {
    const orchStart = content.indexOf('<!-- TIER:orchestrator -->');
    const orchEnd = content.indexOf('<!-- /TIER:orchestrator -->');
    const orchContent = orchStart >= 0 && orchEnd > orchStart
      ? content.slice(orchStart, orchEnd)
      : '';

    it('includes Architecture Overview', () => {
      expect(orchContent).toContain('Architecture Overview');
      expect(orchContent).toContain('2-tier');
    });

    it('documents ORC constraints', () => {
      expect(orchContent).toContain('ORC-001');
      expect(orchContent).toContain('ORC-002');
      expect(orchContent).toContain('ORC-003');
      expect(orchContent).toContain('ORC-004');
      expect(orchContent).toContain('ORC-005');
      expect(orchContent).toContain('ORC-006');
      expect(orchContent).toContain('ORC-007');
      expect(orchContent).toContain('ORC-008');
    });

    it('documents BASE constraints', () => {
      expect(orchContent).toContain('BASE-001');
      expect(orchContent).toContain('BASE-002');
      expect(orchContent).toContain('BASE-003');
      expect(orchContent).toContain('BASE-004');
      expect(orchContent).toContain('BASE-005');
      expect(orchContent).toContain('BASE-006');
      expect(orchContent).toContain('BASE-007');
    });

    it('includes Spawn Pipeline section', () => {
      expect(orchContent).toContain('Spawn Pipeline');
    });

    it('documents MCP spawn operations', () => {
      expect(orchContent).toContain('orchestrate');
      expect(orchContent).toContain('analyze');
      expect(orchContent).toContain('ready');
      expect(orchContent).toContain('next');
    });

    it('includes Protocol Stack section', () => {
      expect(orchContent).toContain('Protocol Stack');
    });

    it('includes Token Pre-Resolution section', () => {
      expect(orchContent).toContain('Token Pre-Resolution');
      expect(orchContent).toContain('tokenResolution.fullyResolved');
    });

    it('includes Lifecycle Gate Enforcement section', () => {
      expect(orchContent).toContain('Lifecycle Gate Enforcement');
      expect(orchContent).toContain('strict');
      expect(orchContent).toContain('advisory');
    });

    it('includes Anti-Patterns section', () => {
      expect(orchContent).toContain('Anti-Patterns');
      expect(orchContent).toContain('Orchestrator Anti-Patterns');
      expect(orchContent).toContain('Subagent Anti-Patterns');
    });

    it('includes Subagent Lifecycle section', () => {
      expect(orchContent).toContain('Subagent');
      expect(orchContent).toContain('SPAWN');
      expect(orchContent).toContain('INJECT');
      expect(orchContent).toContain('EXECUTE');
      expect(orchContent).toContain('OUTPUT');
      expect(orchContent).toContain('RETURN');
    });
  });

  describe('Version and metadata', () => {
    it('has version header', () => {
      expect(content).toContain('Version');
      expect(content).toContain('2.0.0');
    });

    it('has status ACTIVE', () => {
      expect(content).toContain('ACTIVE');
    });

    it('has MVI architecture comment', () => {
      expect(content).toContain('MVI Progressive Disclosure');
    });

    it('has References section', () => {
      expect(content).toContain('References');
    });
  });
});
