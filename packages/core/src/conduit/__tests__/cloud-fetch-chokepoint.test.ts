/**
 * Every agent cloud-messaging request goes through `conduitFetch` (T13169).
 *
 * The behavioural tests prove that `conduitFetch` and the transports refuse a
 * retired SignalDock host. This scan proves nothing walks around them: a
 * source file that handles an agent's `apiBaseUrl` or `sseEndpoint` may not
 * call the global `fetch` or open an `EventSource` directly.
 *
 * @task T13169
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const SCANNED = ['core', 'cleo', 'runtime', 'cleo-os', 'studio', 'adapters', 'brain', 'playbooks'];

/** Files allowed a direct call, with the reason. */
const ALLOWED: Record<string, RegExp> = {
  // The gate itself.
  'core/src/conduit/cloud-endpoint.ts': /fetch\(url, init\)/,
  // The EventSource opens only after the URL passed the gate on the line above.
  'core/src/conduit/sse-transport.ts':
    /assertCloudUrlAllowed\(url\);\s*const es = new EventSource\(url\);/,
};

const AGENT_URL = /\bapiBaseUrl\b|\bsseEndpoint\b/;
const DIRECT_CALL = /(?:^|[^.\w])fetch\(|new EventSource\(/;

function sourceFiles(pkg: string): string[] {
  const root = join(PACKAGES, pkg, 'src');
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true, encoding: 'utf-8' });
  } catch {
    return [];
  }
  return entries
    .filter(
      (rel) =>
        rel.endsWith('.ts') &&
        !rel.endsWith('.d.ts') &&
        !rel.endsWith('.test.ts') &&
        !rel.endsWith('.spec.ts') &&
        !rel.split(/[\\/]/).includes('__tests__'),
    )
    .map((rel) => join(root, rel));
}

describe('agent cloud requests use conduitFetch (T13169)', () => {
  it('no file that handles an agent cloud URL calls fetch or EventSource directly', () => {
    const offenders: string[] = [];
    let scanned = 0;
    for (const pkg of SCANNED) {
      for (const file of sourceFiles(pkg)) {
        const text = readFileSync(file, 'utf-8');
        if (!AGENT_URL.test(text)) continue;
        scanned++;
        const rel = relative(PACKAGES, file).split('\\').join('/');
        const allowed = ALLOWED[rel];
        const lines = text.split('\n');
        lines.forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '');
          if (/^\s*\*/.test(code) || !DIRECT_CALL.test(code)) return;
          if (allowed?.test(text)) return;
          offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    // The scan must have looked at the transports and command handlers.
    expect(scanned).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});
