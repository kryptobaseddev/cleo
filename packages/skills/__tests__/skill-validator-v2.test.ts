/**
 * v2 foundation tests for ct-skill-validator.
 *
 * Covers CLEO overlays from Decision O-mpkoldtv-0: SKILL.md frontmatter must
 * stay cross-harness portable, JSON-serializable, and only use explicitly
 * allowlisted provider/runtime fields.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), '..', '..', '..');
const validateScript = join(
  repoRoot,
  'packages/skills/skills/ct-skill-validator/scripts/validate.py',
);

type ValidationResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  report?: {
    errors: number;
    warnings: number;
    passed: boolean;
    results: Array<{ tier: number; severity: string; message: string }>;
  };
};

const pythonHasPyYaml = (() => {
  try {
    execFileSync('python3', ['-c', 'import yaml'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const itIfPythonYaml = pythonHasPyYaml ? it : it.skip;

let tmpRoot: string | undefined;

function makeSkill(name: string, frontmatter: string): string {
  tmpRoot = tmpRoot ?? mkdtempSync(join(tmpdir(), 'cleo-skill-validator-v2-'));
  const skillDir = join(tmpRoot, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\n${frontmatter.trim()}\n---\n\n# ${name}\n\nUse this synthetic skill only for validator tests.\n`,
  );
  return skillDir;
}

function runValidate(skillDir: string): ValidationResult {
  try {
    const stdout = execFileSync('python3', [validateScript, skillDir, '--json'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '', report: JSON.parse(stdout) };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = e.stdout?.toString() ?? '';
    return {
      exitCode: e.status ?? 1,
      stdout,
      stderr: e.stderr?.toString() ?? '',
      report: stdout ? JSON.parse(stdout) : undefined,
    };
  }
}

function messages(result: ValidationResult): string {
  return result.report?.results.map((r) => r.message).join('\n') ?? result.stdout;
}

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe('ct-skill-validator v2 frontmatter portability', () => {
  itIfPythonYaml('passes quoted metadata scalars and the explicit CLEO loomStage overlay', () => {
    const skillDir = makeSkill(
      'ct-portable-skill',
      `name: ct-portable-skill
description: Validates portable quoted metadata when auditing skill frontmatter across Python and JavaScript YAML parsers.
loomStage: validation
metadata:
  author: cleo
  version: "1.2.0"
  last_updated: "2026-05-21 14:00:18"
  build: "42"`,
    );

    const result = runValidate(skillDir);

    expect(result.exitCode).toBe(0);
    expect(result.report?.passed).toBe(true);
    expect(messages(result)).toContain('Frontmatter is JSON-serializable after YAML parsing');
    expect(messages(result)).toContain(
      'All frontmatter fields are in the explicit spec/provider allowlist',
    );
    expect(messages(result)).not.toContain('unquoted');
  });

  itIfPythonYaml('fails unquoted date-like, version, and numeric metadata scalars', () => {
    const skillDir = makeSkill(
      'ct-risky-metadata',
      `name: ct-risky-metadata
description: Validates that risky metadata scalars are rejected when auditing skill portability across runtimes.
metadata:
  author: cleo
  version: 1.2
  last_updated: 2026-05-21 14:00:18
  build: 42`,
    );

    const result = runValidate(skillDir);
    const text = messages(result);

    expect(result.exitCode).toBe(1);
    expect(result.report?.passed).toBe(false);
    expect(text).toContain('metadata.version');
    expect(text).toContain('metadata.last_updated');
    expect(text).toContain('metadata.build');
    expect(text).toContain('quote it for Python/JS YAML parity and JSON portability');
  });

  itIfPythonYaml('fails provider-specific frontmatter fields unless explicitly allowlisted', () => {
    const skillDir = makeSkill(
      'ct-provider-leak',
      `name: ct-provider-leak
description: Validates that provider-specific fields cannot silently leak into portable skill frontmatter.
openai-tool-policy: relaxed
metadata:
  author: cleo
  version: "1.0.0"`,
    );

    const result = runValidate(skillDir);
    const text = messages(result);

    expect(result.exitCode).toBe(1);
    expect(result.report?.passed).toBe(false);
    expect(text).toContain("Unknown frontmatter field 'openai-tool-policy'");
    expect(text).toContain('explicit spec/provider allowlist');
  });
});
