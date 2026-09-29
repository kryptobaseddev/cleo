/**
 * T12687 — every writable SQLite open installs the schema-write guard.
 *
 * The guard is enforced on the HANDLE (a SQLite authorizer), so it covers every
 * DDL site that runs on a guarded handle — drizzle migrations, `ensureColumns`,
 * raw `ALTER`s, table rebuilds, twin collapse, exodus. What it cannot cover is a
 * handle nobody guarded. This test finds every writable open in the store-owning
 * packages and requires `installSchemaWriteGuard(` right after it, or an explicit
 * `schema-guard-exempt: <reason>` marker. Read-only opens are exempt.
 *
 * @task T12687
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packages = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOTS = ['core/src', 'brain/src', 'cleo/src', 'nexus/src'].map((p) => join(packages, p));
const OPEN = /new (?:DatabaseSync|DatabaseSyncCtor)\(|openNativeDatabase\(/;
const SKIP_FILE = /__tests__|__fixtures__|\.test\.ts$|\.spec\.ts$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (name.endsWith('.ts') && !SKIP_FILE.test(path)) out.push(path);
  }
  return out;
}

/** Writable opens with no guard or exemption within the next lines. */
function unguardedOpens(): string[] {
  const findings: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line) || !OPEN.test(line)) return;
        if (/function openNativeDatabase/.test(line)) return;
        if (/read[Oo]nly:\s*true/.test(lines.slice(i, i + 3).join(' '))) return;
        if (
          /installSchemaWriteGuard\(|schema-guard-exempt:/.test(lines.slice(i, i + 12).join('\n'))
        )
          return;
        findings.push(`${relative(packages, file)}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  return findings;
}

describe('T12687 — schema-write guard coverage', () => {
  it('every writable SQLite open installs the guard or states why it is exempt', () => {
    expect(unguardedOpens()).toEqual([]);
  });
});
