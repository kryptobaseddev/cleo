import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('minimal repro', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cleo-test-'));
    cleoDir = join(tempDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(join(cleoDir, 'config.json'), JSON.stringify({ test: true }));
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(() => {
    delete process.env['CLEO_DIR'];
  });

  it('config exists in test', () => {
    const contents = readdirSync(cleoDir);
    console.log('contents:', contents);
    console.log('CLEO_DIR:', process.env['CLEO_DIR']);
    expect(existsSync(join(cleoDir, 'config.json'))).toBe(true);
  });
});
