#!/usr/bin/env node
/**
 * Retained packed-install CLI smoke (T12273). Workspace packages come from local
 * tarballs; third-party dependencies may use npm's registry. Studio task readback and local embedding require actual installed execution.
 * Provider workflows and publication remain unassessed.
 */
import { execFileSync } from 'node:child_process';
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
import { createConnection, createServer } from 'node:net';
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

const STUDIO_GUARD =
  "import childProcess from 'node:child_process';\nimport net from 'node:net';\nimport { appendFileSync } from 'node:fs';\nimport { syncBuiltinESMExports } from 'node:module';\nconst port = Number(process.env.CLEO_TEST_STUDIO_PORT);\nconst entry = process.env.CLEO_TEST_STUDIO_ENTRY;\nconst receipt = process.env.CLEO_TEST_RUNTIME_RECEIPT;\nfunction record(action, details) { appendFileSync(receipt, JSON.stringify({pid:process.pid,action,details})+'\\n'); }\nfunction deny(action, details) { record('denied:'+action, details); throw new Error('Runtime fixture denied '+action); }\nconst spawn = childProcess.spawn;\nchildProcess.spawn = function(command, args, options) {\n if (command !== 'node' || args?.length !== 1 || args[0] !== entry) return deny('spawn', {command,args});\n const child = spawn.call(this,command,args,options); record('studio-child',{pid:child.pid,entry}); return child;\n};\nfor (const name of ['exec','execSync','execFile','execFileSync','spawnSync','fork']) childProcess[name] = (...args) => deny(name, String(args[0]));\nconst listen = net.Server.prototype.listen;\nnet.Server.prototype.listen = function(...args) {\n const opt = typeof args[0] === 'object' ? args[0] : {port:args[0],host:args[1]};\n if (Number(opt.port) !== port || opt.host !== '127.0.0.1') return deny('listen',opt);\n record('listen',{port,host:opt.host}); return listen.apply(this,args);\n};\nconst connect = net.Socket.prototype.connect;\nnet.Socket.prototype.connect = function(...args) {\n const first = Array.isArray(args[0]) ? args[0][0] : args[0];\n const opt = typeof first === 'object' ? first : {port:first,host:args[1]};\n if (Number(opt.port) !== port || opt.host !== '127.0.0.1') return deny('connect',opt);\n return connect.apply(this,args);\n};\nconst fetch = globalThis.fetch;\nglobalThis.fetch = function(input, init) {\n const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);\n if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) !== port) return deny('fetch',url.href);\n return fetch(input,init);\n};\nsyncBuiltinESMExports();\n";
const MODEL_GUARD =
  "import cp from 'node:child_process';\nimport net from 'node:net';\nimport {appendFileSync} from 'node:fs';\nimport {syncBuiltinESMExports} from 'node:module';\nconst receipt=process.env.CLEO_TEST_MODEL_RECEIPT;\nfunction record(action,details){appendFileSync(receipt,JSON.stringify({pid:process.pid,action,details})+'\\n');}\nfunction deny(action){record('denied',action);throw new Error('Model fixture denied '+action);}\nfor(const n of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[n]=()=>deny(n);\nnet.Server.prototype.listen=()=>deny('listen');\nconst allowed=host=>host==='huggingface.co'||host.endsWith('.huggingface.co')||host.endsWith('.hf.co');\nconst connect=net.Socket.prototype.connect;\nnet.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const opt=typeof first==='object'?first:{port:first,host:args[1]};if(Number(opt.port)!==443||!allowed(String(opt.host)))return deny('connect:'+opt.host+':'+opt.port);record('connect',{host:opt.host,port:opt.port});return connect.apply(this,args);};\nconst fetch=globalThis.fetch;\nglobalThis.fetch=function(input,init){const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='https:'||!allowed(url.hostname))return deny('fetch:'+url.origin);record('fetch',{origin:url.origin,path:url.pathname});return fetch(input,init);};\nsyncBuiltinESMExports();\n";
const EMBEDDING_PROBE =
  "import {env} from '@huggingface/transformers';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';import {LocalEmbeddingProvider} from '@cleocode/core/memory/embedding-local';env.cacheDir=process.env.HF_HOME;env.localModelPath=process.env.HF_HOME;env.allowLocalModels=false;const provider=new LocalEmbeddingProvider();const a=await provider.embed('Synthetic isolated packed artifact verification');const b=await provider.embed('Synthetic isolated packed artifact verification');if(a.length!==384||b.length!==384||!Array.from(a).every(Number.isFinite))throw new Error('Invalid dimensions/values');const bytes=Buffer.from(a.buffer,a.byteOffset,a.byteLength);const norm=Math.hypot(...a);if(Math.abs(norm-1)>.001)throw new Error('Invalid norm');if(!a.every((v,i)=>Math.abs(v-b[i])<1e-6))throw new Error('Repeat differs');const require=createRequire(import.meta.url);process.stdout.write(JSON.stringify({dimensions:a.length,finite:true,norm,repeatEqual:true,sha256:createHash('sha256').update(bytes).digest('hex'),nativeModules:Object.keys(require.cache).filter(p=>p.endsWith('.node')),cacheDir:env.cacheDir}));";
/**
 * Assert the canonical version envelope, including successful status and exact version.
 * @param {string} output - Captured stdout from the installed CLI.
 * @param {string} expected - Packed package version.
 * @returns {string} Verified version; throws on malformed, failed, or mismatched output.
 */
export function assertPackedVersion(output, expected) {
  const envelope = JSON.parse(output);
  if (envelope?.success !== true || envelope?.data?.version !== expected) {
    throw new Error(`Installed CLI version differs from expected ${expected}.`);
  }
  return envelope.data.version;
}

/**
 * Verify an API task list against canonical CLI-created identity and title.
 * @param {object} body - Parsed Studio tasks response.
 * @param {string} taskId - Exact identity returned by canonical CLI creation.
 * @param {string} title - Independently supplied fixture title.
 * @returns {void} Throws when the expected task content is absent.
 */
export function assertPackedTaskResponse(body, taskId, title) {
  if (
    !body ||
    !Array.isArray(body.tasks) ||
    !body.tasks.some((task) => task.id === taskId && task.title === title)
  ) {
    throw new Error(`Studio did not return canonical task ${taskId} with its expected title.`);
  }
}

async function freeLoopbackPort() {
  const server = createServer();
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No numeric loopback address.');
  await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())));
  return address.port;
}

async function portClosed(port) {
  return await new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => {
      socket.destroy();
      done(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
  });
}

/** Inspect generated cache bytes without interpreting similarity as evidence. */
function fileHashes(root) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected evidence symlink: ${path}`);
    if (entry.isDirectory()) files.push(...fileHashes(path));
    else if (entry.isFile()) {
      const bytes = readFileSync(path);
      files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  return files;
}

/**
 * Verify actual installed CLI/Studio task readback and native local embedding.
 * @param {string} app - Isolated npm installation directory.
 * @param {string} root - Owned retained evidence directory.
 * @param {NodeJS.ProcessEnv} env - Isolated runtime environment.
 * @returns {Promise<object>} Independently recorded stage results; any failed stage fails the check.
 */
export async function verifyPackedRuntime(app, root, env) {
  const cli = join(app, 'node_modules/@cleocode/cleo/dist/cli/index.js');
  const entry = join(app, 'node_modules/@cleocode/cleo/studio-dist/index.js');
  const port = await freeLoopbackPort();
  const events = join(root, 'runtime-events.jsonl');
  const guard = join(root, 'studio-guard.mjs');
  writeFileSync(guard, STUDIO_GUARD);
  const runtimeEnv = {
    ...env,
    CLEO_TEST_STUDIO_PORT: String(port),
    CLEO_TEST_STUDIO_ENTRY: entry,
    CLEO_TEST_RUNTIME_RECEIPT: events,
    NODE_OPTIONS: `--max-old-space-size=2048 --import=${guard}`,
  };
  const receipt = {
    studio: 'not-assessed',
    embedding: 'not-assessed',
    cleanup: 'not-assessed',
    failures: [],
  };
  const save = () =>
    writeFileSync(join(root, 'runtime.json'), JSON.stringify(receipt, null, 2) + '\n');
  const runCli = (name, args) => {
    try {
      const output = runPackedCommand(process.execPath, [cli, ...args], {
        cwd: env.CLEO_ROOT,
        env: runtimeEnv,
        timeout: 45_000,
      });
      writeFileSync(join(root, `${name}.stdout`), output);
      return output;
    } catch (error) {
      writeFileSync(
        join(root, `${name}.stderr`),
        `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`,
      );
      throw error;
    }
  };
  const children = () =>
    existsSync(events)
      ? readFileSync(events, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((event) => event.action === 'studio-child')
          .map((event) => event.details.pid)
      : [];
  const killOwned = (signal) => {
    for (const pid of children()) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  };
  const childRunning = (pid) => {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux') {
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
      }
      return true;
    } catch (error) {
      if (error.code === 'ESRCH' || error.code === 'ENOENT') return false;
      throw error;
    }
  };
  const interrupted = () => {
    killOwned('SIGKILL');
    receipt.cleanup = 'interrupted-owned-children-killed';
    save();
    process.exit(1);
  };
  process.once('SIGTERM', interrupted);
  process.once('SIGINT', interrupted);
  try {
    runCli('session-start', [
      'session',
      'start',
      '--scope',
      'global',
      '--name',
      'Packed artifact fixture',
    ]);
    const saga = runCli('saga-create', [
      'saga',
      'create',
      '--title',
      'Packed artifact program',
      '--description',
      'Synthetic packed runtime verification',
      '--acceptance',
      'one|two|three|four|five',
      '--output',
      'id',
    ]).trim();
    if (!/^T\d+$/.test(saga)) throw new Error('Canonical saga creation returned no exact ID.');
    const title = 'Packed artifact expected task';
    const taskId = runCli('task-create', [
      'add',
      '--type',
      'epic',
      '--parent',
      saga,
      '--title',
      title,
      '--description',
      'Synthetic installed CLI and Studio readback',
      '--acceptance',
      'one|two|three|four|five',
      '--output',
      'id',
    ]).trim();
    if (!/^T\d+$/.test(taskId)) throw new Error('Canonical task creation returned no exact ID.');
    if (runCli('task-read', ['show', taskId, '--field', '/data/task/title']).trim() !== title)
      throw new Error('Fresh CLI task readback differs.');
    runCli('web-start', ['web', 'start', '--host', '127.0.0.1', '--port', String(port)]);
    for (const [label, path] of [
      ['health', '/api/health'],
      ['tasks', '/api/tasks'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(15_000),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      writeFileSync(join(root, `${label}.body`), bytes);
      writeFileSync(
        join(root, `${label}.json`),
        JSON.stringify({ status: response.status, bytes: bytes.length, sha256: sha256(bytes) }),
      );
      if (response.status !== 200) throw new Error(`${path} returned ${response.status}`);
      if (label === 'tasks')
        assertPackedTaskResponse(JSON.parse(bytes.toString('utf8')), taskId, title);
    }
    receipt.studio = 'verified-canonical-task-readback';
  } catch (error) {
    receipt.studio = 'failed';
    receipt.failures.push(error.message);
  } finally {
    try {
      runCli('web-stop', ['web', 'stop']);
    } catch (error) {
      if (receipt.studio !== 'failed')
        receipt.failures.push(`Canonical stop failed: ${error.message}`);
    }
    killOwned('SIGTERM');
    for (
      let attempt = 0;
      attempt < 50 && (children().some(childRunning) || !(await portClosed(port)));
      attempt++
    )
      await new Promise((done) => setTimeout(done, 100));
    if (children().some(childRunning) || !(await portClosed(port))) {
      killOwned('SIGKILL');
      for (let attempt = 0; attempt < 20 && children().some(childRunning); attempt++)
        await new Promise((done) => setTimeout(done, 100));
    }
    const closed = await portClosed(port);
    const alive = children().filter(childRunning);
    receipt.cleanup = closed && !alive.length ? 'port-closed-no-running-owned-children' : 'failed';
    writeFileSync(
      join(root, 'cleanup.json'),
      JSON.stringify({
        port,
        ownedChildren: children(),
        runningChildren: alive,
        portClosed: closed,
      }),
    );
    if (!closed || alive.length)
      receipt.failures.push('Owned Studio listener or child did not terminate.');
    process.removeListener('SIGTERM', interrupted);
    process.removeListener('SIGINT', interrupted);
    save();
  }
  try {
    const modelGuard = join(root, 'model-guard.mjs');
    writeFileSync(modelGuard, MODEL_GUARD);
    const modelCache = join(root, 'model-cache');
    mkdirSync(modelCache, { recursive: true });
    const modelEnv = {
      ...env,
      NODE_OPTIONS: `--max-old-space-size=2048 --import=${modelGuard}`,
      CLEO_TEST_MODEL_RECEIPT: join(root, 'model-network.jsonl'),
      OMP_NUM_THREADS: '2',
      OPENBLAS_NUM_THREADS: '2',
      MKL_NUM_THREADS: '2',
      HF_HOME: modelCache,
      TRANSFORMERS_CACHE: modelCache,
    };
    if (process.platform !== 'linux')
      throw new Error('Bounded model CPU affinity is unverified on this platform.');
    const allowed = /^Cpus_allowed_list:\s*(.+)$/m.exec(
      readFileSync('/proc/self/status', 'utf8'),
    )?.[1];
    const cpus = [];
    for (const part of (allowed ?? '').split(',')) {
      const [start, end = start] = part.split('-').map(Number);
      for (let cpu = start; cpu <= end && cpus.length < 2; cpu++) cpus.push(cpu);
      if (cpus.length === 2) break;
    }
    if (!cpus.length || cpus.some((cpu) => !Number.isInteger(cpu)))
      throw new Error('Could not establish bounded CPU affinity.');
    const output = runPackedCommand(
      'taskset',
      ['-c', cpus.join(','), process.execPath, '--input-type=module', '-e', EMBEDDING_PROBE],
      { cwd: app, env: modelEnv, timeout: 240_000 },
    );
    const result = JSON.parse(output);
    if (
      result.dimensions !== 384 ||
      !result.finite ||
      !result.repeatEqual ||
      Math.abs(result.norm - 1) > 0.001
    )
      throw new Error('Embedding result failed independent shape/norm/repeat checks.');
    if (
      !result.nativeModules.length ||
      result.nativeModules.some((path) => !path.startsWith(join(app, 'node_modules') + '/'))
    )
      throw new Error('Native embedding modules escaped installed package identity.');
    writeFileSync(
      join(root, 'embedding.json'),
      JSON.stringify({ ...result, cpuAffinity: cpus, deadlineMs: 240_000 }, null, 2),
    );
    writeFileSync(
      join(root, 'model-manifest.json'),
      JSON.stringify(fileHashes(modelCache), null, 2),
    );
    receipt.embedding = 'verified-installed-native-inference';
  } catch (error) {
    receipt.embedding = 'failed';
    receipt.failures.push(error.message);
    writeFileSync(
      join(root, 'embedding-failure.log'),
      `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`,
    );
  }
  save();
  if (receipt.failures.length)
    throw new Error(`Packed runtime failed: ${receipt.failures.join('; ')}`);
  return receipt;
}

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
    scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    sourceRevision: runPackedCommand('git', ['rev-parse', 'HEAD']).trim(),
    lockSha256: sha256(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'))),
    packages: [],
    status: 'running',
    coverage: { cliVersion: 'not-assessed', studio: 'not-assessed', embedding: 'not-assessed' },
    limitations: [
      'Third-party dependencies may use npm registry.',
      'Extracted file hashes are compared against installed package bytes; absent packages are explicitly outside the CLI dependency graph. This Linux check does not certify other platforms or providers.',
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
      const extracted = join(root, 'extracted', directory);
      mkdirSync(extracted, { recursive: true });
      const paths = runPackedCommand('tar', ['-tzf', tarball], { env }).trim().split('\n');
      if (paths.some((path) => !path.startsWith('package/') || path.split('/').includes('..')))
        throw new Error(`Unsafe packed archive path in ${filename}`);
      runPackedCommand('tar', ['-xzf', tarball, '-C', extracted, '--no-same-owner'], { env });
      const packageRoot = join(extracted, 'package');
      const packedManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
      if (packedManifest.name !== pkg.name || packedManifest.version !== pkg.version)
        throw new Error(`Packed identity differs for ${pkg.name}`);
      const files = fileHashes(packageRoot).map((file) => ({
        ...file,
        path: file.path.slice(packageRoot.length + 1),
      }));
      overrides[pkg.name] = `file:${tarball}`;
      manifest.packages.push({
        name: pkg.name,
        version: pkg.version,
        filename,
        bytes: bytes.length,
        sha256: sha256(bytes),
        files,
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
    for (const pkg of manifest.packages) {
      const installedRoot = join(app, 'node_modules', pkg.name);
      if (!existsSync(installedRoot)) {
        pkg.installed = 'not-in-cli-dependency-graph';
        continue;
      }
      if (!realpathSync(installedRoot).startsWith(join(app, 'node_modules') + '/'))
        throw new Error(`Installed package escapes fixture: ${pkg.name}`);
      for (const file of pkg.files) {
        const installedFile = join(installedRoot, file.path);
        if (!realpathSync(installedFile).startsWith(installedRoot + '/'))
          throw new Error(`Installed file escapes package: ${file.path}`);
        const bytes = readFileSync(installedFile);
        if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
          throw new Error(`Installed content differs: ${pkg.name}/${file.path}`);
      }
      pkg.installed = 'expected-packed-files-byte-verified';
      pkg.verifiedFileCount = pkg.files.length;
    }
    save();
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
    assertPackedVersion(version, expected);
    manifest.coverage.cliVersion = 'verified';
    manifest.runtime = await verifyPackedRuntime(app, root, env);
    manifest.coverage.studio = 'verified-canonical-task-readback';
    manifest.coverage.embedding = 'verified-installed-native-inference';
    manifest.status = 'verified-packed-runtime';
    save();
    console.log(
      `[packed-smoke] Installed CLI version, Studio task readback and native embedding verified (${version}). Evidence: ${root}`,
    );
  } catch (error) {
    manifest.status = 'failed';
    const runtimePath = join(root, 'runtime.json');
    if (existsSync(runtimePath)) {
      manifest.runtime = JSON.parse(readFileSync(runtimePath, 'utf8'));
      manifest.coverage.studio = manifest.runtime.studio;
      manifest.coverage.embedding = manifest.runtime.embedding;
    }
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
