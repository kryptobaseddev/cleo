import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bumpVersionFromConfig } from '../src/core/release/version-bump.js';

type OutputFormat = 'text' | 'json';

interface RawTarget {
  path?: string;
  file?: string;
  strategy: 'plain' | 'json' | 'toml' | 'sed';
  jsonPath?: string;
  field?: string;
  sedMatch?: string;
  optional?: boolean;
  description?: string;
}

interface CheckResult {
  file: string;
  strategy: string;
  status: 'ok' | 'drift' | 'missing' | 'skipped';
  found?: string;
  expected: string;
  reason?: string;
}

function parseArgs(argv: string[]): { fix: boolean; format: OutputFormat } {
  let fix = false;
  let format: OutputFormat = process.stdout.isTTY ? 'text' : 'json';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fix') fix = true;
    if (arg === '--json') format = 'json';
    if (arg === '--human') format = 'text';
    if ((arg === '--format' || arg === '-f') && argv[i + 1]) {
      format = argv[i + 1] === 'json' ? 'json' : 'text';
      i++;
    }
  }
  return { fix, format };
}

function getProjectRoot(): string {
  return process.cwd();
}

function getSourceVersion(projectRoot: string): string {
  const p = join(projectRoot, 'VERSION');
  if (!existsSync(p)) throw new Error('VERSION file not found');
  return (readFileSync(p, 'utf-8').split('\n')[0] ?? '').trim();
}

function getRawTargets(projectRoot: string): RawTarget[] {
  const configPath = join(projectRoot, '.cleo', 'config.json');
  if (!existsSync(configPath)) return [];
  const config = JSON.parse(readFileSync(configPath, 'utf-8')) as { release?: { versionBump?: { files?: RawTarget[] } } };
  return config.release?.versionBump?.files ?? [];
}

function readVersionForTarget(projectRoot: string, target: RawTarget): string | null {
  const file = target.path ?? target.file;
  if (!file) return null;
  const filePath = join(projectRoot, file);
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf-8');
  if (target.strategy === 'plain') {
    return (content.split('\n')[0] ?? '').trim();
  }

  if (target.strategy === 'json') {
    const fieldPath = (target.jsonPath ?? target.field ?? '.version').replace(/^\./, '');
    const data = JSON.parse(content) as Record<string, unknown>;
    const value = fieldPath.split('.').reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], data);
    return typeof value === 'string' ? value : null;
  }

  if (target.strategy === 'sed') {
    if (target.sedMatch) {
      const marker = content.match(new RegExp(target.sedMatch));
      if (!marker) return null;
    }
    const version = content.match(/\d+\.\d+\.\d+/);
    return version?.[0] ?? null;
  }

  return null;
}

function check(projectRoot: string, expected: string): { ok: boolean; results: CheckResult[] } {
  const targets = getRawTargets(projectRoot);
  const results: CheckResult[] = [];

  for (const target of targets) {
    const file = target.path ?? target.file ?? 'unknown';
    const found = readVersionForTarget(projectRoot, target);
    if (found == null) {
      results.push({
        file,
        strategy: target.strategy,
        status: target.optional ? 'skipped' : 'missing',
        expected,
        reason: target.optional ? 'optional missing/unreadable' : 'missing/unreadable',
      });
      continue;
    }
    results.push({
      file,
      strategy: target.strategy,
      status: found === expected ? 'ok' : 'drift',
      found,
      expected,
    });
  }

  return { ok: results.every((r) => r.status === 'ok' || r.status === 'skipped'), results };
}

function printText(ok: boolean, expected: string, results: CheckResult[]): void {
  process.stdout.write(`Version source: ${expected}\n`);
  for (const r of results) {
    const suffix = r.found ? ` (${r.found})` : '';
    process.stdout.write(`- ${r.file}: ${r.status}${suffix}\n`);
  }
  process.stdout.write(ok ? '\nAll version targets synchronized.\n' : '\nVersion drift detected.\n');
}

async function main(): Promise<void> {
  const { fix, format } = parseArgs(process.argv.slice(2));
  const root = getProjectRoot();
  const expected = getSourceVersion(root);

  if (fix) {
    const bumped = bumpVersionFromConfig(expected, {}, root);
    const checked = check(root, expected);
    const payload = {
      success: checked.ok,
      fix: true,
      expected,
      bumpResults: bumped.results,
      checks: checked.results,
    };
    if (format === 'json') {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write(`Applied version sync to ${bumped.results.length} targets.\n`);
      printText(checked.ok, expected, checked.results);
    }
    process.exit(checked.ok ? 0 : 11);
  }

  const checked = check(root, expected);
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify({ success: checked.ok, expected, checks: checked.results }, null, 2)}\n`);
  } else {
    printText(checked.ok, expected, checked.results);
  }
  process.exit(checked.ok ? 0 : 11);
}

void main();
