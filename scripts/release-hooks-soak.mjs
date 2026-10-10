#!/usr/bin/env node
/** Exact installed-artifact project hooks probe; no application credentials (T13348). */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPublishedPackages } from './execute-payload.mjs';
import { isMain } from './lib/is-main.mjs';
import { sandboxEnvironment } from './lib/sandbox-env.mjs';

/** Exercise installed CLI delivery, native protocol, actual pushes and worktree port.
 * @param {{bin:string,project:string,installDir:string,env:NodeJS.ProcessEnv}} options Sandbox paths and environment.
 * @returns {Promise<string>} Verified fixture scenarios.
 */
export async function probeInstalledHooks({ bin, project, installDir, env }) {
  if (env.CLEO_HOME !== process.env.CLEO_HOME || env.HOME !== process.env.HOME)
    throw new Error(
      'Installed SDK hook probe requires a process launched with the isolated environment',
    );
  const call = (file, args, input, expected = 0) => {
    const result = spawnSync(file, args, {
      cwd: project,
      env,
      encoding: 'utf8',
      input,
      timeout: 30000,
      maxBuffer: 262144,
    });
    if (result.error || result.status !== expected)
      throw new Error(
        `Installed hook probe failed: ${file} ${args.slice(0, 3).join(' ')} (${result.status})`,
      );
    return result.stdout;
  };
  const envelope = (args) => {
    const result = JSON.parse(call(bin, args));
    if (result.success !== true) throw new Error('Installed hook command returned failure');
    return result.data;
  };
  const git = (...args) => call('git', args).trim();
  mkdirSync(join(project, '.cleo'), { recursive: true });
  writeFileSync(
    join(project, 'canary-check.mjs'),
    `import{appendFileSync}from'node:fs';let text='';for await(const chunk of process.stdin)text+=chunk;
const request=JSON.parse(text);if(request.source==='worktree')appendFileSync('hook-order.txt',request.event+'\\n');process.stdout.write(JSON.stringify({status:request.refs?.some(ref=>ref.remoteRef==='refs/heads/blocked')?'block':'pass'}));\n`,
  );
  writeFileSync(
    join(project, '.cleo/hooks.json'),
    JSON.stringify({
      schemaVersion: 1,
      hooks: [
        {
          id: 'canary-check',
          owner: 'project',
          executable: 'node',
          handler: 'canary-check.mjs',
          bindings: [
            { source: 'git', event: 'pre-push' },
            { source: 'agent', event: 'PreToolUse' },
            { source: 'worktree', event: 'post-create' },
            { source: 'worktree', event: 'post-start' },
            { source: 'ci', event: 'check' },
          ],
          checkerErrorPolicy: 'warn',
          timeoutMs: 10000,
        },
      ],
    }),
  );
  if (call(bin, ['hook', 'run', '--probe']).trim() !== 'CLEO_PROJECT_HOOK_V1')
    throw new Error('Installed runner probe missing');
  envelope(['hook', 'sync', '--dry-run', '--providers', 'codex,claude-code']);
  const before = envelope(['doctor', 'hooks', '--providers', 'codex,claude-code']);
  if (before.activation !== 'disabled') throw new Error('Fresh project checks were not disabled');
  git('config', 'user.name', 'Canary fixture');
  git('config', 'user.email', 'canary@example.invalid');
  git('add', '-f', 'canary-check.mjs', '.cleo/hooks.json');
  if (existsSync(join(project, '.cleo/project.json'))) git('add', '-f', '.cleo/project.json');
  git('-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test(T999): installed hooks fixture');
  envelope(['hook', 'sync', '--activate', '--providers', 'codex,claude-code']);
  const after = envelope(['doctor', 'hooks', '--providers', 'codex,claude-code']);
  if (after.activation !== 'active' || after.nativeTrust !== 'unverified')
    throw new Error('Activation/trust diagnostic incorrect');
  const direct = envelope([
    'hook',
    'check',
    'canary-check',
    '--ci',
    '--candidate',
    git('rev-parse', 'HEAD'),
  ]);
  if (!direct.outcomes?.some((outcome) => outcome.status === 'pass'))
    throw new Error('Installed CI invocation did not execute');
  if (process.platform !== 'win32') {
    const input = join(project, 'required-input.fifo');
    call('mkfifo', [input]);
    const rejected = JSON.parse(
      call(bin, ['hook', 'check', 'canary-check', '--ci', '--input', input], undefined, 1),
    );
    if (rejected.success !== false) throw new Error('Installed CI accepted a special input file');
  }
  const agentResponse = call(
    bin,
    ['hook', 'run', '--source', 'agent', '--event', 'PreToolUse', '--provider', 'codex'],
    JSON.stringify({ tool_input: { command: 'pwd' }, hook_event_name: 'PreToolUse' }),
  );
  // A successful advisory hook is silent; nonempty output must use native JSON.
  // The persisted execution receipt below proves the checker actually ran.
  if (agentResponse.trim()) {
    const response = JSON.parse(agentResponse);
    if (!response || typeof response !== 'object' || Array.isArray(response))
      throw new Error('Installed native adapter produced an invalid JSON response');
  }
  const agentReceipt = envelope([
    'doctor',
    'hooks',
    '--providers',
    'codex,claude-code',
  ]).lastExecution;
  if (
    agentReceipt?.source !== 'agent' ||
    agentReceipt.outcomes?.length !== 1 ||
    agentReceipt.outcomes[0].id !== 'canary-check' ||
    agentReceipt.outcomes[0].status !== 'pass'
  )
    throw new Error('Installed native adapter did not execute the activated checker');
  const remote = resolve(project, '..', 'hooks-remote.git');
  git('init', '--bare', '--quiet', remote);
  git('push', remote, 'HEAD:refs/heads/allowed');
  call('git', ['push', remote, 'HEAD:refs/heads/blocked'], undefined, 1);
  if (
    git('--git-dir', remote, 'for-each-ref', '--format=%(refname)').includes('refs/heads/blocked')
  )
    throw new Error('Blocked ref reached remote');
  const require = createRequire(join(installDir, 'package.json'));
  const core = await import(
    pathToFileURL(require.resolve('@cleocode/core/hooks/project-runner')).href
  );
  const worktree = await import(pathToFileURL(require.resolve('@cleocode/worktree')).href);
  const provisioned = await worktree.createWorktree(project, {
    taskId: 'T999',
    baseRef: 'HEAD',
    lockWorktree: false,
    applyIncludePatterns: false,
    projectHookExecutor: core.createProjectHookExecutor(project),
    hooks: [
      { event: 'post-create', command: 'printf "legacy-create\\n" >> hook-order.txt' },
      { event: 'post-start', command: 'printf "legacy-start\\n" >> hook-order.txt' },
    ],
  });
  if (
    !provisioned.projectHookResults?.some((outcome) => outcome.status === 'pass') ||
    !provisioned.bootstrap?.projectHookResults?.some((outcome) => outcome.status === 'pass')
  )
    throw new Error('Installed create/start lifecycle did not execute approved shared code');
  if (
    readFileSync(join(provisioned.path, 'hook-order.txt'), 'utf8') !==
    'post-create\nlegacy-create\npost-start\nlegacy-start\n'
  )
    throw new Error('Installed shared/legacy lifecycle ordering changed');
  writeFileSync(join(project, 'canary-check.mjs'), 'process.exit(1);\n');
  const drift = JSON.parse(
    call(bin, ['doctor', 'hooks', '--providers', 'codex,claude-code'], undefined, 1),
  ).data;
  if (drift.activation !== 'drifted') throw new Error('Executable drift was not detected');
  return 'installed activation, native ordinary command, actual allow/block pushes, worktree port and executable drift verified';
}

/** Pack the complete publish cohort and retain an isolated installed hook probe. */
async function packedPreflight(repoRoot) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-packed-hooks-')));
  const env = sandboxEnvironment(root);
  const tarballs = join(root, 'tarballs');
  const installDir = join(root, 'install');
  mkdirSync(tarballs);
  mkdirSync(installDir);
  const setup = (file, args, cwd, label) => {
    const result = spawnSync(file, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 16777216,
    });
    writeFileSync(join(root, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    if (result.error || result.status !== 0)
      throw new Error(`Packed setup failed (${label}); retained ${root}`);
    return result.stdout;
  };
  const overrides = {};
  let version;
  const inventory = [];
  for (const name of await readPublishedPackages(repoRoot)) {
    const cwd = join(repoRoot, 'packages', name);
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (!version) version = manifest.version;
    if (manifest.version !== version) throw new Error('Packed cohort versions disagree');
    const before = new Set(readdirSync(tarballs));
    setup('pnpm', ['pack', '--pack-destination', tarballs], cwd, `pack-${name}`);
    const added = readdirSync(tarballs).filter(
      (file) => !before.has(file) && file.endsWith('.tgz'),
    );
    if (added.length !== 1) throw new Error('Packed cohort output was ambiguous');
    const path = join(tarballs, added[0]);
    overrides[manifest.name] = `file:${path}`;
    inventory.push({
      name: manifest.name,
      version: manifest.version,
      tarball: path,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    });
  }
  if (!overrides['@cleocode/cleo'] || inventory.length === 0)
    throw new Error('Empty publish cohort');
  writeFileSync(
    join(installDir, 'package.json'),
    JSON.stringify({
      name: 'cleo-hook-preflight',
      version: '0.0.0',
      private: true,
      dependencies: overrides,
      overrides,
    }),
  );
  setup('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], installDir, 'install');
  setup(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      'const canonical = await import("@cleocode/core/tools/fs"); const legacy = await import("@cleocode/core/tools/fs.js"); await import("@cleocode/caamp"); if (canonical.writeFileAtomic !== legacy.writeFileAtomic || canonical.readFileText !== legacy.readFileText) throw new Error("Canonical filesystem exports disagree");',
    ],
    installDir,
    'canonical-fs-imports',
  );
  // Git hooks must resolve the same installed CLI that the absolute-path probes use.
  env.PATH = `${join(installDir, 'node_modules', '.bin')}${delimiter}${env.PATH ?? ''}`;
  const project = env.CLEO_PROJECT_ROOT;
  setup('git', ['init', '--quiet'], project, 'git-init');
  const bin = join(installDir, 'node_modules', '.bin', 'cleo');
  for (const entry of inventory) {
    const file = join(installDir, 'node_modules', entry.name, 'package.json');
    if (!existsSync(file) || JSON.parse(readFileSync(file, 'utf8')).version !== version)
      throw new Error(
        `Installed package ${entry.name} differs from packed cohort version; retained ${root}`,
      );
  }
  const detail = setup(
    process.execPath,
    [fileURLToPath(import.meta.url), bin, project, installDir],
    project,
    'hook-probe',
  ).trim();
  writeFileSync(
    join(root, 'evidence.json'),
    JSON.stringify(
      {
        version,
        inventory,
        detail,
        scope: 'local packed cohort; live native harness and published registry not certified',
      },
      null,
      2,
    ),
  );
  process.stdout.write(`Packed hook preflight passed. Evidence: ${root}\n`);
}

if (isMain(import.meta.url) && process.argv[2] === '--packed-preflight') {
  try {
    await packedPreflight(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Packed hook preflight failed'}\n`,
    );
    process.exitCode = 1;
  }
} else if (isMain(import.meta.url)) {
  const [bin, project, installDir] = process.argv.slice(2);
  if (!bin || !project || !installDir) {
    process.stderr.write('Usage: release-hooks-soak <cleo-bin> <project> <install-dir>\n');
    process.exitCode = 2;
  } else {
    try {
      process.stdout.write(
        `${await probeInstalledHooks({ bin, project, installDir, env: process.env })}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Installed hook probe failed'}\n`,
      );
      process.exitCode = 1;
    }
  }
}
