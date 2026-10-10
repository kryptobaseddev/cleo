/** JSONC surgery, writer concurrency and registry parity for project hooks. */
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it.skipIf(process.platform === 'win32')('rejects a FIFO lock without reclaiming it or touching config', async () => {
    const file = await configFile();
    await writeFile(file, '{}');
    execFileSync('mkfifo', [file + '.lock']);
    await expect(editJsonConfigFile(file, () => [{ path: ['hooks'], value: {} }])).rejects.toThrow('HOOK_LOCK_INVALID');
    expect((await lstat(file + '.lock')).isFIFO()).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('{}');
  });
  it.skipIf(process.platform === 'win32')('refuses FIFO config reads and edits without waiting for a writer', async () => {
    const file = await configFile();
    execFileSync('mkfifo', [file]);
    await expect(readManagedJsonConfigFile(file)).rejects.toThrow('FILE_READ_INVALID');
    await expect(editJsonConfigFile(file, () => [{ path: ['hooks'], value: {} }])).rejects.toThrow('FILE_READ_INVALID');
  });
  it('refuses oversized config without modifying it', async () => {
    const file = await configFile();
    const body = ' '.repeat(262145);
    await writeFile(file, body);
    await expect(readManagedJsonConfigFile(file)).rejects.toThrow('FILE_READ_INVALID');
    await expect(editJsonConfigFile(file, () => [{ path: ['hooks'], value: {} }])).rejects.toThrow('FILE_READ_INVALID');
    expect(await readFile(file, 'utf8')).toBe(body);
  });
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
  it('removes the final compact array entry without corrupting JSONC or reformatting foreign bytes', async () => {
    const file = await configFile();
    const foreign = '{ "command" : "foreign gate" }';
    await writeFile(file, '// team comment\n{"items":[' + foreign + ',{"command":"managed gate"}]}\n');
    await editJsonConfigFile(file, () => [{ path: ['items', 1] }]);
    expect((await readManagedJsonConfigFile(file)).items).toEqual([{ command: 'foreign gate' }]);
    const body = await readFile(file, 'utf8');
    expect(body).toContain(foreign);
    expect(body).toContain('// team comment');
    expect(body).not.toContain('managed gate');
  });
  it('preserves team comments between owners when removing the final array entry', async () => {
    const file = await configFile();
    const foreign = '{ "command" : "foreign gate" }';
    await writeFile(file, '{"items":[' + foreign + ' /* foreign explanation */, // team review note\n{"command":"managed gate"}]}\n');
    await editJsonConfigFile(file, () => [{ path: ['items', 1] }]);
    expect((await readManagedJsonConfigFile(file)).items).toEqual([{ command: 'foreign gate' }]);
    const body = await readFile(file, 'utf8');
    expect(body).toContain(foreign);
    expect(body).toContain('/* foreign explanation */');
    expect(body).toContain('// team review note');
    expect(body).not.toContain('managed gate');
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
