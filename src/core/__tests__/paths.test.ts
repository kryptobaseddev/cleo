/**
 * Tests for path resolution.
 * @epic T4454
 * @task T4458
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
