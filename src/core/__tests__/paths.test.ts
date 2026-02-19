/**
 * Tests for path resolution.
 * @epic T4454
 * @task T4458
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getCleoHome,
  getCleoDir,
  getCleoDirAbsolute,
  getProjectRoot,
  resolveProjectPath,
  getTodoPath,
  getConfigPath,
  getBackupDir,
  getGlobalConfigPath,
  getAgentOutputsDir,
  getAgentOutputsAbsolute,
  getManifestPath,
  getManifestArchivePath,
  isAbsolutePath,
} from '../paths.js';

describe('getCleoHome', () => {
  const origEnv = process.env['CLEO_HOME'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_HOME'] = origEnv;
    } else {
      delete process.env['CLEO_HOME'];
    }
  });

  it('defaults to ~/.cleo', () => {
    delete process.env['CLEO_HOME'];
    expect(getCleoHome()).toBe(join(homedir(), '.cleo'));
  });

  it('respects CLEO_HOME env var', () => {
    process.env['CLEO_HOME'] = '/custom/cleo';
    expect(getCleoHome()).toBe('/custom/cleo');
  });
});

describe('getCleoDir', () => {
  const origEnv = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
  });

  it('defaults to .cleo', () => {
    delete process.env['CLEO_DIR'];
    expect(getCleoDir()).toBe('.cleo');
  });

  it('respects CLEO_DIR env var', () => {
    process.env['CLEO_DIR'] = '/custom/data';
    expect(getCleoDir()).toBe('/custom/data');
  });
});

describe('getCleoDirAbsolute', () => {
  const origEnv = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
  });

  it('resolves relative path against cwd', () => {
    delete process.env['CLEO_DIR'];
    const result = getCleoDirAbsolute('/my/project');
    expect(result).toBe('/my/project/.cleo');
  });

  it('returns absolute CLEO_DIR as-is', () => {
    process.env['CLEO_DIR'] = '/absolute/data';
    expect(getCleoDirAbsolute('/my/project')).toBe('/absolute/data');
  });
});

describe('getProjectRoot', () => {
  const origEnv = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
  });

  it('returns parent of .cleo directory', () => {
    delete process.env['CLEO_DIR'];
    const result = getProjectRoot('/my/project');
    expect(result).toBe('/my/project');
  });
});

describe('resolveProjectPath', () => {
  const origEnv = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
  });

  it('returns absolute paths unchanged', () => {
    delete process.env['CLEO_DIR'];
    expect(resolveProjectPath('/absolute/path', '/my/project')).toBe('/absolute/path');
  });

  it('resolves relative paths against project root', () => {
    delete process.env['CLEO_DIR'];
    const result = resolveProjectPath('src/index.ts', '/my/project');
    expect(result).toBe('/my/project/src/index.ts');
  });

  it('expands tilde to home directory', () => {
    delete process.env['CLEO_DIR'];
    const result = resolveProjectPath('~/documents', '/my/project');
    expect(result).toBe(join(homedir(), 'documents'));
  });
});

describe('path helper functions', () => {
  const origEnv = process.env['CLEO_DIR'];

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
  });

  it('getTodoPath returns correct path', () => {
    delete process.env['CLEO_DIR'];
    expect(getTodoPath('/my/project')).toBe('/my/project/.cleo/todo.json');
  });

  it('getConfigPath returns correct path', () => {
    delete process.env['CLEO_DIR'];
    expect(getConfigPath('/my/project')).toBe('/my/project/.cleo/config.json');
  });

  it('getBackupDir returns correct path', () => {
    delete process.env['CLEO_DIR'];
    expect(getBackupDir('/my/project')).toBe('/my/project/.cleo/backups/operational');
  });

  it('getGlobalConfigPath returns correct path', () => {
    const origHome = process.env['CLEO_HOME'];
    delete process.env['CLEO_HOME'];
    expect(getGlobalConfigPath()).toBe(join(homedir(), '.cleo', 'config.json'));
    if (origHome !== undefined) process.env['CLEO_HOME'] = origHome;
    else delete process.env['CLEO_HOME'];
  });
});

// ============================================================================
// Agent Outputs Path Tests
// ============================================================================

describe('getAgentOutputsDir', () => {
  const origEnv = process.env['CLEO_DIR'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tempDir = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns default when no config exists', () => {
    expect(getAgentOutputsDir(tempDir)).toBe('.cleo/agent-outputs');
  });

  it('reads agentOutputs.directory from config', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), JSON.stringify({
      agentOutputs: { directory: 'custom/outputs' },
    }));
    expect(getAgentOutputsDir(tempDir)).toBe('custom/outputs');
  });

  it('reads agentOutputs as plain string from config', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), JSON.stringify({
      agentOutputs: 'my-outputs',
    }));
    expect(getAgentOutputsDir(tempDir)).toBe('my-outputs');
  });

  it('falls back to research.outputDir (deprecated)', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), JSON.stringify({
      research: { outputDir: 'research/out' },
    }));
    expect(getAgentOutputsDir(tempDir)).toBe('research/out');
  });

  it('falls back to directories.agentOutputs (deprecated)', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), JSON.stringify({
      directories: { agentOutputs: 'dirs/out' },
    }));
    expect(getAgentOutputsDir(tempDir)).toBe('dirs/out');
  });

  it('uses priority order: agentOutputs > research > directories', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), JSON.stringify({
      agentOutputs: { directory: 'first' },
      research: { outputDir: 'second' },
      directories: { agentOutputs: 'third' },
    }));
    expect(getAgentOutputsDir(tempDir)).toBe('first');
  });

  it('falls back to default on invalid config JSON', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), 'not valid json');
    expect(getAgentOutputsDir(tempDir)).toBe('.cleo/agent-outputs');
  });
});

describe('getAgentOutputsAbsolute', () => {
  const origEnv = process.env['CLEO_DIR'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tempDir = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolves default to absolute path', () => {
    const result = getAgentOutputsAbsolute(tempDir);
    expect(result).toBe(join(tempDir, '.cleo', 'agent-outputs'));
  });

  it('returns absolute config path as-is', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), JSON.stringify({
      agentOutputs: { directory: '/absolute/outputs' },
    }));
    expect(getAgentOutputsAbsolute(tempDir)).toBe('/absolute/outputs');
  });
});

describe('getManifestPath', () => {
  const origEnv = process.env['CLEO_DIR'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tempDir = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns default manifest path', () => {
    const result = getManifestPath(tempDir);
    expect(result).toBe(join(tempDir, '.cleo', 'agent-outputs', 'MANIFEST.jsonl'));
  });

  it('respects custom output directory', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), JSON.stringify({
      agentOutputs: { directory: 'custom/out' },
    }));
    const result = getManifestPath(tempDir);
    expect(result).toBe(join(tempDir, 'custom', 'out', 'MANIFEST.jsonl'));
  });

  it('respects custom manifest filename', () => {
    writeFileSync(join(tempDir, '.cleo', 'config.json'), JSON.stringify({
      agentOutputs: { manifestFile: 'custom-manifest.jsonl' },
    }));
    const result = getManifestPath(tempDir);
    expect(result).toBe(join(tempDir, '.cleo', 'agent-outputs', 'custom-manifest.jsonl'));
  });
});

describe('getManifestArchivePath', () => {
  const origEnv = process.env['CLEO_DIR'];
  let tempDir: string;

  beforeEach(() => {
    delete process.env['CLEO_DIR'];
    tempDir = join(tmpdir(), `cleo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, '.cleo'), { recursive: true });
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env['CLEO_DIR'] = origEnv;
    } else {
      delete process.env['CLEO_DIR'];
    }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns default archive path', () => {
    const result = getManifestArchivePath(tempDir);
    expect(result).toBe(join(tempDir, '.cleo', 'agent-outputs', 'MANIFEST.archive.jsonl'));
  });
});

describe('isAbsolutePath', () => {
  it('recognizes POSIX absolute paths', () => {
    expect(isAbsolutePath('/usr/local')).toBe(true);
  });

  it('recognizes Windows drive letter paths', () => {
    expect(isAbsolutePath('C:\\Users')).toBe(true);
    expect(isAbsolutePath('D:/data')).toBe(true);
  });

  it('recognizes UNC paths', () => {
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
  });

  it('rejects relative paths', () => {
    expect(isAbsolutePath('.cleo')).toBe(false);
    expect(isAbsolutePath('src/index.ts')).toBe(false);
    expect(isAbsolutePath('./local')).toBe(false);
  });
});
