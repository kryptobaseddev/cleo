/**
 * Tests for scripts/lint-envelope-compliance.mjs (T12553).
 *
 * The gate used to REQUIRE `cleo project` failures to be rendered through
 * `cliOutput` as a success section and forbade `cliError`, which produced
 * `{"success":true, … "Error: E_MOVE_FAILED"}` followed by exit 1. It now
 * requires the opposite. These cases pin both directions:
 *   1. The real project.ts passes.
 *   2. The pre-T12553 shape (error section + process.exit) fails.
 *   3. A single failure branch that bypasses emitEngineFailure fails.
 *
 * @task T12553
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const LINT = join(REPO_ROOT, 'scripts', 'lint-envelope-compliance.mjs');
const PROJECT_TS = join(REPO_ROOT, 'packages', 'cleo', 'src', 'cli', 'commands', 'project.ts');

/** Run the lint, optionally against `file`. */
function lint(file) {
  const args = file ? [LINT, '--file', file] : [LINT];
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

/** Common header every fixture needs to pass the structural checks. */
const HEADER = `// @task T11027
import type { RenderableEnvelope } from '@cleocode/contracts';
const s = { kind: 'section' };
const names = ['move', 'reroot', 'rename', 're-register'];
const a = { json: {} }; const b = { json: {} }; const c = { json: {} }; const d = { json: {} };
cliOutput(1); cliOutput(2); cliOutput(3);
`;

describe('lint-envelope-compliance', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lint-envelope-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('passes the real project.ts', () => {
    const r = lint();
    expect(r.output).toContain('PASSED');
    expect(r.status).toBe(0);
  });

  it('fails the pre-T12553 shape: error rendered as a success section, then process.exit', () => {
    const file = join(dir, 'old.ts');
    writeFileSync(
      file,
      `${HEADER}
if (!result.success) {
  cliOutput(formatErrorSection(result.error.code, result.error.message));
  process.exit(1);
}
`,
    );
    const r = lint(file);
    expect(r.status).toBe(1);
    expect(r.output).toContain('Failure rendered as a success section');
    expect(r.output).toContain('No cliError call');
    expect(r.output).toContain('process.exit(');
  });

  it('fails when one failure branch bypasses emitEngineFailure', () => {
    const file = join(dir, 'partial.ts');
    const good = readFileSync(PROJECT_TS, 'utf-8');
    writeFileSync(
      file,
      `${good}
export function stray(result: { error: { message: string } }) {
  console.error(result.error.message);
}
`,
    );
    const r = lint(file);
    expect(r.status).toBe(1);
    expect(r.output).toContain('not routed through emitEngineFailure');
  });
});
