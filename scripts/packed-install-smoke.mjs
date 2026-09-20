#!/usr/bin/env node
/**
 * Retained packed-install CLI smoke (T12273). Workspace packages come from local
 * tarballs; third-party dependencies may use npm's registry. Studio task readback and local embedding require actual installed execution.
 * Provider workflows and publication remain unassessed.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { captureWrapped } from '../packages/core/dist/resources/spawn-wrapper.js';

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
 * Execute setup inside the shared bounded capture lifetime; a wrapper exit is not a target verdict.
 * @param {string} command - Executable to invoke without a shell.
 * @param {string[]} args - Literal argument vector.
 * @param {Partial<import('@cleocode/contracts/resource-governor').ProcessCaptureOptions> & {timeout?: number}} options - Original context; timeout supplies a new invocation deadline only when execution is absent.
 * @returns {Promise<string>} Complete stdout after actual target success and observed cleanup.
 */
export async function runPackedCommand(command, args, options = {}) {
  const env = { ...(options.env ?? process.env) };
  const execution = options.execution
    ? { ...options.execution }
    : { deadlineAt: Date.now() + (options.timeout ?? 120_000) };
  const systemdControl = options.systemdControl ? { ...options.systemdControl } : undefined;
  const memoryMaxMb = options.memoryMaxMb ?? 4096;
  const tasksMax = options.tasksMax ?? 256;
  if (
    !Number.isSafeInteger(memoryMaxMb) ||
    memoryMaxMb < 1 ||
    memoryMaxMb > 4096 ||
    !Number.isSafeInteger(tasksMax) ||
    tasksMax < 1 ||
    tasksMax > 256
  )
    throw new RangeError('Packed command limits must not exceed 4096 MiB and 256 tasks');
  const result = await captureWrapped(command, [...args], {
    cwd: resolve(options.cwd ?? REPO_ROOT),
    env,
    execution,
    systemdControl,
    maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024,
    memoryMaxMb,
    tasksMax,
  });
  if (env.CLEO_PACKED_COMMAND_RECEIPTS) {
    mkdirSync(env.CLEO_PACKED_COMMAND_RECEIPTS, { recursive: true });
    writeFileSync(
      join(env.CLEO_PACKED_COMMAND_RECEIPTS, `${randomUUID()}.json`),
      JSON.stringify({ command, result }, null, 2),
      { mode: 0o600 },
    );
  }
  if (
    !result.started ||
    !result.targetCloseObserved ||
    result.exitCode !== 0 ||
    result.signal ||
    result.error ||
    result.stopped ||
    result.outputTruncated ||
    result.cleanupErrors.length ||
    result.cleanupObservation === 'unverified'
  ) {
    throw Object.assign(
      new Error(
        `Packed command failed: target=${result.exitCode}, signal=${result.signal}, stop=${result.stopped}, error=${result.error}, cleanup=${result.cleanupObservation}`,
      ),
      {
        stdout: result.stdout,
        stderr: result.stderr,
        capture: result,
      },
    );
  }
  return result.stdout;
}

/**
 * Exercise the actual installed Git entry, including independent initialized-file readback.
 * @param {string} app - Fresh retained npm installation.
 * @param {string} root - Owned evidence directory; the Git fixture must not already exist.
 * @param {NodeJS.ProcessEnv} env - Isolated child environment.
 * @param {Partial<import('@cleocode/contracts/resource-governor').ProcessCaptureOptions>} options - Original shared deadline, cancellation and manager connection.
 * @returns {Promise<object>} Installed executable hash, Git version and initialized repository evidence.
 */
export async function verifyPackedGit(app, root, env, options = {}) {
  const execution = options.execution
    ? { ...options.execution }
    : { deadlineAt: Date.now() + 30_000 };
  const environment = {
    ...env,
    PATH: `${join(app, 'node_modules', '.bin')}${process.platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`,
  };
  const systemdControl = options.systemdControl ? { ...options.systemdControl } : undefined;
  execution.signal?.throwIfAborted();
  if (Date.now() >= execution.deadlineAt)
    throw new Error('Original installed Git deadline expired');
  const executable = realpathSync(join(app, 'node_modules', '.bin', 'git'));
  const expectedRoot = realpathSync(join(app, 'node_modules', '@cleocode', 'git-shim'));
  if (!executable.startsWith(expectedRoot + sep))
    throw new Error('Installed Git entry escapes its package');
  const repository = join(root, 'installed-git-fixture');
  if (existsSync(repository))
    throw new Error('Installed Git fixture already exists; refusing to overwrite evidence');
  const context = { cwd: root, env: environment, execution, systemdControl };
  const version = (
    await runPackedCommand(join(app, 'node_modules', '.bin', 'git'), ['--version'], context)
  ).trim();
  if (!/^git version \S+/.test(version))
    throw new Error('Installed Git version is not a Git response');
  await runPackedCommand(
    join(app, 'node_modules', '.bin', 'git'),
    ['init', '--quiet', repository],
    context,
  );
  const top = (
    await runPackedCommand(
      join(app, 'node_modules', '.bin', 'git'),
      ['-C', repository, 'rev-parse', '--show-toplevel'],
      context,
    )
  ).trim();
  const head = readFileSync(join(repository, '.git', 'HEAD'));
  if (
    realpathSync(top) !== realpathSync(repository) ||
    !head.toString('utf8').startsWith('ref: refs/heads/') ||
    !statSync(join(repository, '.git', 'objects')).isDirectory()
  )
    throw new Error('Installed Git initialization failed independent filesystem postconditions');
  const receipt = {
    version,
    repository,
    executable,
    executableSha256: sha256(readFileSync(executable)),
    headSha256: sha256(head),
    deadlineAt: execution.deadlineAt,
  };
  writeFileSync(join(root, 'installed-git.json'), JSON.stringify(receipt, null, 2));
  return receipt;
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
    XDG_STATE_HOME: 'state',
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
    KIMI_CODE_HOME: 'kimi-code',
    KIMI_HOME: 'kimi',
    KIMI_CONFIG_DIR: 'kimi/config',
    OPENCODE_CONFIG_DIR: 'opencode',
    CURSOR_CONFIG_DIR: 'cursor',
    GEMINI_CLI_HOME: 'gemini',
    npm_config_cache: 'npm-cache',
    CLEO_PACKED_COMMAND_RECEIPTS: 'command-receipts',
  };
  for (const [key, path] of Object.entries(roots)) {
    env[key] = join(root, path);
    mkdirSync(env[key], { recursive: true });
  }
  return env;
}

/**
 * Assert synthetic data postconditions using fresh persisted rows, never provider claims.
 * @param {import('@cleocode/contracts/capabilities').ProviderRepairFixtureState} before - Independent original fixture snapshot.
 * @param {import('@cleocode/contracts/capabilities').ProviderRepairFixtureState} after - Fresh independent post-phase snapshot.
 * @param {import('@cleocode/contracts/capabilities').ProviderRepairFixtureIdentity} identity - Seed identities held by the verifier.
 * @param {import('@cleocode/contracts/capabilities').ProviderRepairVerificationPhase} phase - Required data postcondition.
 * @returns {import('@cleocode/contracts/capabilities').ProviderRepairPhaseEvidence} Authentic operation identities; command delivery remains a separate oracle.
 */
export function assertPackedProviderRepairState(before, after, identity, phase) {
  const image = (state, id) => {
    const rows = state.observations.filter((row) => row.id === id);
    if (rows.length !== 1) throw new Error(`Expected exactly one retained observation: ${id}`);
    const parsed = JSON.parse(rows[0].rowJson);
    if (parsed.id !== id) throw new Error('Observation image identity differs');
    return parsed;
  };
  const noiseIds = [identity.noiseId, ...(identity.additionalNoiseIds ?? [])];
  if (new Set(noiseIds).size !== noiseIds.length || noiseIds.includes(identity.incidentId))
    throw new Error('Seeded affected identities must be distinct from incident evidence');
  const retrievalChanges = [];
  const equal = (left, right) =>
    JSON.stringify(Object.entries(left).sort(([a], [b]) => a.localeCompare(b))) ===
    JSON.stringify(Object.entries(right).sort(([a], [b]) => a.localeCompare(b)));
  const pairs = new Map();
  for (const row of before.observations) {
    const initial = image(before, row.id);
    const current = image(after, row.id);
    const normalized = { ...current };
    if (
      initial.citation_count !== current.citation_count ||
      initial.updated_at !== current.updated_at
    ) {
      const timestamp = (value) =>
        typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
          ? Date.parse(value.replace(' ', 'T') + 'Z')
          : NaN;
      const updated = timestamp(current.updated_at);
      const previous = initial.updated_at == null ? null : timestamp(initial.updated_at);
      if (
        !Number.isSafeInteger(initial.citation_count) ||
        initial.citation_count < 0 ||
        !Number.isSafeInteger(current.citation_count) ||
        current.citation_count <= initial.citation_count ||
        !Number.isSafeInteger(before.capturedAtMs) ||
        !Number.isSafeInteger(after.capturedAtMs) ||
        before.capturedAtMs > after.capturedAtMs ||
        !Number.isFinite(updated) ||
        updated < Math.floor(before.capturedAtMs / 1000) * 1000 ||
        updated > after.capturedAtMs ||
        (previous !== null && (!Number.isFinite(previous) || updated < previous))
      )
        throw new Error(
          'Retrieval metadata changed outside the observed monotonic counter contract',
        );
      retrievalChanges.push({
        id: row.id,
        beforeCount: initial.citation_count,
        afterCount: current.citation_count,
        beforeUpdatedAt: initial.updated_at ?? null,
        afterUpdatedAt: current.updated_at,
      });
      normalized.citation_count = initial.citation_count;
      if (Object.hasOwn(initial, 'updated_at')) normalized.updated_at = initial.updated_at;
      else delete normalized.updated_at;
    }
    pairs.set(row.id, { initial, current, normalized });
  }
  if (after.observations.length !== before.observations.length)
    throw new Error('Observation population changed outside the seeded repair');
  for (const id of [identity.incidentId, ...noiseIds])
    if (!pairs.has(id)) throw new Error(`Missing seeded observation: ${id}`);
  for (const [id, { initial, normalized }] of pairs) {
    if (!noiseIds.includes(id) && !equal(initial, normalized))
      throw new Error(
        id === identity.incidentId
          ? 'Substantive incident evidence changed'
          : 'Unrelated original observation changed',
      );
  }
  const jobs = after.jobs.map((job) => {
    if (sha256(Buffer.from(job.proposalJson)) !== job.proposalHash)
      throw new Error('Prepared job input hash differs');
    return { job, proposal: JSON.parse(job.proposalJson) };
  });
  const repairs = jobs.filter(
    ({ proposal }) =>
      proposal.action?.operation === 'knowledge.quarantine-stubs' &&
      proposal.identity?.actor === identity.actor,
  );
  if (repairs.length !== 1) throw new Error('Expected one authentic prepared quarantine job');
  const { job, proposal } = repairs[0];
  if (
    proposal.projectId !== identity.projectId ||
    proposal.identity.projectId !== identity.projectId ||
    proposal.identity.operation !== 'doctor.knowledge' ||
    proposal.identity.idempotencyKey !== proposal.id
  )
    throw new Error('Prepared operation scope differs');
  if (
    proposal.resources?.length !== noiseIds.length ||
    new Set(proposal.resources.map((resource) => resource.id)).size !== noiseIds.length ||
    proposal.resources.some(
      (resource) =>
        !noiseIds.includes(resource.id) ||
        resource.role !== 'affected' ||
        resource.kind !== 'observation',
    )
  )
    throw new Error('Prepared repair affects unexpected resources');
  const metadata = (key) => {
    const matches = after.metadata.filter((entry) => entry.key === key);
    if (matches.length > 1) throw new Error('Duplicate repair metadata identity');
    return matches[0] ? JSON.parse(matches[0].valueJson) : null;
  };
  const stored = metadata(`knowledge_repair:${proposal.id}`);
  if (phase === 'prepared') {
    if (
      job.status !== 'pending' ||
      job.resultJson !== null ||
      stored !== null ||
      noiseIds.some((id) => !equal(pairs.get(id).initial, pairs.get(id).normalized))
    )
      throw new Error('Preparation mutated evidence or reported a terminal result');
    return {
      phase,
      retrievalChanges,
      jobId: job.id,
      proposalId: proposal.id,
      receiptId: null,
      rollbackReceiptId: null,
    };
  }
  const receipt = stored?.receipt;
  if (
    job.status !== 'complete' ||
    !receipt ||
    receipt.state !== 'repaired' ||
    receipt.id !== proposal.id ||
    receipt.proposalId !== proposal.id ||
    receipt.projectId !== identity.projectId ||
    receipt.execution?.jobId !== job.id ||
    receipt.execution.proposalHash !== job.proposalHash ||
    receipt.execution.identity?.actor !== identity.actor ||
    JSON.stringify(JSON.parse(job.resultJson ?? 'null')) !== JSON.stringify(receipt)
  )
    throw new Error('Committed repair and authentic job receipt do not agree');
  const mutations = receipt.execution.resources ?? [];
  if (
    mutations.length !== noiseIds.length ||
    new Set(mutations.map((resource) => resource.id)).size !== noiseIds.length ||
    mutations.some(
      (resource) =>
        !noiseIds.includes(resource.id) ||
        !/^[a-f0-9]{64}$/.test(resource.beforeHash) ||
        !/^[a-f0-9]{64}$/.test(resource.afterHash) ||
        resource.beforeHash === resource.afterHash,
    )
  )
    throw new Error('Receipt lacks a measured resource change');
  if (phase === 'repaired') {
    for (const id of noiseIds) {
      const { initial, current, normalized } = pairs.get(id);
      if (
        typeof current.invalid_at !== 'string' ||
        !current.invalid_at ||
        !equal({ ...normalized, invalid_at: initial.invalid_at }, initial)
      )
        throw new Error('Repair did not solely quarantine and retain the original observation');
    }
    if (metadata(`knowledge_rollback:${receipt.id}`) !== null)
      throw new Error('Historical repair receipt is already rolled back');
    return {
      phase,
      retrievalChanges,
      jobId: job.id,
      proposalId: proposal.id,
      receiptId: receipt.id,
      rollbackReceiptId: null,
    };
  }
  if (phase !== 'rolled-back') throw new Error('Unsupported independent repair phase');
  if (noiseIds.some((id) => !equal(pairs.get(id).initial, pairs.get(id).normalized)))
    throw new Error('Rollback did not restore the complete original observation');
  const link = metadata(`knowledge_rollback:${receipt.id}`);
  const recovery = link ? metadata(`knowledge_repair:${link.receiptId}`)?.receipt : null;
  const recoveryJob = jobs.find(
    ({ job: candidate }) => candidate.id === recovery?.execution?.jobId,
  );
  if (
    !recovery ||
    recovery.state !== 'repaired' ||
    recovery.action?.operation !== 'knowledge.rollback' ||
    recovery.action.arguments?.receiptId !== receipt.id ||
    recovery.projectId !== identity.projectId ||
    recovery.execution.identity?.actor !== identity.actor ||
    recoveryJob?.job.status !== 'complete' ||
    recoveryJob.proposal.rollback?.receiptId !== receipt.id ||
    JSON.stringify(JSON.parse(recoveryJob.job.resultJson ?? 'null')) !== JSON.stringify(recovery)
  )
    throw new Error('Rollback lacks its separate authentic recovery job and receipt');
  return {
    phase,
    retrievalChanges,
    jobId: job.id,
    proposalId: proposal.id,
    receiptId: receipt.id,
    rollbackReceiptId: recovery.id,
  };
}

/**
 * Prove that an actual stale apply failed while preserving intervening evidence.
 * @param {import('@cleocode/contracts/capabilities').ProviderRepairFixtureState} before - Snapshot after the verifier's independent source edit.
 * @param {import('@cleocode/contracts/capabilities').ProviderRepairFixtureState} after - Fresh snapshot after the provider attempted apply.
 * @param {string} jobId - Prepared identity independently read before the source edit.
 * @param {import('@cleocode/contracts/capabilities').ProviderRepairCliObservation} command - Independently observed actual CLI process, not model prose.
 * @returns {void} Throws unless command, preserved data and durable failed attempt agree.
 */
export function assertPackedProviderStaleRejection(before, after, jobId, command) {
  const original = before.jobs.find((job) => job.id === jobId);
  const current = after.jobs.find((job) => job.id === jobId);
  if (
    !original ||
    !current ||
    original.proposalJson !== current.proposalJson ||
    original.proposalHash !== current.proposalHash ||
    sha256(Buffer.from(current.proposalJson)) !== current.proposalHash
  )
    throw new Error('Stale attempt did not preserve authentic prepared inputs');
  const proposal = JSON.parse(current.proposalJson);
  const flag = (name, value) =>
    command.arguments.filter((arg) => arg === name).length === 1 &&
    command.arguments[command.arguments.indexOf(name) + 1] === value;
  if (
    command.arguments[0] !== 'doctor' ||
    command.arguments[1] !== 'knowledge' ||
    !flag('--apply', jobId) ||
    !flag('--actor', proposal.identity?.actor) ||
    !flag('--proposal-id', proposal.id) ||
    command.exitCode === null ||
    command.exitCode === 0
  )
    throw new Error('No unsuccessful apply of the authentic prepared operation was observed');
  const output = JSON.parse(command.stdout);
  if (
    output.success !== false ||
    output.error?.details?.attemptFailure?.attempt?.errorCode !== 'E_REPAIR_STALE'
  )
    throw new Error('Actual CLI did not report the observed stale-resource failure');
  for (const row of before.observations) {
    const matches = after.observations.filter((item) => item.id === row.id);
    if (matches.length !== 1 || matches[0].rowJson !== row.rowJson)
      throw new Error('Stale apply lost or modified intervening evidence');
  }
  for (const entry of before.metadata) {
    if (
      !after.metadata.some((item) => item.key === entry.key && item.valueJson === entry.valueJson)
    )
      throw new Error('Stale apply rewrote prior repair evidence');
  }
  const attempt = after.metadata
    .filter((entry) => entry.key.startsWith('knowledge_repair_attempt:'))
    .map((entry) => JSON.parse(entry.valueJson))
    .find(
      (entry) =>
        entry.jobId === jobId &&
        entry.identity?.actor === proposal.identity.actor &&
        entry.identity?.projectId === proposal.identity.projectId &&
        entry.proposalId === proposal.id &&
        entry.proposalHash === current.proposalHash &&
        entry.errorCode === 'E_REPAIR_STALE' &&
        entry.status === 'failed',
    );
  if (
    current.status !== 'failed' ||
    !attempt ||
    JSON.stringify(JSON.parse(current.resultJson ?? 'null')) !== JSON.stringify(attempt) ||
    after.metadata.some((entry) => entry.key === `knowledge_repair:${proposal.id}`)
  )
    throw new Error('Stale failure lacks a durable failed attempt or incorrectly committed repair');
}

/**
 * Verify installed packed bytes, stage managed instructions, and observe an external CLI.
 * This is deliberately a prerequisite, not a complete repair workflow certificate.
 * @param {string} app - Owned npm installation directory beneath the isolation root.
 * @param {import('@cleocode/contracts/capabilities').ProviderVerificationInvocation} input - Original bounded invocation.
 * @param {readonly import('@cleocode/contracts/package-artifact').PackageArtifactInventory[]} expected - Trusted verifier-produced npm-pack inventories, never agent output.
 * @returns {Promise<import('@cleocode/contracts/capabilities').PackedProviderProcessObservation>} Retained process and installed-file evidence.
 */
export async function verifyPackedProviderProcess(app, input, expected) {
  const invocation = {
    ...input,
    environment: { ...input.environment },
    ...(input.systemdControl ? { systemdControl: { ...input.systemdControl } } : {}),
  };
  const inventories = structuredClone(expected);
  const checkDeadline = () => {
    invocation.signal?.throwIfAborted();
    if (Date.now() >= invocation.deadlineAt)
      throw new Error('Original provider deadline expired during packed preparation');
  };
  checkDeadline();
  const root = realpathSync(invocation.isolationRoot);
  const inside = (path, parent = root) => {
    const actual = realpathSync(path);
    const suffix = relative(parent, actual);
    if (suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
      throw new Error(`Installed provider path escapes owned root: ${path}`);
    return actual;
  };
  const installed = inside(app);
  const project = inside(invocation.projectRoot);
  const artifacts = [];
  const verified = new Map();
  for (const name of ['@cleocode/cleo-os', '@cleocode/core', '@cleocode/skills']) {
    const matches = inventories.filter((entry) => entry.packageName === name);
    if (matches.length !== 1) throw new Error(`Exactly one packed inventory required: ${name}`);
    const inventory = matches[0];
    if (inventory.source !== 'npm-pack' || !/^[a-f0-9]{64}$/.test(inventory.tarballSha256 ?? ''))
      throw new Error(`Actual retained npm-pack evidence required: ${name}`);
    const packageRoot = inside(join(installed, 'node_modules', name), installed);
    const seen = new Set();
    for (const file of inventory.files) {
      checkDeadline();
      if (
        !file.path ||
        isAbsolute(file.path) ||
        file.path.split(/[\\/]/).includes('..') ||
        seen.has(file.path)
      )
        throw new Error(`Invalid or duplicate packed path: ${file.path}`);
      seen.add(file.path);
      const path = inside(join(packageRoot, file.path), packageRoot);
      if (!Number.isSafeInteger(file.size) || file.size < 0 || statSync(path).size !== file.size)
        throw new Error(`Installed provider length differs: ${name}/${file.path}`);
      const bytes = readFileSync(path);
      if (
        bytes.length !== file.size ||
        !/^[a-f0-9]{64}$/.test(file.sha256 ?? '') ||
        sha256(bytes) !== file.sha256
      )
        throw new Error(`Installed provider content differs: ${name}/${file.path}`);
      verified.set(`${name}/${file.path}`, { locator: path, sha256: file.sha256 });
    }
    if (!seen.has('package.json')) throw new Error(`Packed package manifest missing: ${name}`);
    const manifestPath = join(packageRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.name !== name || manifest.version !== inventory.version)
      throw new Error(`Installed provider package identity differs: ${name}`);
    artifacts.push(verified.get(`${name}/package.json`));
  }
  const required = (name) => {
    const artifact = verified.get(name);
    if (!artifact) throw new Error(`Required packed provider artifact missing: ${name}`);
    return artifact;
  };
  const runner = required('@cleocode/cleo-os/dist/harnesses/provider-verification.js');
  artifacts.push(runner);
  const sources = [
    required('@cleocode/core/templates/CLEO-INJECTION.md'),
    required('@cleocode/skills/skills/ct-cleo/SKILL.md'),
  ];
  const body = Buffer.concat(
    sources.flatMap((source) => [readFileSync(source.locator), Buffer.from('\n')]),
  );
  const bootstrapPath = join(
    project,
    invocation.provider === 'claude-code' ? 'CLAUDE.md' : 'AGENTS.md',
  );
  checkDeadline();
  if (existsSync(bootstrapPath)) {
    inside(bootstrapPath, project);
    if (!readFileSync(bootstrapPath).equals(body))
      throw new Error('Managed bootstrap conflicts with existing project instructions');
  } else writeFileSync(bootstrapPath, body, { flag: 'wx', mode: 0o600 });
  const bootstrap = { locator: bootstrapPath, sha256: sha256(readFileSync(bootstrapPath)) };
  if (bootstrap.sha256 !== sha256(body)) throw new Error('Managed bootstrap verification failed');
  checkDeadline();
  const { runProviderVerification } = await import(pathToFileURL(runner.locator).href);
  checkDeadline();
  if (typeof runProviderVerification !== 'function')
    throw new Error('Installed provider runner export missing');
  const process = await runProviderVerification(invocation);
  if (process.certification !== 'unverified')
    throw new Error('Installed process runner attempted unsupported capability promotion');
  return {
    artifacts,
    instructions: { sources, bootstrap, delivery: 'staged-unverified' },
    process,
    workflow: 'unverified',
    limitations: [
      'File equality is against supplied trusted pack inventories; source-to-build reproducibility is not inferred.',
      'Bootstrap bytes are staged self-contained; provider reading and reference expansion remain unverified.',
      'Retrieval, guarded repair, receipt inspection, stale rejection, verification and rollback require independent scenario oracles.',
      'External CLI process evidence does not certify CleoOS programmatic spawning or complete lifecycle containment.',
    ],
  };
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

/**
 * Verify scoped installed health observations against independently created data.
 * @param {object} body - Parsed health response from the installed Studio server.
 * @param {object} expected - Installed version, fixture paths and canonical task count.
 * @returns {void} Throws on failed/missing probes or inaccurate/incomplete disclosure.
 */
export function assertPackedHealthResponse(body, expected) {
  if (body?.service !== 'cleo-studio' || body.version !== expected.version)
    throw new Error('Studio health version differs from its installed package.');
  if (
    !['partial', 'failed'].includes(body.coverage?.status) ||
    body.okScope !== 'listed-store-probes-only' ||
    !body.coverage.observedRealms?.includes('studio-main') ||
    !body.coverage.unobservedRealms?.includes('core-main') ||
    !body.coverage.unobservedRealms?.includes('core-workers') ||
    !Array.isArray(body.coverage.limitations) ||
    body.coverage.limitations.length === 0
  )
    throw new Error('Studio health does not disclose unobserved runtime realms.');
  const probes = [
    ['tasks', 'project', 'tasks_tasks'],
    ['nexus', 'project', 'nexus_nodes'],
    ['brain', 'project', 'brain_observations'],
    ['conduit', 'project', 'conduit_messages'],
    ['project-registry', 'global', 'nexus_project_registry'],
    ['agent-registry', 'global', 'agent_registry_agents'],
  ];
  for (const [name, scope, table] of probes) {
    const report = body.databases?.[name];
    if (
      !report ||
      report.scope !== scope ||
      report.table !== table ||
      report.path !== (scope === 'project' ? expected.projectDb : expected.globalDb)
    )
      throw new Error(`Studio health ${name} has incorrect database identity or scope.`);
    if (report.coverage !== 'current') {
      if (
        !['missing', 'failed'].includes(report.coverage) ||
        report.rowCount !== null ||
        !Array.isArray(report.errors) ||
        report.errors.length === 0 ||
        (report.coverage === 'missing' && report.available !== false)
      )
        throw new Error(`Studio health ${name} disguises an unassessed count.`);
      throw new Error(`Studio health ${name} is ${report.coverage}: ${report.errors.join('; ')}`);
    }
    if (
      report.available !== true ||
      !Number.isSafeInteger(report.rowCount) ||
      report.rowCount < 0 ||
      !Array.isArray(report.errors) ||
      report.errors.length !== 0 ||
      report.lifecycle !== 'owned-read-only-snapshot' ||
      typeof report.schemaVersion !== 'string' ||
      typeof report.observedPragmas?.journal_mode !== 'string' ||
      !['foreign_keys', 'busy_timeout', 'query_only'].every(
        (pragma) => typeof report.observedPragmas?.[pragma] === 'number',
      ) ||
      report.projectId !== (scope === 'project' ? body.projectId : null)
    )
      throw new Error(`Studio health ${name} lacks truthful observed snapshot fields.`);
  }
  if (
    body.coverage.status !== 'partial' ||
    body.ok !== true ||
    body.databases.tasks.rowCount !== expected.taskCount
  )
    throw new Error('Studio health task population differs from canonical fixture writes.');
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

/** Read the actual worker's bounded scope before any runtime subprocess starts. */
function observePackedScope() {
  if (process.platform !== 'linux')
    throw new Error('Packed detached runtime requires observed Linux cgroup containment');
  const cgroupPath = /^0::(.+)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
  if (!cgroupPath || !/^cleo-tool-[\w-]+\.scope$/.test(basename(cgroupPath)))
    throw new Error('Packed detached runtime requires an observed owned systemd scope');
  const cgroup = join('/sys/fs/cgroup', cgroupPath);
  const memoryMaxBytes = Number(readFileSync(join(cgroup, 'memory.max'), 'utf8').trim());
  const memorySwapMaxBytes = Number(readFileSync(join(cgroup, 'memory.swap.max'), 'utf8').trim());
  const tasksMax = Number(readFileSync(join(cgroup, 'pids.max'), 'utf8').trim());
  const members = readFileSync(join(cgroup, 'cgroup.procs'), 'utf8')
    .trim()
    .split(/\s+/)
    .map(Number);
  if (
    !Number.isSafeInteger(memoryMaxBytes) ||
    memoryMaxBytes <= 0 ||
    memoryMaxBytes > 4 * 1024 ** 3 ||
    memorySwapMaxBytes !== 0 ||
    !Number.isSafeInteger(tasksMax) ||
    tasksMax < 1 ||
    tasksMax > 256 ||
    !members.includes(process.pid)
  )
    throw new Error('Packed runtime scope membership or memory/swap bound is unverified');
  return {
    unitName: basename(cgroupPath),
    cgroupPath,
    memoryMaxBytes,
    memorySwapMaxBytes,
    tasksMax,
    workerPid: process.pid,
    observedMembers: members,
  };
}

/**
 * Verify the complete installed runtime inside one owned, deadline-bounded scope.
 * @param {string} app - Isolated npm installation directory.
 * @param {string} root - Owned retained evidence directory.
 * @param {NodeJS.ProcessEnv} env - Isolated runtime environment.
 * @param {Partial<import('@cleocode/contracts/resource-governor').ProcessCaptureOptions>} options - Original deadline/signal and manager connection.
 * @returns {Promise<object>} Independently recorded stage results; any failed stage fails the check.
 */
export async function verifyPackedRuntime(app, root, env, options = {}) {
  const environment = { ...env };
  const execution = options.execution
    ? { ...options.execution }
    : { deadlineAt: Date.now() + 420_000 };
  const systemdControl = options.systemdControl ? { ...options.systemdControl } : undefined;
  execution.signal?.throwIfAborted();
  if (Date.now() >= execution.deadlineAt)
    throw new Error('Original packed runtime deadline expired');
  const processResult = await captureWrapped(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      '--packed-runtime-worker',
      resolve(app),
      resolve(root),
      String(execution.deadlineAt),
    ],
    {
      cwd: resolve(root),
      env: environment,
      execution,
      systemdControl,
      maxOutputBytes: 1_048_576,
      memoryMaxMb: 4096,
      tasksMax: 256,
    },
  );
  writeFileSync(join(root, 'runtime-process.json'), JSON.stringify(processResult, null, 2), {
    mode: 0o600,
  });
  if (
    !processResult.started ||
    !processResult.targetCloseObserved ||
    processResult.exitCode !== 0 ||
    processResult.signal ||
    processResult.error ||
    processResult.stopped ||
    processResult.outputTruncated ||
    processResult.mode !== 'systemd' ||
    processResult.cleanupObservation !== 'scope-terminal' ||
    processResult.cleanupErrors.length
  )
    throw new Error(
      `Packed runtime lifetime failed or remains unverified: ${processResult.stderr || processResult.error || processResult.stopped || processResult.cleanupObservation}`,
    );
  const observed = JSON.parse(readFileSync(join(root, 'runtime-scope.json'), 'utf8'));
  if (
    observed.unitName !== processResult.unitName ||
    observed.workerPid !== processResult.targetPid ||
    processResult.nativeMemory !== 'observed-cgroup' ||
    observed.cgroupPath !== processResult.resourceLimits?.cgroup
  )
    throw new Error('Packed runtime worker scope differs from the actual owned capture');
  const cgroup = join('/sys/fs/cgroup', observed.cgroupPath);
  const removed = !existsSync(cgroup);
  const remainingMembers = removed
    ? []
    : readFileSync(join(cgroup, 'cgroup.procs'), 'utf8')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
  const populated = removed
    ? false
    : /^populated 1$/m.test(readFileSync(join(cgroup, 'cgroup.events'), 'utf8'));
  writeFileSync(
    join(root, 'runtime-scope-cleanup.json'),
    JSON.stringify({ cgroupPath: observed.cgroupPath, removed, remainingMembers, populated }),
  );
  if (remainingMembers.length || populated)
    throw new Error('Owned runtime scope still contains processes after cleanup');
  return JSON.parse(processResult.stdout);
}

/** Keep deliberate Studio descendants alive until the entire observed scope ends. */
async function verifyPackedRuntimeInScope(app, root, env, deadlineAt) {
  const scope = observePackedScope();
  writeFileSync(join(root, 'runtime-scope.json'), JSON.stringify(scope));
  const runWithinScope = (command, args, options = {}) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error('Original packed runtime deadline expired');
    return execFileSync(command, args, {
      cwd: options.cwd ?? app,
      env: options.env ?? env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: Math.min(remaining, options.timeout ?? 45000),
      maxBuffer: 64 * 1024 * 1024,
    });
  };
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
    health: 'not-assessed',
    embedding: 'not-assessed',
    cleanup: 'not-assessed',
    failures: [],
  };
  const save = () =>
    writeFileSync(join(root, 'runtime.json'), JSON.stringify(receipt, null, 2) + '\n');
  const runCli = (name, args) => {
    try {
      const output = runWithinScope(process.execPath, [cli, ...args], {
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
      if (label === 'health') {
        receipt.health = 'failed';
        const studio = JSON.parse(
          readFileSync(join(app, 'node_modules/@cleocode/cleo/package.json'), 'utf8'),
        );
        assertPackedHealthResponse(JSON.parse(bytes.toString('utf8')), {
          version: studio.version,
          projectDb: join(env.CLEO_ROOT, '.cleo/cleo.db'),
          globalDb: join(env.CLEO_HOME, 'cleo.db'),
          taskCount: 2,
        });
        receipt.health = 'verified-scoped-counts-partial-realms';
      }
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
    const output = runWithinScope(
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
  const runtimeDirectory = process.env.CLEO_PACKED_SYSTEMD_RUNTIME ?? process.env.XDG_RUNTIME_DIR;
  const systemdControl = runtimeDirectory
    ? {
        runtimeDirectory,
        ...(process.env.DBUS_SESSION_BUS_ADDRESS
          ? { busAddress: process.env.DBUS_SESSION_BUS_ADDRESS }
          : {}),
      }
    : undefined;
  const tarballs = join(root, 'tarballs');
  const app = join(root, 'app');
  mkdirSync(tarballs);
  mkdirSync(app);
  const manifest = {
    scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    sourceRevision: (
      await runPackedCommand('git', ['rev-parse', 'HEAD'], { env, systemdControl })
    ).trim(),
    lockSha256: sha256(readFileSync(join(REPO_ROOT, 'pnpm-lock.yaml'))),
    packages: [],
    status: 'running',
    coverage: {
      cliVersion: 'not-assessed',
      git: 'not-assessed',
      studio: 'not-assessed',
      embedding: 'not-assessed',
      providers: 'not-assessed',
    },
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
      const output = await runPackedCommand('pnpm', ['pack', '--pack-destination', tarballs], {
        cwd,
        env: { ...env, npm_config_ignore_scripts: 'true' },
        systemdControl,
      });
      writeFileSync(join(root, `pack-${directory}.log`), output);
      const filename = `${pkg.name.replace('@', '').replaceAll('/', '-')}-${pkg.version}.tgz`;
      const tarball = join(tarballs, filename);
      const bytes = readFileSync(tarball);
      const extracted = join(root, 'extracted', directory);
      mkdirSync(extracted, { recursive: true });
      const paths = (await runPackedCommand('tar', ['-tzf', tarball], { env, systemdControl }))
        .trim()
        .split('\n');
      if (paths.some((path) => !path.startsWith('package/') || path.split('/').includes('..')))
        throw new Error(`Unsafe packed archive path in ${filename}`);
      await runPackedCommand('tar', ['-xzf', tarball, '-C', extracted, '--no-same-owner'], {
        env,
        systemdControl,
      });
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
      dependencies: {
        '@cleocode/cleo': overrides['@cleocode/cleo'],
        '@cleocode/cleo-os': overrides['@cleocode/cleo-os'],
        '@cleocode/skills': overrides['@cleocode/skills'],
      },
      overrides,
    };
    writeFileSync(join(app, 'package.json'), JSON.stringify(appManifest, null, 2) + '\n');
    const installed = await runPackedCommand(
      'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=warn'],
      { cwd: app, env, systemdControl, timeout: 300_000 },
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
    manifest.git = await verifyPackedGit(app, root, env, { systemdControl });
    manifest.coverage.git = 'verified-installed-version-and-initialization';
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
    const version = (
      await runPackedCommand(process.execPath, ['--import', guard, binary, '--version'], {
        cwd: env.CLEO_ROOT,
        env,
        timeout: 30_000,
        systemdControl,
      })
    ).trim();
    writeFileSync(join(root, 'version.txt'), version + '\n');
    assertPackedVersion(version, expected);
    manifest.coverage.cliVersion = 'verified';
    manifest.runtime = await verifyPackedRuntime(app, root, env, { systemdControl });
    manifest.coverage.health = manifest.runtime.health;
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
      manifest.coverage.health = manifest.runtime.health;
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
  const operation =
    process.argv[2] === '--packed-runtime-worker'
      ? (() => {
          const [app, root, rawDeadline] = process.argv.slice(3);
          const deadlineAt = Number(rawDeadline);
          if (!app || !root || !Number.isSafeInteger(deadlineAt) || Date.now() >= deadlineAt)
            throw new Error('Invalid or expired packed runtime worker context');
          return verifyPackedRuntimeInScope(app, root, { ...process.env }, deadlineAt).then(
            (receipt) => process.stdout.write(JSON.stringify(receipt)),
          );
        })()
      : main();
  operation.catch((error) => {
    console.error(`[packed-smoke] FAILED: ${error.message}`);
    process.exitCode = 1;
  });
}
