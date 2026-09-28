/**
 * The CleoOS hub `cant-bridge.ts` template finds global agents under the CLEO
 * home it was installed into (T12602).
 *
 * `cleo admin scaffold-hub` copies the template to `<cleoHome>/pi-extensions/`.
 * Its last lookup was a literal `~/.local/share/cleo/agents`, which is not the
 * CLEO home on macOS (`~/Library/Application Support/cleo`) or Windows, so a
 * global agent was never found there unless CLEO_HOME happened to be set.
 *
 * The test installs the template into a temp CLEO home the same way and
 * imports that copy.
 *
 * @task T12602
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEMPLATE = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'templates',
  'cleoos-hub',
  'pi-extensions',
  'cant-bridge.ts',
);

interface CantBridgeModule {
  resolveAgentFile: (cwd: string, agentName: string) => string | undefined;
}

describe('cant-bridge template — global agent lookup (T12602)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cleo-cant-bridge-'));
    vi.stubEnv('CLEO_HOME', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('resolves <installed CLEO home>/agents/<name>.cant with CLEO_HOME unset', async () => {
    const cleoHome = join(root, 'Library', 'Application Support', 'cleo');
    mkdirSync(join(cleoHome, 'pi-extensions'), { recursive: true });
    mkdirSync(join(cleoHome, 'agents'), { recursive: true });
    copyFileSync(TEMPLATE, join(cleoHome, 'pi-extensions', 'cant-bridge.ts'));
    const agent = join(cleoHome, 'agents', 'reviewer.cant');
    writeFileSync(agent, 'agent reviewer:\n');
    const cwd = join(root, 'project');
    mkdirSync(cwd);

    const mod = (await import(
      pathToFileURL(join(cleoHome, 'pi-extensions', 'cant-bridge.ts')).href
    )) as CantBridgeModule;

    expect(mod.resolveAgentFile(cwd, 'reviewer')).toBe(agent);
  });
});
