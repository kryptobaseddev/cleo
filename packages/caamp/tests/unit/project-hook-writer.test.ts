/** JSONC surgery, writer concurrency and registry parity for project hooks. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editJsonConfigFile, readManagedJsonConfigFile } from '../../src/core/fs/atomic.js';
import { GENERATED_PROVIDER_HOOK_PROFILES, PROVIDER_NATIVE_EVENT_MAPS } from '../../src/core/hooks/generated.js';
import { getProviderHookProfile, toNative } from '../../src/core/hooks/normalizer.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function configFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cleo-hook-writer-'));
  directories.push(dir);
  return join(dir, 'hooks.json');
}
describe('managed project hook writer', () => {
  it('keeps comments, permissions and the exact old heavy-command entry when appending', async () => {
    const file = await configFile();
    const heavy = '{ "hooks": [{ "type": "command", "command": "heavy # cleo-hook" }] }';
    await writeFile(file, '{\n// owner context\n"permissions": { "allow": ["Bash(pwd)"] },\n"hooks": {"PreToolUse": [' + heavy + ']}}\n');
    await editJsonConfigFile(file, () => [{ path: ['hooks', 'PreToolUse', 1], insert: true,
      value: { hooks: [{ type: 'command', command: 'project check' }] } }]);
    const body = await readFile(file, 'utf8');
    expect(body).toContain('// owner context');
    expect(body).toContain(heavy);
    expect(body).toContain('"permissions": { "allow": ["Bash(pwd)"] }');
    expect((await readManagedJsonConfigFile(file)).hooks).toBeDefined();
  });
  it('serializes concurrent read-modify-write appends without losing either entry', async () => {
    const file = await configFile();
    await writeFile(file, '{"items":[]}\n');
    await Promise.all(['one', 'two'].map((name) => editJsonConfigFile(file, (config) => {
      if (!Array.isArray(config.items)) throw new Error('items malformed');
      return [{ path: ['items', config.items.length], value: name, insert: true }];
    })));
    expect((await readManagedJsonConfigFile(file)).items).toEqual(expect.arrayContaining(['one', 'two']));
  });
  it('refuses malformed input without replacing its bytes', async () => {
    const file = await configFile();
    await writeFile(file, '{ malformed');
    await expect(editJsonConfigFile(file, () => [{ path: ['hooks'], value: {} }])).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{ malformed');
  });
  it('uses the same registry for Codex PreToolUse and provider fallback maps', () => {
    expect(toNative('PreToolUse', 'codex')).toBe('PreToolUse');
    expect(PROVIDER_NATIVE_EVENT_MAPS.codex?.PreToolUse).toBe('PreToolUse');
    expect(getProviderHookProfile('codex')).toEqual(GENERATED_PROVIDER_HOOK_PROFILES.codex);
    expect(GENERATED_PROVIDER_HOOK_PROFILES.codex?.projectDelivery?.verifiedVersions).toEqual([]);
    expect(PROVIDER_NATIVE_EVENT_MAPS.pi?.tool_execution_start).toBe('PreToolUse');
    expect(PROVIDER_NATIVE_EVENT_MAPS['gemini-cli']?.BeforeTool).toBe('PreToolUse');
  });
});
