import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('recover tooling guardrail', () => {
  it('does not hardcode SQLite DDL in dev/recover-tasks.ts', () => {
    const source = readFileSync(join(process.cwd(), 'dev', 'recover-tasks.ts'), 'utf-8');

    expect(source).not.toContain('CREATE TABLE IF NOT EXISTS');
    expect(source).not.toContain('CREATE INDEX IF NOT EXISTS');
    expect(source).toContain('applyCanonicalMigrations');
    expect(source).toContain("resolveMigrationsFolder");
  });
});
