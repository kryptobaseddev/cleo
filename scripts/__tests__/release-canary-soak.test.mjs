/**
 * Tests for scripts/release-canary-soak.mjs (T13144).
 *
 * The installed CLI is replaced by a fake `run` that answers each command the
 * way the real one does (one LAFS envelope, or a bare value for `--output id`
 * and `--field`), and the fake `npm install` lays down a package tree. Every
 * failing case is paired with the passing case it differs from by one fact,
 * so a check that always passed would fail the pair.
 *
 * @task T13144
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installedCleocodePackages,
  parseArgs,
  resolveTag,
  runCommand,
  SOAK_CHECKS,
  SOAK_EPIC_TITLE,
  soak,
} from '../release-canary-soak.mjs';

const VERSION = '2026.10.5';

let root;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'canary-soak-test-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Write a package.json under `dir`.
 *
 * @param {string} dir
 * @param {string} name
 * @param {string} version
 */
function writePackage(dir, name, version) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }));
}

/**
 * A fake runner for the soak's commands.
 *
 * @param {object} [opts]
 * @param {Record<string, string>} [opts.versions] - Installed @cleocode versions by
 *   short name; defaults to cleo, core and lafs at VERSION.
 * @param {string} [opts.reportedVersion] - What `cleo --version` reports.
 * @param {Record<string, { status: number, stdout?: string }>} [opts.override] - By cleo verb.
 * @param {Array<{ name: string, status: string }>} [opts.doctorChecks]
 * @returns {{ run: Function, calls: string[][] }}
 */
function fakeRunner(opts = {}) {
  const {
    versions = { cleo: VERSION, core: VERSION, lafs: VERSION },
    reportedVersion = VERSION,
    override = {},
    doctorChecks = [
      { name: 'cleo_dir', status: 'pass' },
      { name: 'tasks_wipe_guard', status: 'warn' },
    ],
  } = opts;
  const calls = [];
  const ok = (stdout) => ({ status: 0, signal: null, stdout, stderr: '' });
  const env = (data) => ok(JSON.stringify({ success: true, data }));
  const run = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'npm') {
      const prefix = args[args.indexOf('--prefix') + 1];
      const cleoDir = join(prefix, 'lib', 'node_modules', '@cleocode', 'cleo');
      writePackage(cleoDir, '@cleocode/cleo', versions.cleo);
      for (const [name, version] of Object.entries(versions))
        if (name !== 'cleo')
          writePackage(
            join(cleoDir, 'node_modules', '@cleocode', name),
            `@cleocode/${name}`,
            version,
          );
      mkdirSync(join(prefix, 'bin'), { recursive: true });
      writeFileSync(join(prefix, 'bin', 'cleo'), '');
      return ok('');
    }
    if (file === 'git') return ok('');
    const verb = args[0];
    if (override[verb]) return { signal: null, stdout: '', stderr: '', ...override[verb] };
    switch (verb) {
      case '--version':
        return env({ version: reportedVersion });
      case 'init':
        return env({ initialized: true });
      case 'session':
        return env({ id: 'ses_1' });
      case 'saga':
        return ok('T001\n');
      case 'add':
        return ok('T002\n');
      case 'show':
        return ok(`${SOAK_EPIC_TITLE}\n`);
      case 'find':
        return ok('T002\nT001\n');
      case 'doctor':
        return env({ checks: doctorChecks });
      default:
        throw new Error(`unexpected command ${file} ${args.join(' ')}`);
    }
  };
  return { run, calls };
}

describe('installedCleocodePackages', () => {
  it('finds hoisted, nested and scoped @cleocode packages and skips the rest', () => {
    const cleo = join(root, 'cleo');
    writePackage(cleo, '@cleocode/cleo', '1');
    writePackage(join(cleo, 'node_modules', '@cleocode', 'core'), '@cleocode/core', '1');
    writePackage(join(cleo, 'node_modules', 'yaml'), 'yaml', '2.8.3');
    writePackage(
      join(cleo, 'node_modules', 'yaml', 'node_modules', '@cleocode', 'lafs'),
      '@cleocode/lafs',
      '0',
    );
    mkdirSync(join(cleo, 'node_modules', '.bin'), { recursive: true });
    const found = installedCleocodePackages(cleo).map((p) => `${p.name}@${p.version}`);
    expect(found).toEqual(['@cleocode/cleo@1', '@cleocode/core@1', '@cleocode/lafs@0']);
  });
});

describe('soak', () => {
  it('passes every check against a coherent install', () => {
    const { run, calls } = fakeRunner();
    const report = soak({ version: VERSION, root, run });
    expect(report.ok, JSON.stringify(report.checks, null, 2)).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(SOAK_CHECKS.map((c) => c.name));
    expect(report.checks.find((c) => c.name === 'doctor')?.detail).toContain('tasks_wipe_guard');
    // The install is the published version, globally, into the sandbox prefix.
    expect(calls[0]).toEqual([
      'npm',
      'install',
      '--global',
      '--prefix',
      join(root, 'prefix'),
      '--no-audit',
      '--no-fund',
      '--loglevel',
      'error',
      `@cleocode/cleo@${VERSION}`,
    ]);
    // The epic is filed under the saga the previous check created.
    expect(calls.find((c) => c[1] === 'add')).toContain('T001');
  });

  it('fails on a mixed @cleocode tree and skips everything after it', () => {
    const { run, calls } = fakeRunner({
      versions: { cleo: VERSION, core: '2026.10.4', lafs: VERSION },
    });
    const report = soak({ version: VERSION, root, run });
    expect(report.ok).toBe(false);
    const coherence = report.checks.find((c) => c.name === 'coherent-versions');
    expect(coherence?.ok).toBe(false);
    expect(coherence?.detail).toContain('@cleocode/core@2026.10.4');
    expect(report.checks.filter((c) => c.skipped).length).toBe(SOAK_CHECKS.length - 2);
    expect(calls).toHaveLength(1);
  });

  it('fails when only cleo itself is installed', () => {
    const { run } = fakeRunner({ versions: { cleo: VERSION } });
    const report = soak({ version: VERSION, root, run });
    expect(report.checks.find((c) => c.name === 'coherent-versions')?.ok).toBe(false);
  });

  it('fails when the installed binary reports another version', () => {
    const { run } = fakeRunner({ reportedVersion: '2026.10.4' });
    const report = soak({ version: VERSION, root, run });
    const check = report.checks.find((c) => c.name === 'version');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('2026.10.4');
  });

  it('fails on a nonzero exit and names the status', () => {
    const { run } = fakeRunner({
      override: { init: { status: 1, stdout: '{"success":false}' } },
    });
    const report = soak({ version: VERSION, root, run });
    const check = report.checks.find((c) => c.name === 'init');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('exited 1');
  });

  it('fails when the write cannot be read back', () => {
    const { run } = fakeRunner({ override: { show: { status: 0, stdout: 'other title\n' } } });
    const report = soak({ version: VERSION, root, run });
    expect(report.checks.find((c) => c.name === 'show')?.ok).toBe(false);
  });

  it('fails when find does not return the epic', () => {
    const { run } = fakeRunner({ override: { find: { status: 0, stdout: 'T001\n' } } });
    const report = soak({ version: VERSION, root, run });
    expect(report.checks.find((c) => c.name === 'find')?.ok).toBe(false);
  });

  it('fails when a doctor check fails, not when one warns', () => {
    const { run } = fakeRunner({
      doctorChecks: [
        { name: 'tasks_db', status: 'fail' },
        { name: 'tasks_wipe_guard', status: 'warn' },
      ],
    });
    const check = soak({ version: VERSION, root, run }).checks.find((c) => c.name === 'doctor');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('tasks_db');
  });
});

describe('soak environment isolation (T13181 review)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the install and every CLI run get a sandbox-only env: no OIDC request, Actions or npm token variables', () => {
    // release.yml grants id-token: write; a transitive install script must not
    // be able to mint an OIDC token, so none of these may reach the children.
    for (const [k, v] of Object.entries({
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.example/req',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'secret-request-token',
      ACTIONS_RUNTIME_TOKEN: 'secret-runtime',
      GITHUB_TOKEN: 'secret-gh',
      NODE_AUTH_TOKEN: 'secret-npm',
      NPM_TOKEN: 'secret-npm2',
      npm_config__authToken: 'secret-npm3',
    }))
      vi.stubEnv(k, v);
    const { run } = fakeRunner();
    const envs = [];
    const report = soak({
      version: VERSION,
      root,
      run: (file, args, opts) => {
        envs.push(opts.env);
        return run(file, args, opts);
      },
    });
    expect(report.ok, JSON.stringify(report.checks)).toBe(true);
    expect(envs.length).toBe(SOAK_CHECKS.filter((c) => c.command).length);
    for (const env of envs) {
      const leaked = Object.keys(env).filter(
        (k) => /^(ACTIONS_|GITHUB_)/.test(k) || /token/i.test(k),
      );
      expect(leaked).toEqual([]);
      expect(JSON.stringify(env)).not.toMatch(/secret-/);
      expect(env.HOME?.startsWith(root)).toBe(true);
      expect(env.PATH?.startsWith(join(root, 'prefix', 'bin'))).toBe(true);
    }
  });
});

describe('runCommand', () => {
  it('returns the exit status of the child', () => {
    const r = runCommand(process.execPath, ['-e', 'process.exit(3)'], {
      cwd: root,
      env: process.env,
      timeoutMs: 30_000,
    });
    expect(r.status).toBe(3);
  });

  it('kills a child that outlives its timeout', () => {
    const r = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: root,
      env: process.env,
      timeoutMs: 300,
    });
    expect(r.status).toBeNull();
    expect(r.signal).toBe('SIGKILL');
    expect(r.error).toBeDefined();
  });
});

describe('parseArgs', () => {
  it('accepts a version with or without a leading v', () => {
    expect(parseArgs(['--version', 'v2026.10.5']).version).toBe('2026.10.5');
    expect(parseArgs(['--version', '2026.10.5-beta.1']).error).toBeUndefined();
  });

  it('rejects anything that is not a CalVer version or a dist-tag', () => {
    expect(parseArgs(['--version', '2026.10.5 --registry=evil']).error).toBeDefined();
    expect(parseArgs(['--version', 'latest']).error).toBeDefined();
    expect(parseArgs(['--tag', 'Canary!']).error).toBeDefined();
    expect(parseArgs(['--bogus']).error).toBeDefined();
  });

  it('defaults to the canary tag', () => {
    expect(parseArgs([])).toEqual({ tag: 'canary', keep: false });
  });
});

describe('resolveTag', () => {
  const tagsFetch = (tags) => async () => ({ ok: true, status: 200, json: async () => tags });

  it('resolves the requested dist-tag of @cleocode/cleo', async () => {
    expect(await resolveTag('canary', tagsFetch({ latest: '2026.10.4', canary: VERSION }))).toBe(
      VERSION,
    );
  });

  it('refuses an absent tag', async () => {
    await expect(resolveTag('canary', tagsFetch({ latest: '2026.10.4' }))).rejects.toThrow(
      /absent/,
    );
  });
});
