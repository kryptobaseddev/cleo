/**
 * Unit tests for the mustache `{{var}}` variable substitution engine.
 *
 * Coverage includes:
 *  - R2 test vectors 1–3 (see R2-VARIABLE-SYNTAX-DESIGN.md §6).
 *  - Recursion-prevention invariant (resolved values are NOT re-scanned).
 *  - Dot-notation path walking against `projectContext`.
 *  - Strict vs lenient mode behaviour.
 *  - Environment prefix lookup (`CLEO_` / `CANT_`).
 *  - Whitelist enforcement.
 *  - `loadProjectContext` happy path + missing-file fallback.
 *  - `substituteCantAgentBody` end-to-end with a fixture project-context.
 *
 * @task T1238 Variable substitution engine + contracts types
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DefaultVariableResolver,
  defaultResolver,
  loadProjectContext,
  substituteCantAgentBody,
} from '../variable-substitution.js';

describe('DefaultVariableResolver', () => {
  const resolver = new DefaultVariableResolver();

  // ----------------------------------------------------------------------
  // R2 §6 Test Vector 1 — Minimal Substitution (bindings > projectContext)
  // ----------------------------------------------------------------------
  describe('R2 test vector 1 — minimal substitution', () => {
    it('resolves bindings that override projectContext', () => {
      const template = [
        'Build command: {{build_command}}',
        'Test framework: {{test_framework}}',
      ].join('\n');
      const result = resolver.resolve(template, {
        projectContext: {
          build: { command: 'cargo build' },
          testing: { framework: 'pytest' },
        },
        bindings: {
          build_command: 'cargo build --release',
          test_framework: 'pytest',
        },
      });

      expect(result.success).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.text).toBe('Build command: cargo build --release\nTest framework: pytest');
      const sources = new Set(result.resolved.map((r) => r.source));
      expect(sources.has('bindings')).toBe(true);
      // Both variables resolved via bindings, not projectContext, confirming
      // the priority order.
      expect(result.resolved.every((r) => r.source === 'bindings')).toBe(true);
    });
  });

  // ----------------------------------------------------------------------
  // R2 §6 Test Vector 2 — Dot-notation + missing vars in lenient mode
  // ----------------------------------------------------------------------
  describe('R2 test vector 2 — nested dot-notation + missing (lenient)', () => {
    it('walks dot-paths into projectContext and leaves missing placeholders', () => {
      const template = [
        'Domain: {{domain}}',
        'Language: {{conventions.typeSystem}}',
        'Unknown: {{unknown_var}}',
      ].join('\n');
      const result = resolver.resolve(template, {
        projectContext: {
          domain: 'payments',
          conventions: { typeSystem: 'TypeScript strict', fileNaming: 'kebab-case' },
        },
      });

      expect(result.success).toBe(true);
      expect(result.text).toBe(
        ['Domain: payments', 'Language: TypeScript strict', 'Unknown: {{unknown_var}}'].join('\n'),
      );
      expect(result.missing).toEqual(['unknown_var']);
      const byName = new Map(result.resolved.map((r) => [r.name, r]));
      expect(byName.get('domain')?.source).toBe('project_context');
      expect(byName.get('conventions.typeSystem')?.source).toBe('project_context');
    });
  });

  // ----------------------------------------------------------------------
  // R2 §6 Test Vector 3 — environment lookup with strict mode
  // ----------------------------------------------------------------------
  describe('R2 test vector 3 — environment variables + strict mode', () => {
    it('resolves env vars with the CLEO_ prefix under strict mode', () => {
      const template = 'API URL: {{api_url}}\nSecret: {{secret_key}}';
      const result = resolver.resolve(
        template,
        {
          env: {
            CLEO_API_URL: 'https://api.example.com',
            CLEO_SECRET_KEY: 'should-not-appear',
          },
        },
        { strict: true },
      );

      expect(result.success).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.text).toBe('API URL: https://api.example.com\nSecret: should-not-appear');
      expect(result.resolved).toHaveLength(2);
      expect(result.resolved.every((r) => r.source === 'env')).toBe(true);
    });
  });

  // ----------------------------------------------------------------------
  // Edge cases
  // ----------------------------------------------------------------------
  describe('strict mode failure path', () => {
    it('leaves text unchanged and reports missing vars when strict fails', () => {
      const template = 'Hello {{name}}, goodbye {{farewell}}';
      const result = resolver.resolve(template, { bindings: { name: 'World' } }, { strict: true });

      expect(result.success).toBe(false);
      expect(result.text).toBe(template);
      expect(result.missing).toEqual(['farewell']);
      expect(result.error).toContain('farewell');
    });
  });

  describe('recursion prevention', () => {
    it('does NOT re-scan resolved values — placeholders inside values are literal', () => {
      const template = 'Outer: {{a}}';
      const result = resolver.resolve(template, {
        bindings: {
          a: '{{b}} is literal',
          b: 'should-not-appear',
        },
      });

      // The {{b}} token inside the resolved value for {{a}} MUST remain
      // untouched — otherwise we have unbounded recursion.
      expect(result.text).toBe('Outer: {{b}} is literal');
      expect(result.missing).toEqual([]);
    });
  });

  describe('dot-notation edge cases', () => {
    it('returns undefined for broken paths and treats them as missing', () => {
      const template = '{{foo.bar.baz}}';
      const result = resolver.resolve(template, {
        projectContext: { foo: { bar: null } },
      });
      expect(result.text).toBe('{{foo.bar.baz}}');
      expect(result.missing).toEqual(['foo.bar.baz']);
    });

    it('coerces nested numbers to strings', () => {
      const template = '{{limits.max}}';
      const result = resolver.resolve(template, {
        projectContext: { limits: { max: 42 } },
      });
      expect(result.text).toBe('42');
      expect(result.resolved[0]?.value).toBe('42');
    });
  });

  describe('priority chain', () => {
    it('bindings > session > projectContext > env', () => {
      const template = '{{k}}';
      const result = resolver.resolve(template, {
        bindings: { k: 'B' },
        sessionContext: { k: 'S' },
        projectContext: { k: 'P' },
        env: { CLEO_K: 'E' },
      });
      expect(result.text).toBe('B');
      expect(result.resolved[0]?.source).toBe('bindings');
    });

    it('falls through to session when bindings missing', () => {
      const template = '{{k}}';
      const result = resolver.resolve(template, {
        sessionContext: { k: 'S' },
        projectContext: { k: 'P' },
        env: { CLEO_K: 'E' },
      });
      expect(result.text).toBe('S');
      expect(result.resolved[0]?.source).toBe('session');
    });

    it('falls through to env when bindings/session/project all missing', () => {
      const template = '{{k}}';
      const result = resolver.resolve(template, { env: { CANT_K: 'env-value' } });
      expect(result.text).toBe('env-value');
      expect(result.resolved[0]?.source).toBe('env');
    });
  });

  describe('whitelist enforcement', () => {
    it('rejects variables outside the allowedVars whitelist (lenient)', () => {
      const template = '{{allowed}} {{disallowed}}';
      const result = resolver.resolve(
        template,
        { bindings: { allowed: 'OK', disallowed: 'nope' } },
        { allowedVars: ['allowed'] },
      );
      expect(result.text).toBe('OK {{disallowed}}');
      expect(result.missing).toEqual(['disallowed']);
    });

    it('fails strict substitution when a disallowed var is referenced', () => {
      const template = '{{allowed}} {{disallowed}}';
      const result = resolver.resolve(
        template,
        { bindings: { allowed: 'OK', disallowed: 'nope' } },
        { allowedVars: ['allowed'], strict: true },
      );
      expect(result.success).toBe(false);
      expect(result.missing).toEqual(['disallowed']);
    });
  });

  describe('defaultValue fallback', () => {
    it('fills missing vars with defaultValue and reports source=default', () => {
      const template = '{{missing}}';
      const result = resolver.resolve(template, {}, { defaultValue: 'FALLBACK' });
      expect(result.text).toBe('FALLBACK');
      expect(result.missing).toEqual([]);
      expect(result.resolved[0]?.source).toBe('default');
    });
  });

  describe('extractVariables', () => {
    it('deduplicates variable names in discovery order', () => {
      const template = '{{a}} {{b}} {{a}} {{c.d}}';
      expect(resolver.extractVariables(template)).toEqual(['a', 'b', 'c.d']);
    });

    it('returns empty array for text with no placeholders', () => {
      expect(resolver.extractVariables('plain text')).toEqual([]);
    });
  });

  describe('validate', () => {
    it('flags missing required vars', () => {
      const report = resolver.validate(['a', 'b'], { bindings: { a: 'present' } });
      expect(report.valid).toBe(false);
      expect(report.missing).toEqual(['b']);
    });

    it('returns valid=true when every required var resolves', () => {
      const report = resolver.validate(['a', 'b'], {
        bindings: { a: '1' },
        projectContext: { b: '2' },
      });
      expect(report.valid).toBe(true);
      expect(report.missing).toEqual([]);
    });
  });

  describe('pattern', () => {
    it('uses the R2-spec regex source', () => {
      expect(resolver.pattern.source).toBe(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g.source);
    });

    it('ignores invalid placeholders (digit-prefixed names)', () => {
      const result = resolver.resolve('{{1foo}}', { bindings: { '1foo': 'x' } });
      // Invalid name — pattern does not match; text unchanged.
      expect(result.text).toBe('{{1foo}}');
      expect(result.resolved).toHaveLength(0);
    });
  });

  describe('case sensitivity', () => {
    it('does NOT match variants with different case', () => {
      const template = '{{tech_stack}} vs {{TECH_STACK}}';
      const result = resolver.resolve(template, { bindings: { tech_stack: 'ts' } });
      expect(result.text).toBe('ts vs {{TECH_STACK}}');
      expect(result.missing).toEqual(['TECH_STACK']);
    });
  });
});

describe('defaultResolver singleton', () => {
  it('resolves from the shared instance', () => {
    const result = defaultResolver.resolve('{{x}}', { bindings: { x: 'y' } });
    expect(result.text).toBe('y');
  });
});

// ========================================================================
// loadProjectContext + substituteCantAgentBody (filesystem integration)
// ========================================================================

describe('loadProjectContext', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-var-sub-'));
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns loaded=false when project-context.json is absent', () => {
    const result = loadProjectContext(tempDir);
    expect(result.loaded).toBe(false);
    expect(result.context).toBeNull();
    expect(result.reason).toContain('not found');
  });

  it('parses project-context.json when present', async () => {
    const fixture = {
      schemaVersion: '1.0.0',
      primaryType: 'node',
      testing: { framework: 'vitest', command: 'pnpm run test' },
    };
    await writeFile(
      join(tempDir, '.cleo', 'project-context.json'),
      JSON.stringify(fixture),
      'utf-8',
    );
    const result = loadProjectContext(tempDir);
    expect(result.loaded).toBe(true);
    expect(result.context).toEqual(fixture);
  });

  it('reports a diagnostic reason for malformed JSON', async () => {
    await writeFile(join(tempDir, '.cleo', 'project-context.json'), '{not json', 'utf-8');
    const result = loadProjectContext(tempDir);
    expect(result.loaded).toBe(false);
    expect(result.context).toBeNull();
    expect(result.reason).toMatch(/parse/i);
  });
});

describe('substituteCantAgentBody (E2E — template + fixture project-context)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-var-sub-e2e-'));
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves a template agent with 5+ variables into a fully-resolved output', async () => {
    // Fixture: project-context.json supplying testing + build + conventions.
    const fixture = {
      schemaVersion: '1.0.0',
      primaryType: 'node',
      testing: { framework: 'vitest', command: 'pnpm run test' },
      build: { command: 'pnpm run build' },
      conventions: {
        fileNaming: 'kebab-case',
        typeSystem: 'TypeScript strict',
      },
      custom: {
        tech_stack: 'TypeScript + Svelte',
        project_domain: 'accounts',
      },
    };
    await writeFile(
      join(tempDir, '.cleo', 'project-context.json'),
      JSON.stringify(fixture),
      'utf-8',
    );

    // Agent body with 6 variables — covers bindings, projectContext (flat +
    // dotted), sessionContext, and a lenient-missing case.
    const body = [
      'agent dev-generic:',
      '  role: worker',
      '  description: >',
      '    Dev agent for {{custom.project_domain}} using {{custom.tech_stack}}.',
      '    Tests via {{testing.framework}}, builds via {{build.command}}.',
      '  prompt: |',
      '    You are implementing {{taskId}}.',
      '    File naming: {{conventions.fileNaming}}.',
      '    TODO: {{optional_note}}',
    ].join('\n');

    const result = substituteCantAgentBody(body, {
      projectRoot: tempDir,
      sessionContext: { taskId: 'T1238' },
    });

    expect(result.projectContextLoaded).toBe(true);
    expect(result.success).toBe(true);
    expect(result.text).toContain('Dev agent for accounts using TypeScript + Svelte.');
    expect(result.text).toContain('Tests via vitest, builds via pnpm run build.');
    expect(result.text).toContain('You are implementing T1238.');
    expect(result.text).toContain('File naming: kebab-case.');
    // Missing optional var should remain as placeholder (lenient default).
    expect(result.text).toContain('TODO: {{optional_note}}');
    expect(result.missing).toEqual(['optional_note']);

    // Resolved count must cover every successful variable (5 concrete resolutions).
    const resolvedNames = new Set(result.resolved.map((r) => r.name));
    expect(resolvedNames.has('custom.project_domain')).toBe(true);
    expect(resolvedNames.has('custom.tech_stack')).toBe(true);
    expect(resolvedNames.has('testing.framework')).toBe(true);
    expect(resolvedNames.has('build.command')).toBe(true);
    expect(resolvedNames.has('taskId')).toBe(true);
    expect(resolvedNames.has('conventions.fileNaming')).toBe(true);
  });

  it('continues gracefully when project-context.json is absent', () => {
    const result = substituteCantAgentBody('Hello {{name}}', {
      projectRoot: tempDir,
      bindings: { name: 'world' },
    });
    expect(result.projectContextLoaded).toBe(false);
    expect(result.success).toBe(true);
    expect(result.text).toBe('Hello world');
  });
});
