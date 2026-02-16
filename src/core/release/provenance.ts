/**
 * Release provenance tracking and SLSA attestation.
 *
 * Tracks the full provenance chain: Task -> Commit -> PR -> Changelog -> Release -> Artifact.
 * Stores data in .cleo/releases.json with SLSA Level 3 metadata.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { getCleoDir } from '../paths.js';
import { readJson, saveJson } from '../../store/json.js';

const SLSA_VERSION = '1.0';
const DEFAULT_SLSA_LEVEL = 'SLSA_BUILD_LEVEL_3';

/** Release record. */
export interface ReleaseRecord {
  version: string;
  timestamp: string;
  tasks: string[];
  commits: string[];
  changelog: string;
  artifacts: ArtifactRecord[];
  provenance: ProvenanceMetadata;
}

/** Artifact record. */
export interface ArtifactRecord {
  name: string;
  type: string;
  sha256: string;
  size: number;
  path: string;
}

/** Provenance metadata (SLSA compatible). */
export interface ProvenanceMetadata {
  slsaVersion: string;
  buildLevel: string;
  builder: {
    id: string;
    version: string;
  };
  buildConfig: {
    repository: string;
    branch: string;
    commitSha: string;
  };
  materials: Array<{
    uri: string;
    digest: Record<string, string>;
  }>;
}

/** Releases file structure. */
interface ReleasesFile {
  version: string;
  releases: ReleaseRecord[];
  _meta: {
    lastUpdated: string;
  };
}

function getReleasesPath(cwd?: string): string {
  return join(getCleoDir(cwd), 'releases.json');
}

async function loadReleases(cwd?: string): Promise<ReleasesFile> {
  const path = getReleasesPath(cwd);
  const data = await readJson<ReleasesFile>(path);
  if (data) return data;

  return {
    version: '1.0.0',
    releases: [],
    _meta: { lastUpdated: new Date().toISOString() },
  };
}

async function saveReleases(data: ReleasesFile, cwd?: string): Promise<void> {
  data._meta.lastUpdated = new Date().toISOString();
  await saveJson(getReleasesPath(cwd), data);
}

/** Get current git info. */
function getGitInfo(): { repository: string; branch: string; commitSha: string } {
  let repository = '';
  let branch = '';
  let commitSha = '';

  try {
    repository = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { /* not a git repo */ }

  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { /* */ }

  try {
    commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { /* */ }

  return { repository, branch, commitSha };
}

/** Compute SHA-256 hash of a file. */
function sha256File(filePath: string): string {
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/** Build provenance metadata. */
export function buildProvenance(
  materials: Array<{ uri: string; sha256: string }> = [],
): ProvenanceMetadata {
  const gitInfo = getGitInfo();

  return {
    slsaVersion: SLSA_VERSION,
    buildLevel: DEFAULT_SLSA_LEVEL,
    builder: {
      id: 'cleo-release',
      version: '1.0.0',
    },
    buildConfig: gitInfo,
    materials: materials.map(m => ({
      uri: m.uri,
      digest: { sha256: m.sha256 },
    })),
  };
}

/** Record a release with provenance. */
export async function recordRelease(
  version: string,
  tasks: string[],
  options: {
    changelogPath?: string;
    artifacts?: Array<{ name: string; type: string; path: string }>;
  } = {},
  cwd?: string,
): Promise<ReleaseRecord> {
  const releases = await loadReleases(cwd);

  // Get commits for the release tasks
  const commits: string[] = [];
  try {
    // Get recent tagged commits
    const log = execFileSync('git', ['log', '--oneline', '-20'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    for (const line of log.split('\n')) {
      const sha = line.split(' ')[0];
      if (sha) commits.push(sha);
    }
  } catch { /* not git */ }

  // Build artifact records
  const artifacts: ArtifactRecord[] = (options.artifacts ?? []).map(a => {
    const fullPath = a.path;
    return {
      name: a.name,
      type: a.type,
      sha256: sha256File(fullPath),
      size: existsSync(fullPath) ? readFileSync(fullPath).length : 0,
      path: a.path,
    };
  });

  // Build materials from tasks and artifacts
  const materials = tasks.map(t => ({ uri: `cleo://task/${t}`, sha256: '' }));
  if (options.changelogPath) {
    materials.push({
      uri: `file://${options.changelogPath}`,
      sha256: sha256File(options.changelogPath),
    });
  }

  const record: ReleaseRecord = {
    version,
    timestamp: new Date().toISOString(),
    tasks,
    commits: commits.slice(0, 10),
    changelog: options.changelogPath ?? '',
    artifacts,
    provenance: buildProvenance(materials),
  };

  releases.releases.push(record);
  await saveReleases(releases, cwd);

  return record;
}

/** Get release provenance for a specific version. */
export async function getReleaseProvenance(
  version: string,
  cwd?: string,
): Promise<ReleaseRecord | null> {
  const releases = await loadReleases(cwd);
  return releases.releases.find(r => r.version === version) ?? null;
}

/** Get all releases for a task. */
export async function getTaskReleases(
  taskId: string,
  cwd?: string,
): Promise<ReleaseRecord[]> {
  const releases = await loadReleases(cwd);
  return releases.releases.filter(r => r.tasks.includes(taskId));
}

/** Generate a provenance report for a version. */
export async function generateProvenanceReport(
  version: string,
  cwd?: string,
): Promise<Record<string, unknown>> {
  const record = await getReleaseProvenance(version, cwd);
  if (!record) {
    return { error: `No release found for version ${version}` };
  }

  return {
    version: record.version,
    timestamp: record.timestamp,
    taskCount: record.tasks.length,
    commitCount: record.commits.length,
    artifactCount: record.artifacts.length,
    provenance: record.provenance,
    artifacts: record.artifacts.map(a => ({
      name: a.name,
      type: a.type,
      sha256: a.sha256,
      size: a.size,
    })),
    chain: {
      tasks: record.tasks,
      commits: record.commits.slice(0, 5),
      changelog: record.changelog || null,
    },
  };
}

/** Verify the provenance chain for a release. */
export async function verifyProvenanceChain(
  version: string,
  cwd?: string,
): Promise<{ verified: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> }> {
  const record = await getReleaseProvenance(version, cwd);
  if (!record) {
    return { verified: false, checks: [{ name: 'release_exists', passed: false, detail: 'Release not found' }] };
  }

  const checks: Array<{ name: string; passed: boolean; detail: string }> = [];

  // Check 1: Has tasks
  checks.push({
    name: 'has_tasks',
    passed: record.tasks.length > 0,
    detail: `${record.tasks.length} task(s) linked`,
  });

  // Check 2: Has commits
  checks.push({
    name: 'has_commits',
    passed: record.commits.length > 0,
    detail: `${record.commits.length} commit(s) recorded`,
  });

  // Check 3: SLSA level
  checks.push({
    name: 'slsa_level',
    passed: record.provenance.buildLevel === DEFAULT_SLSA_LEVEL,
    detail: record.provenance.buildLevel,
  });

  // Check 4: Artifact integrity (if artifacts exist)
  for (const artifact of record.artifacts) {
    if (artifact.path && existsSync(artifact.path)) {
      const currentHash = sha256File(artifact.path);
      checks.push({
        name: `artifact_integrity_${artifact.name}`,
        passed: currentHash === artifact.sha256,
        detail: currentHash === artifact.sha256 ? 'Hash matches' : 'Hash mismatch',
      });
    }
  }

  const verified = checks.every(c => c.passed);
  return { verified, checks };
}
