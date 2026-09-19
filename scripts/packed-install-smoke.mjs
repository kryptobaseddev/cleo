#!/usr/bin/env node
/**
 * Retained packed-install CLI smoke (T12273). Workspace packages come from local
 * tarballs; third-party dependencies may use npm's registry. This check does not
 * yet assess Studio routes, embeddings, provider workflows, or publication.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHED_PKGS = [
  'adapters',
  'agents',
  'animations',
  'brain',
  'caamp',
  'cant',
  'cleo',
  'cleo-os',
  'contracts',
  'core',
  'git-shim',
  'lafs',
  'nexus',
  'paths',
  'playbooks',
  'runtime',
  'skills',
  'worktree',
];

/**
 * Execute a bounded operational command; nonzero exit never becomes captured success.
 * @param {string} command - Executable to invoke without a shell.
 * @param {string[]} args - Literal argument vector.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number}} options - Explicit execution context.
 * @returns {string} Captured stdout only after a successful exit.
 */
export function runPackedCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeout ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Create isolated runtime roots without copying inherited credentials or path pins.
 * @param {string} root - Owned temporary evidence directory.
 * @returns {NodeJS.ProcessEnv} Explicit child environment; package installation may access npm.
 */
export function packedEnvironment(root) {
  const env = {
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    CI: '1',
    NO_COLOR: '1',
    CLEO_HEADLESS: '1',
    CLEO_DISABLE_LOCAL_INFERENCE: '1',
    NODE_OPTIONS: '--max-old-space-size=2048',
  };
  const roots = {
    HOME: 'home',
    USERPROFILE: 'home',
    XDG_DATA_HOME: 'data',
    XDG_CONFIG_HOME: 'config',
    XDG_CACHE_HOME: 'cache',
    XDG_RUNTIME_DIR: 'runtime',
    TMPDIR: 'tmp',
    TMP: 'tmp',
    TEMP: 'tmp',
    CLEO_HOME: 'cleo',
    CLEO_CONFIG_HOME: 'cleo-config',
    CLEO_ROOT: 'project',
    CLEO_PROJECT_ROOT: 'project',
    CLEO_DIR: 'project/.cleo',
    NEXUS_HOME: 'nexus',
    NEXUS_CACHE_DIR: 'nexus/cache',
    AGENTS_HOME: 'agents',
    CLAUDE_CONFIG_DIR: 'claude',
    CODEX_HOME: 'codex',
    KIMI_HOME: 'kimi',
    KIMI_CONFIG_DIR: 'kimi/config',
    OPENCODE_CONFIG_DIR: 'opencode',
    CURSOR_CONFIG_DIR: 'cursor',
    GEMINI_CLI_HOME: 'gemini',
    npm_config_cache: 'npm-cache',
  };
  for (const [key, path] of Object.entries(roots)) {
    env[key] = join(root, path);
    mkdirSync(env[key], { recursive: true });
  }
  return env;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const evidenceParent = resolve(
    process.env.CLEO_PACKED_EVIDENCE_DIR ?? (process.platform === 'win32' ? tmpdir() : '/tmp'),
  );
  mkdirSync(evidenceParent, { recursive: true });
  const root = mkdtempSync(join(evidenceParent, 'cleo-packed-smoke-'));
  const env = packedEnvironment(root);
  const tarballs = join(root, 'tarballs');
  const app = join(root, 'app');
  mkdirSync(tarballs);
  mkdirSync(app);
  const manifest = {
    sourceRevision: runPackedCommand('git', ['rev-parse', 'HEAD']).trim(),
    lockSha256: sha256(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'))),
    packages: [],
    status: 'running',
    coverage: { cliVersion: 'not-assessed', studio: 'not-assessed', embedding: 'not-assessed' },
    limitations: [
      'Third-party dependencies may use npm registry.',
      'Tarball hashes identify retained bytes; installed file equality and runtime routes require separate verification.',
    ],
  };
  const save = () =>
    writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  save();
  console.log(`[packed-smoke] Retaining evidence at ${root}`);
  try {
    const overrides = {};
    for (const directory of PUBLISHED_PKGS) {
      const cwd = join(REPO_ROOT, 'packages', directory);
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      if (!pkg.name || !pkg.version) throw new Error(`Missing package identity: ${directory}`);
      const output = runPackedCommand('pnpm', ['pack', '--pack-destination', tarballs], {
        cwd,
        env: { ...env, npm_config_ignore_scripts: 'true' },
      });
      writeFileSync(join(root, `pack-${directory}.log`), output);
      const filename = `${pkg.name.replace('@', '').replaceAll('/', '-')}-${pkg.version}.tgz`;
      const tarball = join(tarballs, filename);
      const bytes = readFileSync(tarball);
      overrides[pkg.name] = `file:${tarball}`;
      manifest.packages.push({
        name: pkg.name,
        version: pkg.version,
        filename,
        bytes: bytes.length,
        sha256: sha256(bytes),
      });
      save();
    }
    const expected = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/cleo/package.json'), 'utf8'),
    ).version;
    const appManifest = {
      name: 'packed-smoke-app',
      version: '0.0.1',
      private: true,
      dependencies: { '@cleocode/cleo': overrides['@cleocode/cleo'] },
      overrides,
    };
    writeFileSync(join(app, 'package.json'), JSON.stringify(appManifest, null, 2) + '\n');
    const installed = runPackedCommand(
      'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=warn'],
      { cwd: app, env, timeout: 300_000 },
    );
    writeFileSync(join(root, 'install.log'), installed);
    const binary = join(app, 'node_modules', '.bin', 'cleo');
    if (!existsSync(binary)) throw new Error('Installed CLI entry is missing.');
    const guard = join(root, 'runtime-guard.mjs');
    writeFileSync(
      guard,
      `import child from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Packed CLI version probe attempted an unrequested side effect.'); };
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) child[key] = denied;
net.Server.prototype.listen = denied;
net.Socket.prototype.connect = denied;
http.request = denied; http.get = denied; https.request = denied; https.get = denied;
globalThis.fetch = denied;
syncBuiltinESMExports();
`,
    );
    const version = runPackedCommand(process.execPath, ['--import', guard, binary, '--version'], {
      cwd: env.CLEO_ROOT,
      env,
      timeout: 30_000,
    }).trim();
    writeFileSync(join(root, 'version.txt'), version + '\n');
    if (version !== expected && version !== `v${expected}`)
      throw new Error(`Installed CLI version differs: expected ${expected}, received ${version}`);
    manifest.coverage.cliVersion = 'verified';
    manifest.status = 'verified-cli-smoke';
    save();
    console.log(
      `[packed-smoke] CLI version verified (${version}); Studio and embeddings remain unassessed. Evidence: ${root}`,
    );
  } catch (error) {
    manifest.status = 'failed';
    manifest.error = error.message;
    writeFileSync(
      join(root, 'failure.log'),
      `${error.stack ?? error}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
    );
    save();
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[packed-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
