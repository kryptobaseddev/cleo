#!/usr/bin/env node
/** Stable promotion gate: source-bound retained proof and authoritative hosted CI (T13350). */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_RECORD_BYTES = 256 * 1024;
const MAX_API_BYTES = 1024 * 1024;
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|rs|json|toml|yaml|yml|sh|md|sql|cant)$/;
const TEST_PATH =
  /(?:^|\/)(?:__tests__|tests|fixtures|__fixtures__)(?:\/|$)|\.(?:test|spec)\.[^/]+$|(?:^|\/)vitest[^/]*$/;

function sourcePath(path) {
  if (TEST_PATH.test(path) || /(?:^|\/)(?:dist|node_modules|target|coverage)\//.test(path))
    return false;
  if (/^(?:CHANGELOG|docs\/|\.cleo\/)/.test(path)) return false;
  if (
    /^(?:build\.mjs|rust-toolchain\.toml|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|Cargo\.(?:toml|lock)|tsconfig[^/]*\.json)$/.test(
      path,
    )
  )
    return true;
  if (/^\.github\/workflows\/.+\.ya?ml$/.test(path)) return true;
  if (
    /^packages\/[^/]+\/(?:package\.json|(?:tsconfig|tsup|vite)[^/]*\.(?:json|ts|js|mjs))$/.test(
      path,
    )
  )
    return true;
  if (/^packages\/[^/]+\/templates\//.test(path) || /^crates\/.+\/Cargo\.lock$/.test(path))
    return true;
  return (
    SOURCE_EXTENSIONS.test(path) &&
    (/^packages\/[^/]+\/(?:src|bin|assets|templates|providers|scripts|skills)\//.test(path) ||
      /^scripts\//.test(path) ||
      /^crates\//.test(path))
  );
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Canonical JSON retains arbitrary own keys; only actual workspace manifest metadata is normalized. */
function canonicalJson(value, cohort, packageJson = false) {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item, cohort));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        if (packageJson && key === 'version') return [key, '<release-version>'];
        if (
          packageJson &&
          ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].includes(
            key,
          )
        ) {
          return [
            key,
            Object.fromEntries(
              Object.entries(value[key])
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, range]) => [name, cohort.has(name) ? '<release-cohort>' : range]),
            ),
          ];
        }
        return [key, canonicalJson(value[key], cohort)];
      }),
  );
}

/** Compute a digest from current Git-tracked runtime/build surfaces, excluding test/version metadata.
 * @param {string} root
 * @returns {import('../packages/contracts/src/release/hook-pilot.js').HookPilotSourceDigest}
 */
export function implementationSourceDigest(root) {
  const workflow = readFileSync(resolve(root, '.github/workflows/release.yml'), 'utf8');
  const dirs = [
    ...workflow.matchAll(/^\s+publish_pkg ([a-z0-9-]+)(?:\s+([@a-zA-Z0-9_./-]+))?\s*$/gm),
  ].map((match) => ({ dir: match[1], name: match[2] }));
  if (!dirs.length) throw new Error('Promotion held: publish cohort unavailable.');
  const cohort = dirs
    .map(
      ({ dir, name }) =>
        name ??
        JSON.parse(readFileSync(resolve(root, `packages/${dir}/package.json`), 'utf8')).name,
    )
    .sort();
  if (new Set(cohort).size !== cohort.length)
    throw new Error('Promotion held: duplicate publish cohort.');
  const names = new Set(cohort);
  const tracked = git(root, ['ls-files', '--cached', '-z'])
    .split('\0')
    .filter((path) => path && sourcePath(path))
    .sort();
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .some((path) => path && sourcePath(path));
  if (untracked || !tracked.length)
    throw new Error('Promotion held: runtime source is untracked or absent.');
  const hash = createHash('sha256').update('hook-pilot-source-v1\0');
  for (const path of tracked) {
    const fullPath = resolve(root, path);
    const metadata = lstatSync(fullPath);
    const mode = metadata.isSymbolicLink() ? '120000' : metadata.mode & 0o111 ? '100755' : '100644';
    let content = metadata.isSymbolicLink()
      ? readlinkSync(fullPath)
      : readFileSync(fullPath, 'utf8');
    if (!metadata.isSymbolicLink() && path.endsWith('.json'))
      content = JSON.stringify(
        canonicalJson(
          JSON.parse(content),
          names,
          /^(?:package\.json|(?:packages|crates)\/[^/]+\/package\.json)$/.test(path),
        ),
      );
    hash
      .update(`${mode}:${Buffer.byteLength(path)}:${path}${Buffer.byteLength(content)}:`)
      .update(content);
  }
  return { schemaVersion: 1, digest: hash.digest('hex'), fileCount: tracked.length, cohort };
}

function boundedBytes(path) {
  const fd = openSync(path, 'r');
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || !metadata.size || metadata.size > MAX_RECORD_BYTES)
      throw new Error('Promotion held: evidence size invalid.');
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length <= MAX_RECORD_BYTES) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (!length || length > MAX_RECORD_BYTES)
      throw new Error('Promotion held: evidence size invalid.');
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

function boundedJson(path) {
  return JSON.parse(boundedBytes(path).toString('utf8'));
}

/** Read an authoritative GitHub Actions response; unavailable or malformed responses hold promotion.
 * @param {string} endpoint
 * @returns {string}
 */
export function readHostedApi(endpoint) {
  return execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    maxBuffer: MAX_API_BYTES,
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Validate every retained receipt and re-check actual hosted CI at the exact VidaPeps commit.
 * @param {import('../packages/contracts/src/release/hook-pilot.js').HookPilotValidationOptions} options
 * @returns {Promise<import('../packages/contracts/src/release/hook-pilot.js').HookPilotValidationResult>}
 */
export async function validateHookPilotEvidence(options) {
  const {
    HOOK_PILOT_CHECKS,
    HookPilotEvidenceSchema,
    HookPilotProofSchema,
    HookPilotHostedRunSchema,
    HookPilotHostedJobsSchema,
  } = await import('../packages/contracts/dist/release/hook-pilot.js');
  const evidence = HookPilotEvidenceSchema.parse(boundedJson(options.evidencePath));
  if (evidence.vidaRepository.toLowerCase() !== options.vidaRepository.toLowerCase())
    throw new Error('Promotion held: evidence redirects the pilot repository.');
  if (evidence.canaryVersion.split('-canary.')[0] !== options.stableVersion.replace(/^v/, ''))
    throw new Error('Promotion held: canary belongs to a different stable release.');
  const source = implementationSourceDigest(options.root);
  if (source.digest !== evidence.sourceDigest)
    throw new Error('Promotion held: implementation changed since pilot.');
  const proofRoot = realpathSync(dirname(resolve(options.evidencePath)));
  for (const check of HOOK_PILOT_CHECKS) {
    const reference = evidence.checks[check];
    const proofPath = realpathSync(resolve(proofRoot, reference.path));
    const inside = relative(proofRoot, proofPath);
    if (inside.startsWith('..') || isAbsolute(inside))
      throw new Error('Promotion held: proof escapes retained artifact.');
    const proofBytes = boundedBytes(proofPath);
    if (createHash('sha256').update(proofBytes).digest('hex') !== reference.sha256)
      throw new Error('Promotion held: proof hash changed.');
    const proof = HookPilotProofSchema.parse(JSON.parse(proofBytes.toString('utf8')));
    if (
      proof.check !== check ||
      proof.canaryVersion !== evidence.canaryVersion ||
      proof.sourceDigest !== evidence.sourceDigest ||
      proof.vidaCommit !== evidence.vidaCommit ||
      proof.harnessVersions.claude !== evidence.harnessVersions.claude ||
      proof.harnessVersions.codex !== evidence.harnessVersions.codex
    )
      throw new Error('Promotion held: proof identity mismatch.');
    if (check === 'packedArtifact' || check === 'publishedCanary') {
      const expectedMode = check === 'packedArtifact' ? 'packed-artifact' : 'published-canary';
      if (
        proof.mode !== expectedMode ||
        !proof.packageVersions ||
        source.cohort.some((name) => proof.packageVersions[name] !== evidence.canaryVersion)
      )
        throw new Error('Promotion held: installed or packed cohort is not exact.');
    } else if (check === 'readOnlyDev' || check === 'readOnlyProd') {
      if (proof.mode !== 'read-only')
        throw new Error('Promotion held: environment proof is not read-only.');
    } else if (check === 'liveClaude' || check === 'liveCodex') {
      if (proof.mode !== 'live-harness' || !proof.ordinaryCommands || !proof.disposablePushes)
        throw new Error('Promotion held: live ordinary-command and disposable-push proof missing.');
    } else if (
      proof.mode !== 'hosted-ci' ||
      proof.hostedRunId !== evidence.hostedRunId ||
      proof.url?.toLowerCase() !==
        `https://github.com/${evidence.vidaRepository}/actions/runs/${evidence.hostedRunId}`.toLowerCase()
    )
      throw new Error('Promotion held: hosted proof does not identify its run.');
  }
  const api = options.readApi ?? readHostedApi;
  const endpoint = `repos/${evidence.vidaRepository}/actions/runs/${evidence.hostedRunId}`;
  const runText = api(endpoint);
  const jobsText = api(`${endpoint}/jobs?per_page=100`);
  if (Buffer.byteLength(runText) > MAX_API_BYTES || Buffer.byteLength(jobsText) > MAX_API_BYTES)
    throw new Error('Promotion held: API response too large.');
  const run = HookPilotHostedRunSchema.parse(JSON.parse(runText));
  const jobs = HookPilotHostedJobsSchema.parse(JSON.parse(jobsText));
  const expectedUrl = `https://github.com/${evidence.vidaRepository}/actions/runs/${evidence.hostedRunId}`;
  if (
    run.id !== evidence.hostedRunId ||
    run.head_sha !== evidence.vidaCommit ||
    run.repository.full_name.toLowerCase() !== evidence.vidaRepository.toLowerCase() ||
    run.path.split('@')[0] !== '.github/workflows/migration-hook-pilot.yml' ||
    run.html_url.toLowerCase() !== expectedUrl.toLowerCase()
  )
    throw new Error('Promotion held: hosted workflow identity differs from pilot.');
  const actualHostedCheck = jobs.jobs.some(
    (job) =>
      job.name === 'exact-candidate' &&
      job.status === 'completed' &&
      job.conclusion === 'success' &&
      job.runner_id > 0 &&
      job.runner_name &&
      !job.labels.includes('self-hosted') &&
      job.labels.some((label) => /^ubuntu-/.test(label)) &&
      job.steps.some(
        (step) =>
          step.name === 'Verify exact candidate with read-only migration ledger credentials' &&
          step.status === 'completed' &&
          step.conclusion === 'success',
      ),
  );
  if (!actualHostedCheck)
    throw new Error('Promotion held: no successful actual hosted migration job.');
  return {
    canaryVersion: evidence.canaryVersion,
    sourceDigest: source.digest,
    vidaCommit: evidence.vidaCommit,
    checks: [...HOOK_PILOT_CHECKS],
  };
}

/** CLI with no permissive defaults: absent proof or unavailable CI exits nonzero.
 * @param {string[]} args
 * @returns {Promise<number>}
 */
export async function hookPilotEvidenceMain(args) {
  try {
    const value = (flag) => args[args.indexOf(flag) + 1];
    if (args[0] === 'digest') {
      process.stdout.write(
        `${JSON.stringify(implementationSourceDigest(args.includes('--root') ? value('--root') : process.cwd()))}\n`,
      );
      return 0;
    }
    if (
      args[0] !== 'validate' ||
      !['--root', '--evidence', '--stable-version', '--vida-repository'].every(
        (flag) => args.includes(flag) && value(flag),
      )
    )
      throw new Error(
        'Promotion held: explicit root, retained evidence and stable version are required.',
      );
    const result = await validateHookPilotEvidence({
      root: value('--root'),
      evidencePath: value('--evidence'),
      stableVersion: value('--stable-version'),
      vidaRepository: value('--vida-repository'),
    });
    process.stdout.write(`${JSON.stringify({ success: true, data: result })}\n`);
    return 0;
  } catch {
    // Payloads and gh stderr can contain credential or environment information.
    process.stderr.write(
      'Hook pilot promotion held: missing, stale, unverifiable or failed evidence.\n',
    );
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await hookPilotEvidenceMain(process.argv.slice(2));
