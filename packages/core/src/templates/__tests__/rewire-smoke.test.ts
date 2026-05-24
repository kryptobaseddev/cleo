/**
 * Rewire-smoke tests — assert the legacy directory-resolver wrappers
 * (`getCleoTemplatesDir`, `getWorkflowTemplatesDir`, `resolveAgentTemplates`)
 * return the same absolute paths the SSoT registry would resolve via
 * `resolveSourcePathAbsolute()` + `getInstalledStatus()`.
 *
 * Behaviour MUST stay byte-for-byte stable: `cleo init`, `cleo init
 * --workflows`, and `cleo agent init` consume these wrappers; any drift
 * here breaks the install path on consumer projects.
 *
 * @task T9879
 * @saga T9855
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentTemplates } from '../../agents/resolveAgentTemplates.js';
import { getWorkflowTemplatesDir } from '../../init/scaffold-workflows.js';
import { getCleoHome, getCleoTemplatesDir } from '../../paths.js';
import { getTemplateById, getTemplatesByKind, resolveSourcePathAbsolute } from '../registry.js';

describe('legacy wrapper ↔ SSoT registry parity (T9879)', () => {
  it('getWorkflowTemplatesDir() matches dirname(resolveSourcePathAbsolute(workflow[0]))', () => {
    const workflows = getTemplatesByKind('workflow');
    expect(workflows.length).toBeGreaterThan(0);
    const expected = dirname(resolveSourcePathAbsolute(workflows[0]));
    expect(getWorkflowTemplatesDir()).toBe(expected);
  });

  it('getWorkflowTemplatesDir() resolves a directory that contains every workflow .yml.tmpl', () => {
    const dir = getWorkflowTemplatesDir();
    expect(existsSync(dir)).toBe(true);
    for (const entry of getTemplatesByKind('workflow')) {
      const fileName = entry.sourcePath.split('/').pop() ?? '';
      const candidate = join(dir, fileName);
      expect(existsSync(candidate)).toBe(true);
    }
  });

  it('resolveAgentTemplates() matches dirname(resolveSourcePathAbsolute(agent[0]))', () => {
    const agents = getTemplatesByKind('agent');
    expect(agents.length).toBeGreaterThan(0);
    const expected = dirname(resolveSourcePathAbsolute(agents[0]));
    const actual = resolveAgentTemplates();
    expect(actual).toBe(expected);
  });

  it('resolveAgentTemplates() resolves a directory that contains every agent .cant', () => {
    const dir = resolveAgentTemplates();
    expect(dir).not.toBeNull();
    if (dir === null) return;
    for (const entry of getTemplatesByKind('agent')) {
      const fileName = entry.sourcePath.split('/').pop() ?? '';
      const candidate = join(dir, fileName);
      expect(existsSync(candidate)).toBe(true);
    }
  });

  it('getCleoTemplatesDir() shape matches the install-path prefix of cleo-injection', () => {
    const entry = getTemplateById('cleo-injection');
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    // Registry `installPath` for cleo-injection is `templates/CLEO-INJECTION.md`
    // — `getCleoTemplatesDir()` is its dirname under CLEO home.
    const expected = dirname(join(getCleoHome(), entry.installPath));
    expect(getCleoTemplatesDir()).toBe(expected);
  });
});
