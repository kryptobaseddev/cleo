# T5586 — Enhanced Release Pipeline: Implementation Spec

**Status**: READY FOR WAVE 2
**Produced by**: Wave 1 Spec Agent
**Source files read**: 5 (all verbatim, no assumptions)
**Task**: T5586

---

## Section 1: Existing Type Signatures (release-config.ts)

### `ReleaseConfig` interface (lines 43–62, verbatim)

```typescript
export interface ReleaseConfig {
  versioningScheme: string;
  tagPrefix: string;
  changelogFormat: string;
  changelogFile: string;
  artifactType: string;
  gates: ReleaseGate[];
  versionBump: {
    files: Array<{
      file: string;
      strategy: string;
      field?: string;
    }>;
  };
  security: {
    enableProvenance: boolean;
    slsaLevel: number;
    requireSignedCommits: boolean;
  };
}
```

### `ReleaseGate` interface (lines 64–70, verbatim)

```typescript
export interface ReleaseGate {
  name: string;
  type: 'tests' | 'lint' | 'audit' | 'custom';
  command: string;
  required: boolean;
}
```

### Gate return type

`runReleaseGates()` returns (from release-manifest.ts lines 454–459):

```typescript
Promise<{
  version: string;
  allPassed: boolean;
  gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }>;
  passedCount: number;
  failedCount: number;
}>
```

There is NO separate named `ReleaseGateResult` type or `PushConfig` interface in release-config.ts. The push configuration lives in release-manifest.ts as `PushPolicy` (see Section 2).

### `PushPolicy` interface (release-manifest.ts lines 622–628, verbatim)

```typescript
export interface PushPolicy {
  enabled?: boolean;
  remote?: string;
  requireCleanTree?: boolean;
  allowedBranches?: string[];
}
```

### All exported function signatures from release-config.ts

```typescript
// line 73
export function loadReleaseConfig(cwd?: string): ReleaseConfig

// line 93
export function validateReleaseConfig(config: ReleaseConfig): {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// line 132
export function getArtifactType(cwd?: string): string

// line 137
export function getReleaseGates(cwd?: string): ReleaseGate[]

// line 142
export function getChangelogConfig(cwd?: string): {
  format: string;
  file: string;
}
```

### Private constant `DEFAULTS` (lines 34–40, verbatim)

```typescript
const DEFAULTS = {
  versioningScheme: 'calver',
  tagPrefix: 'v',
  changelogFormat: 'keepachangelog',
  changelogFile: 'CHANGELOG.md',
  artifactType: 'generic-tarball',
} as const;
```

---

## Section 2: Critical Function Implementations (verbatim)

### `runReleaseGates()` — complete implementation (release-manifest.ts lines 450–574)

```typescript
export async function runReleaseGates(
  version: string,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
): Promise<{
  version: string;
  allPassed: boolean;
  gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }>;
  passedCount: number;
  failedCount: number;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releaseManifests)
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const row = rows[0]!;
  const releaseTasks: string[] = JSON.parse(row.tasksJson);

  const gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }> = [];

  gates.push({
    name: 'version_valid',
    status: isValidVersion(normalizedVersion) ? 'passed' : 'failed',
    message: isValidVersion(normalizedVersion) ? 'Version format is valid' : 'Invalid version format',
  });

  gates.push({
    name: 'has_tasks',
    status: releaseTasks.length > 0 ? 'passed' : 'failed',
    message: releaseTasks.length > 0 ? `${releaseTasks.length} tasks included` : 'No tasks in release',
  });

  gates.push({
    name: 'has_changelog',
    status: row.changelog ? 'passed' : 'failed',
    message: row.changelog ? 'Changelog generated' : 'No changelog generated. Run release.changelog first.',
  });

  const allTasks = await loadTasksFn();
  const incompleteTasks = releaseTasks.filter((id) => {
    const task = allTasks.find((t) => t.id === id);
    return task && task.status !== 'done';
  });

  gates.push({
    name: 'tasks_complete',
    status: incompleteTasks.length === 0 ? 'passed' : 'failed',
    message: incompleteTasks.length === 0
      ? 'All tasks completed'
      : `${incompleteTasks.length} tasks not completed: ${incompleteTasks.join(', ')}`,
  });

  // G2: Build artifact — dist/cli/index.js must exist (Node projects only)
  const projectRoot = cwd ?? getProjectRoot();
  const distPath = join(projectRoot, 'dist', 'cli', 'index.js');
  const isNodeProject = existsSync(join(projectRoot, 'package.json'));
  if (isNodeProject) {
    gates.push({
      name: 'build_artifact',
      status: existsSync(distPath) ? 'passed' : 'failed',
      message: existsSync(distPath) ? 'dist/cli/index.js present' : 'dist/ not built — run: npm run build',
    });
  }

  // GD1: Clean working tree (CHANGELOG.md and VERSION are allowed to be dirty)
  let workingTreeClean = true;
  let dirtyFiles: string[] = [];
  try {
    const porcelain = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe',
    });
    dirtyFiles = porcelain.split('\n').filter(l => l.trim())
      .map(l => l.slice(3).trim())
      .filter(f => f !== 'CHANGELOG.md' && f !== 'VERSION' && f !== 'package.json');
    workingTreeClean = dirtyFiles.length === 0;
  } catch { /* git not available — skip */ }
  gates.push({
    name: 'clean_working_tree',
    status: workingTreeClean ? 'passed' : 'failed',
    message: workingTreeClean
      ? 'Working tree clean (excluding CHANGELOG.md, VERSION, package.json)'
      : `Uncommitted changes in: ${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? ` (+${dirtyFiles.length - 5} more)` : ''}`,
  });

  // GD2: Branch target — stable on main, pre-release on develop
  const isPreRelease = normalizedVersion.includes('-');
  let currentBranch = '';
  try {
    currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
  } catch { /* git not available — skip */ }
  const expectedBranch = isPreRelease ? 'develop' : 'main';
  const branchOk = !currentBranch || currentBranch === expectedBranch || currentBranch === 'HEAD';
  gates.push({
    name: 'branch_target',
    status: branchOk ? 'passed' : 'failed',
    message: branchOk
      ? `On correct branch: ${currentBranch}`
      : `Expected branch '${expectedBranch}' for ${isPreRelease ? 'pre-release' : 'stable'} release, but on '${currentBranch}'`,
  });

  const allPassed = gates.every((g) => g.status === 'passed');

  return {
    version: normalizedVersion,
    allPassed,
    gates,
    passedCount: gates.filter((g) => g.status === 'passed').length,
    failedCount: gates.filter((g) => g.status === 'failed').length,
  };
}
```

**Key observation — branch_target gate (lines 547–563):**
- `isPreRelease` = `normalizedVersion.includes('-')` — a hyphen in the version string determines pre-release
- `expectedBranch` = `isPreRelease ? 'develop' : 'main'`
- `branchOk` = true if `currentBranch` is empty (git unavailable), equals expected branch, or is `'HEAD'` (detached HEAD)
- Gate name string: `'branch_target'`
- Gate passes silently when git is unavailable — this is intentional for CI compatibility

### `pushRelease()` — complete implementation (release-manifest.ts lines 655–727)

```typescript
export async function pushRelease(
  version: string,
  remote?: string,
  cwd?: string,
  opts?: { explicitPush?: boolean },
): Promise<{
  version: string;
  status: string;
  remote: string;
  pushedAt: string;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const projectRoot = getProjectRoot(cwd);
  const pushPolicy = await readPushPolicy(cwd);

  // If push policy says disabled and caller didn't explicitly pass --push, skip
  if (pushPolicy && pushPolicy.enabled === false && !opts?.explicitPush) {
    throw new Error(
      'Push is disabled by config (release.push.enabled=false). Use --push to override.'
    );
  }

  // Determine remote: explicit param > config > 'origin'
  const targetRemote = remote ?? pushPolicy?.remote ?? 'origin';

  // Check requireCleanTree
  if (pushPolicy?.requireCleanTree) {
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (statusOutput.trim().length > 0) {
      throw new Error(
        'Git working tree is not clean. Commit or stash changes before pushing (config: release.push.requireCleanTree=true).'
      );
    }
  }

  // Check allowedBranches
  if (pushPolicy?.allowedBranches && pushPolicy.allowedBranches.length > 0) {
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!pushPolicy.allowedBranches.includes(currentBranch)) {
      throw new Error(
        `Current branch '${currentBranch}' is not in allowed branches: ${pushPolicy.allowedBranches.join(', ')} (config: release.push.allowedBranches).`
      );
    }
  }

  execFileSync('git', ['push', targetRemote, '--follow-tags'], {
    cwd: projectRoot,
    timeout: 60000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    version: normalizedVersion,
    status: 'pushed',
    remote: targetRemote,
    pushedAt: new Date().toISOString(),
  };
}
```

### `markReleasePushed()` — complete signature and body (release-manifest.ts lines 734–752)

```typescript
export async function markReleasePushed(
  version: string,
  pushedAt: string,
  cwd?: string,
  provenance?: { commitSha?: string; gitTag?: string },
): Promise<void> {
  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  await db
    .update(schema.releaseManifests)
    .set({
      status: 'pushed',
      pushedAt,
      ...(provenance?.commitSha != null ? { commitSha: provenance.commitSha } : {}),
      ...(provenance?.gitTag != null ? { gitTag: provenance.gitTag } : {}),
    })
    .where(eq(schema.releaseManifests.version, normalizedVersion))
    .run();
}
```

### `releaseShip()` — complete implementation (release-engine.ts lines 315–486)

```typescript
export async function releaseShip(
  params: {
    version: string;
    epicId: string;
    remote?: string;
    dryRun?: boolean;
  },
  projectRoot?: string,
): Promise<EngineResult> {
  const { version, epicId, remote, dryRun = false } = params;

  if (!version) {
    return engineError('E_INVALID_INPUT', 'version is required');
  }
  if (!epicId) {
    return engineError('E_INVALID_INPUT', 'epicId is required');
  }

  const cwd = projectRoot ?? resolveProjectRoot();

  try {
    // Step 1: Run release gates
    const gatesResult = await runReleaseGates(
      version,
      () => loadTasks(projectRoot),
      projectRoot,
    );

    if (gatesResult && !gatesResult.allPassed) {
      const failedGates = gatesResult.gates.filter((g) => g.status === 'failed');
      return engineError('E_LIFECYCLE_GATE_FAILED', `Release gates failed for ${version}: ${failedGates.map((g) => g.name).join(', ')}`, {
        details: { gates: gatesResult.gates, failedCount: gatesResult.failedCount },
      });
    }

    // Step 2: Check epic completeness — load release tasks from manifest
    let releaseTaskIds: string[] = [];
    try {
      const manifest = await showManifestRelease(version, projectRoot);
      releaseTaskIds = (manifest as { tasks?: string[] }).tasks ?? [];
    } catch {
      // Manifest may not exist yet if prepare hasn't been called; proceed
    }

    const epicAccessor = await getAccessor(cwd);
    const epicCheck = await checkEpicCompleteness(releaseTaskIds, projectRoot, epicAccessor);
    if (epicCheck.hasIncomplete) {
      const incomplete = epicCheck.epics
        .filter((e) => e.missingChildren.length > 0)
        .map((e) => `${e.epicId}: missing ${e.missingChildren.map((c) => c.id).join(', ')}`)
        .join('; ');
      return engineError('E_LIFECYCLE_GATE_FAILED', `Epic completeness check failed: ${incomplete}`, {
        details: { epics: epicCheck.epics },
      });
    }

    // Step 3: Check for double-listing
    const allReleases = await listManifestReleases(projectRoot);
    const existingReleases = (
      (allReleases as { releases?: Array<{ version: string; tasks?: string[] }> }).releases ?? []
    ).filter((r) => r.version !== version);

    const doubleCheck = checkDoubleListing(
      releaseTaskIds,
      existingReleases.map((r) => ({ version: r.version, tasks: r.tasks ?? [] })),
    );
    if (doubleCheck.hasDoubleListing) {
      const dupes = doubleCheck.duplicates
        .map((d) => `${d.taskId} (in ${d.releases.join(', ')})`)
        .join('; ');
      return engineError('E_VALIDATION', `Double-listing detected: ${dupes}`, {
        details: { duplicates: doubleCheck.duplicates },
      });
    }

    // Step 4: Write CHANGELOG section
    const changelogResult = await generateReleaseChangelog(
      version,
      () => loadTasks(projectRoot),
      projectRoot,
    );
    const changelogPath = `${cwd}/CHANGELOG.md`;
    const generatedContent = (changelogResult as { changelog?: string }).changelog ?? '';

    if (dryRun) {
      return {
        success: true,
        data: {
          version,
          epicId,
          dryRun: true,
          wouldDo: [
            `write CHANGELOG section for ${version} (${generatedContent.length} chars)`,
            'git add CHANGELOG.md',
            `git commit -m "release: ship v${version} (${epicId})"`,
            `git tag -a v${version} -m "Release v${version}"`,
            `git push ${remote ?? 'origin'} --follow-tags`,
            'markReleasePushed(...)',
          ],
        },
      };
    }

    // Step 5: Git operations
    const gitCwd = { cwd, encoding: 'utf-8' as const, stdio: 'pipe' as const };

    try {
      execFileSync('git', ['add', 'CHANGELOG.md'], gitCwd);
    } catch (err: unknown) {
      const msg = (err as { message?: string }).message ?? String(err);
      return engineError('E_GENERAL', `git add failed: ${msg}`);
    }

    try {
      execFileSync(
        'git',
        ['commit', '-m', `release: ship v${version} (${epicId})`],
        gitCwd,
      );
    } catch (err: unknown) {
      const msg = (err as { stderr?: string; message?: string }).stderr
        ?? (err as { message?: string }).message
        ?? String(err);
      return engineError('E_GENERAL', `git commit failed: ${msg}`);
    }

    let commitSha: string | undefined;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], gitCwd).toString().trim();
    } catch {
      // Non-fatal
    }

    const gitTag = `v${version.replace(/^v/, '')}`;
    try {
      execFileSync('git', ['tag', '-a', gitTag, '-m', `Release ${gitTag}`], gitCwd);
    } catch (err: unknown) {
      const msg = (err as { stderr?: string; message?: string }).stderr
        ?? (err as { message?: string }).message
        ?? String(err);
      return engineError('E_GENERAL', `git tag failed: ${msg}`);
    }

    try {
      execFileSync('git', ['push', remote ?? 'origin', '--follow-tags'], gitCwd);
    } catch (err: unknown) {
      const execError = err as { status?: number; stderr?: string; message?: string };
      const msg = (execError.stderr ?? execError.message ?? '').slice(0, 500);
      return engineError('E_GENERAL', `git push failed: ${msg}`, {
        details: { exitCode: execError.status },
      });
    }

    // Step 6: Record provenance
    const pushedAt = new Date().toISOString();
    await markReleasePushed(version, pushedAt, projectRoot, { commitSha, gitTag });

    return {
      success: true,
      data: {
        version,
        epicId,
        commitSha,
        gitTag,
        pushedAt,
        changelog: changelogPath,
      },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message ?? String(err));
  }
}
```

### `releasePush()` — complete implementation (release-engine.ts lines 252–304)

```typescript
export async function releasePush(
  version: string,
  remote?: string,
  projectRoot?: string,
  opts?: { explicitPush?: boolean },
): Promise<EngineResult> {
  // Agent protocol guard: require manifest entry when in agent context
  if (isAgentContext()) {
    const hasEntry = await hasManifestEntry(version, projectRoot);
    if (!hasEntry) {
      return engineError('E_PROTOCOL_RELEASE',
        `Agent protocol violation: no release manifest entry for '${version}'. ` +
        'Use the full release.ship workflow (release.prepare -> release.commit -> release.tag -> release.push) ' +
        'to ensure provenance tracking. Direct release.push is not allowed in agent context without a manifest entry.',
        {
          fix: `ct release add ${version} && ct release ship ${version} --push`,
          alternatives: [
            { action: 'Prepare release first', command: `ct release add ${version}` },
            { action: 'Use full ship workflow', command: `ct release ship ${version} --push` },
          ],
        },
      );
    }
  }

  try {
    const result = await pushRelease(version, remote, projectRoot, opts);
    // Capture commit SHA for provenance and update the manifest
    let commitSha: string | undefined;
    try {
      commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: projectRoot ?? process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
      }).toString().trim();
    } catch {
      // Non-fatal: provenance capture is best-effort
    }
    const gitTag = `v${result.version.replace(/^v/, '')}`;
    await markReleasePushed(result.version, result.pushedAt, projectRoot, { commitSha, gitTag });
    return { success: true, data: result };
  } catch (err: unknown) {
    const execError = err as { status?: number; stderr?: string; message?: string };
    const message = (execError.stderr ?? execError.message ?? '').slice(0, 500);
    // Distinguish config policy errors from git errors
    if (execError.message?.includes('disabled by config') || execError.message?.includes('not in allowed branches') || execError.message?.includes('not clean')) {
      return engineError('E_VALIDATION', message);
    }
    return engineError('E_GENERAL', `Git push failed: ${message}`, {
      details: { exitCode: execError.status },
    });
  }
}
```

**Provenance recording pattern (verbatim from releasePush, lines 280–291):**
```typescript
let commitSha: string | undefined;
try {
  commitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot ?? process.cwd(),
    encoding: 'utf-8',
    stdio: 'pipe',
  }).toString().trim();
} catch {
  // Non-fatal: provenance capture is best-effort
}
const gitTag = `v${result.version.replace(/^v/, '')}`;
await markReleasePushed(result.version, result.pushedAt, projectRoot, { commitSha, gitTag });
```

---

## Section 3: Line Number Map

### release-config.ts (149 lines total)

| Function / Declaration | Start Line | End Line |
|---|---|---|
| `readConfigValueSync` (private) | 16 | 31 |
| `DEFAULTS` constant | 34 | 40 |
| `ReleaseConfig` interface | 43 | 62 |
| `ReleaseGate` interface | 64 | 70 |
| `loadReleaseConfig` | 73 | 90 |
| `validateReleaseConfig` | 93 | 129 |
| `getArtifactType` | 132 | 134 |
| `getReleaseGates` | 137 | 139 |
| `getChangelogConfig` | 142 | 148 |

### release-manifest.ts (828 lines total)

| Function / Declaration | Start Line | End Line |
|---|---|---|
| `ReleaseManifest` interface | 25 | 39 |
| `ReleaseTaskRecord` interface | 41 | 49 |
| `isValidVersion` (private) | 53 | 55 |
| `normalizeVersion` (private) | 57 | 59 |
| `rowToManifest` (private) | 61 | 77 |
| `findLatestPushedVersion` (private) | 79 | 89 |
| `prepareRelease` | 97 | 166 |
| `generateReleaseChangelog` | 172 | 310 |
| `listManifestReleases` | 316 | 342 |
| `showManifestRelease` | 348 | 370 |
| `commitRelease` | 376 | 409 |
| `tagRelease` | 415 | 444 |
| `runReleaseGates` | 450 | 574 |
| `rollbackRelease` | 580 | 620 |
| `PushPolicy` interface | 622 | 628 |
| `readPushPolicy` (private) | 634 | 641 |
| `pushRelease` | 655 | 727 |
| `markReleasePushed` | 734 | 752 |
| `migrateReleasesJsonToSqlite` | 760 | 828 |
| **branch_target gate block** | **547–563** | (within runReleaseGates) |
| **clean_working_tree gate block** | **527–545** | (within runReleaseGates) |

### release-engine.ts (486 lines total)

| Function / Declaration | Start Line | End Line |
|---|---|---|
| `isAgentContext` | 39 | 41 |
| `hasManifestEntry` | 49 | 56 |
| `loadTasks` | 61 | 70 |
| `releasePrepare` | 76 | 99 |
| `releaseChangelog` | 105 | 123 |
| `releaseList` | 129 | 138 |
| `releaseShow` | 144 | 156 |
| `releaseCommit` | 162 | 176 |
| `releaseTag` | 182 | 194 |
| `releaseGatesRun` | 200 | 216 |
| `releaseRollback` | 222 | 235 |
| `releasePush` | 252 | 304 |
| `releaseShip` | 315 | 486 |
| Step 1 (gates) in releaseShip | 337 | 348 |
| Step 2 (epic completeness) in releaseShip | 350 | 370 |
| Step 3 (double-listing) in releaseShip | 372 | 388 |
| Step 4 (changelog) in releaseShip | 390 | 416 |
| Step 5 (git ops) in releaseShip | 418 | 466 |
| Step 6 (provenance) in releaseShip | 468 | 481 |

### release.ts (93 lines total)

| Command / Block | Start Line | End Line |
|---|---|---|
| `registerReleaseCommand` | 10 | 93 |
| `release add` subcommand | 15 | 29 |
| `release plan` subcommand | 32 | 44 |
| `release ship` subcommand | 56 | 71 |
| `release list` subcommand | 73 | 78 |
| `release show` subcommand | 80 | 85 |
| `release changelog` subcommand | 87 | 92 |

### pipeline.ts (912 lines total)

| Method / Block | Start Line | End Line |
|---|---|---|
| `PipelineHandler` class declaration | 84 | 912 |
| `query()` router | 95 | 132 |
| `mutate()` router | 134 | 171 |
| `getSupportedOperations()` | 173 | 197 |
| `queryStage()` | 203 | 264 |
| `mutateStage()` | 270 | 342 |
| `queryRelease()` | 348 | 373 |
| `mutateRelease()` | 379 | 480 |
| `queryManifest()` | 486 | 531 |
| `queryPhase()` | 533 | 556 |
| `mutateManifest()` | 562 | 588 |
| `mutatePhase()` | 594 | 675 |
| `queryChain()` | 681 | 721 |
| `mutateChain()` | 727 | 852 |
| `wrapEngineResult()` | 858 | 881 |
| `errorResponse()` | 883 | 895 |
| `handleError()` | 897 | 911 |

---

## Section 4: MCP Operations (from pipeline.ts)

### Query operations registered in `getSupportedOperations()` (lines 175–183)

| Operation String | Handler Method | Delegate Function | Gateway |
|---|---|---|---|
| `release.list` | `queryRelease('list', ...)` | `releaseList(this.projectRoot)` | query |
| `release.show` | `queryRelease('show', ...)` | `releaseShow(version, this.projectRoot)` | query |

### Mutate operations registered for release sub-domain (lines 184–196)

| Operation String | Handler Method | Delegate Function | Gateway |
|---|---|---|---|
| `release.prepare` | `mutateRelease('prepare', ...)` | `releasePrepare(version, tasks, notes, projectRoot)` | mutate |
| `release.changelog` | `mutateRelease('changelog', ...)` | `releaseChangelog(version, projectRoot)` | mutate |
| `release.commit` | `mutateRelease('commit', ...)` | `releaseCommit(version, projectRoot)` | mutate |
| `release.tag` | `mutateRelease('tag', ...)` | `releaseTag(version, projectRoot)` | mutate |
| `release.push` | `mutateRelease('push', ...)` | `releasePush(version, remote, projectRoot, { explicitPush })` | mutate |
| `release.gates.run` | `mutateRelease('gates.run', ...)` | `releaseGatesRun(version, projectRoot)` | mutate |
| `release.rollback` | `mutateRelease('rollback', ...)` | `releaseRollback(version, reason, projectRoot)` | mutate |
| `release.ship` | `mutateRelease('ship', ...)` | `releaseShip({ version, epicId, remote, dryRun }, projectRoot)` | mutate |

### Full operation list across all domains (from `getSupportedOperations()` lines 176–196)

**Query:**
`stage.validate`, `stage.status`, `stage.history`, `stage.gates`, `stage.prerequisites`,
`manifest.show`, `manifest.list`, `manifest.find`, `manifest.pending`, `manifest.stats`,
`release.list`, `release.show`,
`phase.show`, `phase.list`,
`chain.show`, `chain.list`, `chain.find`

**Mutate:**
`stage.record`, `stage.skip`, `stage.reset`, `stage.gate.pass`, `stage.gate.fail`,
`release.prepare`, `release.changelog`, `release.commit`, `release.tag`, `release.push`,
`release.gates.run`, `release.rollback`, `release.ship`,
`manifest.append`, `manifest.archive`,
`phase.set`, `phase.start`, `phase.complete`, `phase.advance`, `phase.rename`, `phase.delete`,
`chain.add`, `chain.instantiate`, `chain.advance`, `chain.gate.pass`, `chain.gate.fail`

---

## Section 5: CLI Options (from release.ts)

### `release ship <version>` subcommand — current option definitions (lines 57–71)

```typescript
release
  .command('ship <version>')
  .description('Ship a release: gates → changelog → commit → tag → push')
  .requiredOption('--epic <id>', 'Epic task ID for commit message (e.g. T5576)')
  .option('--dry-run', 'Preview all actions without writing anything')
  .option('--no-push', 'Commit and tag but skip git push')
  .option('--remote <remote>', 'Git remote to push to (default: origin)')
  .action(async (version: string, opts: Record<string, unknown>) => {
    await dispatchFromCli('mutate', 'pipeline', 'release.ship', {
      version,
      epicId: opts['epic'],
      dryRun: opts['dryRun'],
      push: opts['push'] !== false,
      remote: opts['remote'],
    }, { command: 'release' });
  });
```

**Current params dispatched to `release.ship`:**
- `version` (positional argument)
- `epicId` (from `--epic`, required)
- `dryRun` (boolean, from `--dry-run`)
- `push` (boolean, from absence of `--no-push`, Commander inverts)
- `remote` (string | undefined, from `--remote`)

### Other release subcommands (for completeness)

| Subcommand | Required Options | Optional Options | Dispatches to |
|---|---|---|---|
| `release add <version>` | — | `--tasks`, `--notes`, `--target-date` | `mutate pipeline release.prepare` |
| `release plan <version>` | — | `--tasks`, `--remove`, `--notes` | `mutate pipeline release.prepare` |
| `release list` | — | — | `query pipeline release.list` |
| `release show <version>` | — | — | `query pipeline release.show` |
| `release changelog <version>` | — | — | `mutate pipeline release.changelog` |

---

## Section 6: Proposed New TypeScript Interfaces

These are DESIGNED for Wave 2 implementation. Wave 2 agents must implement these exactly.

### channel.ts — types

```typescript
// src/core/release/channel.ts

/** npm dist-tag values corresponding to release channels */
export type ReleaseChannel = 'latest' | 'beta' | 'alpha';

/**
 * Maps branch names (exact or glob) to release channels.
 * Loaded from .cleo/config.json at release.gitFlow.channelMap
 * or uses hard-coded defaults if absent.
 */
export interface ChannelConfig {
  /** Channel for 'main' branch — default: 'latest' */
  main: string;
  /** Channel for 'develop' branch — default: 'beta' */
  develop: string;
  /** Channel for feature/* branches — default: 'alpha' */
  feature: string;
  /** Optional: branch-glob-to-channel overrides (e.g. { "hotfix/*": "latest" }) */
  custom?: Record<string, string>;
}

/**
 * Result of validating that a version string matches the expected channel.
 * For 'latest': version must NOT contain a hyphen (e.g. 2026.3.16).
 * For 'beta': version SHOULD contain a '-beta' suffix.
 * For 'alpha': version SHOULD contain an '-alpha' suffix.
 * Mismatch is a warning, not a hard error (gates can still pass with a warning).
 */
export interface ChannelValidationResult {
  valid: boolean;
  /** The suffix that was expected for the channel (e.g. '-beta') */
  expected?: string;
  /** The suffix found in the version (empty string if stable) */
  actual?: string;
  message: string;
}
```

### github-pr.ts — types

```typescript
// src/core/release/github-pr.ts

/**
 * Result of detecting whether a branch has push protection enabled.
 * Detection is best-effort: gh CLI API call, falling back to a dry-run push probe.
 */
export interface BranchProtectionResult {
  protected: boolean;
  /** Which method was used to determine protection status */
  detectionMethod: 'gh-api' | 'push-dry-run' | 'unknown';
  /** Error message if detection itself failed (not indicative of protection state) */
  error?: string;
}

/**
 * Input for creating a pull request via gh CLI or falling back to manual instructions.
 */
export interface PRCreateOptions {
  /** Target branch (the base the PR merges into, e.g. 'develop' or 'main') */
  base: string;
  /** Source branch (the head branch with changes, e.g. 'feature/foo') */
  head: string;
  title: string;
  body: string;
  labels?: string[];
  /** Version string being released (used in title/body templates) */
  version: string;
  /** Epic task ID for cross-referencing in PR body (e.g. 'T5576') */
  epicId?: string;
  projectRoot?: string;
}

/**
 * Result of a createPullRequest() call.
 * mode='created'  — gh CLI successfully created the PR
 * mode='manual'   — gh CLI unavailable or failed; instructions returned for human
 * mode='skipped'  — PR creation was skipped (e.g. direct push succeeded)
 */
export interface PRResult {
  mode: 'created' | 'manual' | 'skipped';
  /** GitHub PR URL if mode='created' */
  prUrl?: string;
  /** GitHub PR number if mode='created' */
  prNumber?: number;
  /** Human-readable instructions for creating the PR manually if mode='manual' */
  instructions?: string;
  /** Error message if creation was attempted and failed */
  error?: string;
}
```

### release-config.ts additions — GitFlow and PushMode

```typescript
// To be added to src/core/release/release-config.ts

/**
 * Git Flow branch naming configuration.
 * Loaded from .cleo/config.json at release.gitFlow.
 */
export interface GitFlowConfig {
  enabled: boolean;
  branches: {
    /** Default: 'main' */
    main: string;
    /** Default: 'develop' */
    develop: string;
    /** Default: 'feature/' */
    featurePrefix: string;
    /** Default: 'hotfix/' */
    hotfixPrefix: string;
    /** Default: 'release/' */
    releasePrefix: string;
  };
}

/**
 * Controls how the release push step operates.
 * 'direct'  — push directly (current behavior, always used today)
 * 'pr'      — always create a PR instead of direct push
 * 'auto'    — detect branch protection; use PR if protected, direct push if not
 */
export type PushMode = 'direct' | 'pr' | 'auto';

/**
 * Metadata enriching a gates run result.
 * Returned alongside the existing gate array from runReleaseGates().
 */
export interface ReleaseGateMetadata {
  channel: ReleaseChannel;
  /** Whether the current branch requires a PR for this release */
  requiresPR: boolean;
  /** Branch that should be targeted for this release */
  targetBranch: string;
  /** Branch the repo is currently on */
  currentBranch: string;
}
```

### How to extend `ReleaseConfig` (before/after diff)

**Before (current, lines 43–62 of release-config.ts):**
```typescript
export interface ReleaseConfig {
  versioningScheme: string;
  tagPrefix: string;
  changelogFormat: string;
  changelogFile: string;
  artifactType: string;
  gates: ReleaseGate[];
  versionBump: {
    files: Array<{ file: string; strategy: string; field?: string }>;
  };
  security: {
    enableProvenance: boolean;
    slsaLevel: number;
    requireSignedCommits: boolean;
  };
}
```

**After (add these fields):**
```typescript
export interface ReleaseConfig {
  versioningScheme: string;
  tagPrefix: string;
  changelogFormat: string;
  changelogFile: string;
  artifactType: string;
  gates: ReleaseGate[];
  versionBump: {
    files: Array<{ file: string; strategy: string; field?: string }>;
  };
  security: {
    enableProvenance: boolean;
    slsaLevel: number;
    requireSignedCommits: boolean;
  };
  // NEW FIELDS — T5586
  gitFlow: GitFlowConfig;
  push: {
    mode: PushMode;
    channelMap: ChannelConfig;
  };
}
```

**How to extend `PushPolicy` (before/after diff):**

`PushPolicy` lives in `release-manifest.ts` (lines 622–628). It is NOT in `release-config.ts`. This is an important distinction.

**Before:**
```typescript
export interface PushPolicy {
  enabled?: boolean;
  remote?: string;
  requireCleanTree?: boolean;
  allowedBranches?: string[];
}
```

**After (add these fields):**
```typescript
export interface PushPolicy {
  enabled?: boolean;
  remote?: string;
  requireCleanTree?: boolean;
  allowedBranches?: string[];
  // NEW FIELDS — T5586
  mode?: PushMode;           // 'direct' | 'pr' | 'auto'  (default: 'direct')
  prBase?: string;           // override PR target branch (default: auto-detected from GitFlow)
}
```

**How `loadReleaseConfig()` should load the new fields (additions to lines 73–90):**
```typescript
export function loadReleaseConfig(cwd?: string): ReleaseConfig {
  return {
    // ... existing fields unchanged ...
    // NEW:
    gitFlow: {
      enabled: readConfigValueSync('release.gitFlow.enabled', false, cwd) as boolean,
      branches: {
        main: readConfigValueSync('release.gitFlow.branches.main', 'main', cwd) as string,
        develop: readConfigValueSync('release.gitFlow.branches.develop', 'develop', cwd) as string,
        featurePrefix: readConfigValueSync('release.gitFlow.branches.featurePrefix', 'feature/', cwd) as string,
        hotfixPrefix: readConfigValueSync('release.gitFlow.branches.hotfixPrefix', 'hotfix/', cwd) as string,
        releasePrefix: readConfigValueSync('release.gitFlow.branches.releasePrefix', 'release/', cwd) as string,
      },
    },
    push: {
      mode: readConfigValueSync('release.push.mode', 'direct', cwd) as PushMode,
      channelMap: {
        main: readConfigValueSync('release.push.channelMap.main', 'latest', cwd) as string,
        develop: readConfigValueSync('release.push.channelMap.develop', 'beta', cwd) as string,
        feature: readConfigValueSync('release.push.channelMap.feature', 'alpha', cwd) as string,
        custom: readConfigValueSync('release.push.channelMap.custom', undefined, cwd) as Record<string, string> | undefined,
      },
    },
  };
}
```

---

## Section 7: Function Signatures for New Files

### `src/core/release/channel.ts` — all exports

```typescript
import type { ReleaseChannel, ChannelConfig, ChannelValidationResult } from './channel.js';

/**
 * Resolve a release channel from a git branch name.
 * Uses GitFlow naming conventions and optional config overrides.
 * Priority: custom glob matches > exact branch names > prefix matches > 'alpha' fallback.
 *
 * Examples:
 *   'main'         → 'latest'
 *   'develop'      → 'beta'
 *   'feature/foo'  → 'alpha'
 *   'hotfix/bar'   → 'latest' (hotfix targets main)
 *
 * @param branch   The current git branch name (e.g. 'main', 'develop', 'feature/foo')
 * @param config   Optional channel config; if omitted, uses getDefaultChannelConfig()
 */
export function resolveChannelFromBranch(branch: string, config?: ChannelConfig): ReleaseChannel

/**
 * Convert a ReleaseChannel to its npm dist-tag string.
 * 'latest' → 'latest'
 * 'beta'   → 'beta'
 * 'alpha'  → 'alpha'
 */
export function channelToDistTag(channel: ReleaseChannel): string

/**
 * Validate that a version string is consistent with a channel.
 * Rules:
 *   'latest': version must NOT contain a hyphen (e.g. '2026.3.16' is valid, '2026.3.16-beta.1' is not)
 *   'beta':   version SHOULD contain '-beta' (warning if missing, not a hard failure)
 *   'alpha':  version SHOULD contain '-alpha' (warning if missing, not a hard failure)
 *
 * @param version  The normalized version string (with or without leading 'v')
 * @param channel  The resolved channel
 */
export function validateVersionChannel(version: string, channel: ReleaseChannel): ChannelValidationResult

/**
 * Return the default ChannelConfig (no config file required).
 * main → 'latest', develop → 'beta', feature → 'alpha'
 */
export function getDefaultChannelConfig(): ChannelConfig
```

### `src/core/release/github-pr.ts` — all exports

```typescript
import type { BranchProtectionResult, PRCreateOptions, PRResult } from './github-pr.js';

/**
 * Synchronously check whether the 'gh' CLI binary is available on PATH.
 * Uses execFileSync with '--version' and catches any error.
 */
export function isGhCliAvailable(): boolean

/**
 * Detect whether a branch has push protection (i.e., requires a PR).
 * Detection strategy:
 *   1. If gh CLI is available: `gh api repos/{owner}/{repo}/branches/{branch}/protection`
 *      — if HTTP 200: protected=true, detectionMethod='gh-api'
 *      — if HTTP 404: protected=false, detectionMethod='gh-api'
 *   2. If gh CLI unavailable: attempt `git push --dry-run {remote} HEAD:{branch}`
 *      — if exit code 0: protected=false, detectionMethod='push-dry-run'
 *      — if exit non-zero and stderr mentions "protected": protected=true, detectionMethod='push-dry-run'
 *   3. If both methods fail: protected=false, detectionMethod='unknown', error=<message>
 *
 * @param branch      Branch name to check (e.g. 'main')
 * @param remote      Git remote name (e.g. 'origin')
 * @param projectRoot Optional working directory override
 */
export async function detectBranchProtection(branch: string, remote: string, projectRoot?: string): Promise<BranchProtectionResult>

/**
 * Create a pull request via the gh CLI.
 * Falls back to returning manual instructions if gh CLI is unavailable or fails.
 *
 * On success: returns { mode: 'created', prUrl, prNumber }
 * On gh failure: returns { mode: 'manual', instructions }
 *
 * @param opts  PR creation options
 */
export async function createPullRequest(opts: PRCreateOptions): Promise<PRResult>

/**
 * Format human-readable instructions for manually creating a PR.
 * Used as the fallback when gh CLI is unavailable.
 * Returns a multi-line string suitable for stdout output.
 *
 * @param opts  The same PRCreateOptions passed to createPullRequest
 */
export function formatManualPRInstructions(opts: PRCreateOptions): string

/**
 * Extract repository owner and name from a git remote URL.
 * Handles both HTTPS (https://github.com/owner/repo.git)
 * and SSH (git@github.com:owner/repo.git) formats.
 *
 * Returns null if the URL cannot be parsed.
 *
 * @param remote  The output of `git remote get-url origin`
 */
export function extractRepoOwnerAndName(remote: string): { owner: string; repo: string } | null
```

---

## Section 8: Modification Plan for release-manifest.ts

### 8.1 Enhanced `branch_target` gate (lines 547–563)

**Current logic (lines 547–563):**
```
const isPreRelease = normalizedVersion.includes('-');
let currentBranch = '';
try { currentBranch = execFileSync(...).trim(); } catch {}
const expectedBranch = isPreRelease ? 'develop' : 'main';
const branchOk = !currentBranch || currentBranch === expectedBranch || currentBranch === 'HEAD';
gates.push({ name: 'branch_target', status: branchOk ? 'passed' : 'failed', message: ... });
```

**What to change:**

The `branch_target` gate must be enhanced to use `GitFlowConfig` when available. Replace lines 547–563 with:

```typescript
// GD2: Branch target — use GitFlow config if available, else defaults
const isPreRelease = normalizedVersion.includes('-');
let currentBranch = '';
try {
  currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe',
  }).trim();
} catch { /* git not available — skip */ }

// NEW: import resolveChannelFromBranch from channel.ts at top of file
// NEW: import loadReleaseConfig from release-config.ts at top of file
const releaseConfig = loadReleaseConfig(cwd);
const channelConfig = releaseConfig.push?.channelMap;
const gitFlowConfig = releaseConfig.gitFlow;
const expectedBranch = isPreRelease
  ? (gitFlowConfig?.branches?.develop ?? 'develop')
  : (gitFlowConfig?.branches?.main ?? 'main');
const branchOk = !currentBranch || currentBranch === expectedBranch || currentBranch === 'HEAD';

// NEW: capture channel for metadata return
const channel = currentBranch
  ? resolveChannelFromBranch(currentBranch, channelConfig)
  : (isPreRelease ? 'beta' : 'latest');

gates.push({
  name: 'branch_target',
  status: branchOk ? 'passed' : 'failed',
  message: branchOk
    ? `On correct branch: ${currentBranch} (channel: ${channel})`
    : `Expected branch '${expectedBranch}' for ${isPreRelease ? 'pre-release' : 'stable'} release, but on '${currentBranch}'`,
});
```

### 8.2 New `branch_protection` gate

Add immediately AFTER the `branch_target` gate push (after line 563), BEFORE the `allPassed` calculation (line 565):

```typescript
// GD3: Branch protection — detect if push requires a PR
// Import: import { detectBranchProtection } from './github-pr.js';
// Import: import { PushMode } from './channel.js';
const pushMode: PushMode = releaseConfig.push?.mode ?? 'direct';
let requiresPR = false;
if (pushMode === 'pr') {
  requiresPR = true;
} else if (pushMode === 'auto') {
  // Best-effort detection — gate always passes; requiresPR used downstream
  const protectionResult = await detectBranchProtection(expectedBranch, 'origin', projectRoot);
  requiresPR = protectionResult.protected;
}
// This gate always passes — it is informational metadata for the engine layer
gates.push({
  name: 'branch_protection',
  status: 'passed',
  message: requiresPR
    ? `Branch '${expectedBranch}' is protected — release.ship will create a PR`
    : `Branch '${expectedBranch}' allows direct push`,
});
```

### 8.3 Return type extension for `runReleaseGates()`

**Current return type (lines 454–459):**
```typescript
Promise<{
  version: string;
  allPassed: boolean;
  gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }>;
  passedCount: number;
  failedCount: number;
}>
```

**New return type (add `metadata` field):**
```typescript
Promise<{
  version: string;
  allPassed: boolean;
  gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }>;
  passedCount: number;
  failedCount: number;
  // NEW:
  metadata: ReleaseGateMetadata;  // { channel, requiresPR, targetBranch, currentBranch }
}>
```

The `metadata` object is built from the variables captured during gate evaluation and appended to the return statement (currently line 566–573).

### 8.4 Parameters to add to `pushRelease()`

**Current signature (line 655–665):**
```typescript
export async function pushRelease(
  version: string,
  remote?: string,
  cwd?: string,
  opts?: { explicitPush?: boolean },
): Promise<{ version: string; status: string; remote: string; pushedAt: string; }>
```

**New signature:**
```typescript
export async function pushRelease(
  version: string,
  remote?: string,
  cwd?: string,
  opts?: {
    explicitPush?: boolean;
    mode?: PushMode;        // NEW: 'direct' | 'pr' | 'auto'
    prBase?: string;        // NEW: override target branch for PR
    epicId?: string;        // NEW: for PR title/body
    guided?: boolean;       // NEW: if true, print step output to stdout
  },
): Promise<{
  version: string;
  status: string;
  remote: string;
  pushedAt: string;
  // NEW:
  prResult?: PRResult;      // set when a PR was created or instructions were returned
}>
```

---

## Section 9: Modification Plan for release-engine.ts

### 9.1 Imports to add at the top (after line 30)

```typescript
// Add to existing imports block in release-engine.ts:
import { resolveChannelFromBranch, validateVersionChannel } from '../../core/release/channel.js';
import { detectBranchProtection, createPullRequest } from '../../core/release/github-pr.js';
import type { ReleaseChannel, PushMode, PRResult } from '../../core/release/channel.js';
```

### 9.2 `releaseShip()` — `params` type extension

**Current params type (line 316–321):**
```typescript
params: {
  version: string;
  epicId: string;
  remote?: string;
  dryRun?: boolean;
}
```

**New params type:**
```typescript
params: {
  version: string;
  epicId: string;
  remote?: string;
  dryRun?: boolean;
  guided?: boolean;    // NEW: emit human-readable step output to stdout
  channel?: string;    // NEW: override channel (default: auto-resolved from branch)
  pushMode?: PushMode; // NEW: override push mode from config
}
```

### 9.3 `releaseShip()` — where to add guided output

The guided output step calls happen BEFORE each existing step. Insert immediately after `const { version, epicId, remote, dryRun = false } = params;` (line 324):

```typescript
const { version, epicId, remote, dryRun = false, guided = false, channel: channelOverride, pushMode } = params;

// NEW: Resolve channel
const currentBranch = /* execFileSync git rev-parse ... */ '';  // best-effort
const resolvedChannel: ReleaseChannel = (channelOverride as ReleaseChannel | undefined)
  ?? resolveChannelFromBranch(currentBranch);

if (guided) {
  process.stdout.write(`[release] channel: ${resolvedChannel} | branch: ${currentBranch}\n`);
}
```

Then within Step 1 (gates, line 337), add guided output before the `runReleaseGates()` call:
```typescript
if (guided) process.stdout.write('[1/6] Running release gates...\n');
const gatesResult = await runReleaseGates(...);
if (guided) {
  const status = gatesResult.allPassed ? 'PASSED' : 'FAILED';
  process.stdout.write(`[1/6] Gates: ${status} (${gatesResult.passedCount}/${gatesResult.passedCount + gatesResult.failedCount})\n`);
}
```

Continue pattern for each step (2–6). Each `if (guided)` block writes to `process.stdout.write()` (not console.log, to avoid log level filtering).

### 9.4 `releaseShip()` — wrapping push step with PR fallback

The current push step is at lines 458–466:
```typescript
try {
  execFileSync('git', ['push', remote ?? 'origin', '--follow-tags'], gitCwd);
} catch (err: unknown) {
  const execError = err as { status?: number; stderr?: string; message?: string };
  const msg = (execError.stderr ?? execError.message ?? '').slice(0, 500);
  return engineError('E_GENERAL', `git push failed: ${msg}`, {
    details: { exitCode: execError.status },
  });
}
```

**Replace with:**
```typescript
// NEW: Determine effective push mode
const effectivePushMode: PushMode = pushMode ?? (releaseConfig.push?.mode ?? 'direct');
let prResult: PRResult | undefined;

if (effectivePushMode === 'direct') {
  // Existing behavior — direct push
  try {
    execFileSync('git', ['push', remote ?? 'origin', '--follow-tags'], gitCwd);
  } catch (err: unknown) {
    const execError = err as { status?: number; stderr?: string; message?: string };
    const msg = (execError.stderr ?? execError.message ?? '').slice(0, 500);
    return engineError('E_GENERAL', `git push failed: ${msg}`, {
      details: { exitCode: execError.status },
    });
  }
} else if (effectivePushMode === 'pr' || effectivePushMode === 'auto') {
  // NEW: Try direct push first if 'auto', detect protection
  if (effectivePushMode === 'auto') {
    const protection = await detectBranchProtection(/* expectedBranch from gates metadata */, remote ?? 'origin', cwd);
    if (!protection.protected) {
      // Direct push path
      try {
        execFileSync('git', ['push', remote ?? 'origin', '--follow-tags'], gitCwd);
        prResult = { mode: 'skipped' };
      } catch (err: unknown) {
        const execError = err as { status?: number; stderr?: string; message?: string };
        const msg = (execError.stderr ?? execError.message ?? '').slice(0, 500);
        return engineError('E_GENERAL', `git push failed: ${msg}`, { details: { exitCode: execError.status } });
      }
    }
  }
  // PR path (either mode='pr', or mode='auto' and branch is protected)
  if (!prResult || prResult.mode !== 'skipped') {
    prResult = await createPullRequest({
      base: /* expectedBranch from gates metadata or config */ 'main',
      head: currentBranch,
      title: `release: ship v${version}`,
      body: `Release v${version}\n\nEpic: ${epicId}`,
      version,
      epicId,
      projectRoot: cwd,
    });
    if (guided && prResult.mode === 'manual') {
      process.stdout.write(`\n${prResult.instructions}\n`);
    }
    if (guided && prResult.mode === 'created') {
      process.stdout.write(`[5/6] Pull request created: ${prResult.prUrl}\n`);
    }
  }
}
```

### 9.5 Channel captured and passed to provenance

After resolving the channel (Section 9.3), capture it for use in the provenance step (Step 6, currently line 469–470):

```typescript
// Step 6 becomes:
const pushedAt = new Date().toISOString();
await markReleasePushed(version, pushedAt, projectRoot, {
  commitSha,
  gitTag,
  // NEW — if markReleasePushed adds channel support:
  // channel: resolvedChannel,
});

return {
  success: true,
  data: {
    version,
    epicId,
    commitSha,
    gitTag,
    pushedAt,
    changelog: changelogPath,
    channel: resolvedChannel,   // NEW
    prResult,                   // NEW (undefined if direct push)
  },
};
```

---

## Section 10: Modification Plan for pipeline.ts and release.ts

### 10.1 New operation `release.channel.show` in pipeline.ts

**Where to add:** In `queryRelease()` method (currently lines 348–373). Add a new `case` before `default:`.

**Operation string:** `'release.channel.show'`
**Gateway:** query
**Handler:** New inline logic or delegate to a new engine function `releaseChannelShow()`

```typescript
case 'channel.show': {
  // NEW operation: resolves the channel from the current git branch
  // Delegate to a new releaseChannelShow() engine function (to be created in release-engine.ts)
  const result = await releaseChannelShow(this.projectRoot);
  return this.wrapEngineResult(result, 'query', 'release.channel.show', startTime);
}
```

**Add to `getSupportedOperations()` query array (line 176–183):**
```typescript
query: [
  // ... existing entries ...
  'release.list', 'release.show', 'release.channel.show',  // NEW
  // ...
],
```

**New engine function to add to release-engine.ts:**
```typescript
export async function releaseChannelShow(projectRoot?: string): Promise<EngineResult> {
  try {
    // Get current branch
    const { execFileSync } = await import('node:child_process');
    let currentBranch = 'unknown';
    try {
      currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: projectRoot ?? process.cwd(),
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch { /* git unavailable */ }

    const { loadReleaseConfig } = await import('../../core/release/release-config.js');
    const releaseConfig = loadReleaseConfig(projectRoot);
    const channel = resolveChannelFromBranch(currentBranch, releaseConfig.push?.channelMap);
    const distTag = channelToDistTag(channel);

    return {
      success: true,
      data: { currentBranch, channel, distTag },
    };
  } catch (err: unknown) {
    return engineError('E_GENERAL', (err as Error).message);
  }
}
```

### 10.2 Params to thread for `guided` and `channel` override

**In `mutateRelease()` `case 'ship':` (currently lines 460–474 of pipeline.ts):**

```typescript
case 'ship': {
  const version = params?.version as string;
  const epicId = params?.epicId as string;
  if (!version || !epicId) {
    return this.errorResponse('mutate', 'release.ship', 'E_INVALID_INPUT',
      'version and epicId are required', startTime);
  }
  const remote = params?.remote as string | undefined;
  const dryRun = params?.dryRun as boolean | undefined;
  // NEW params:
  const guided = params?.guided as boolean | undefined;
  const channel = params?.channel as string | undefined;
  const pushMode = params?.pushMode as string | undefined;
  const result = await releaseShip(
    { version, epicId, remote, dryRun, guided, channel, pushMode: pushMode as PushMode | undefined },
    this.projectRoot,
  );
  return this.wrapEngineResult(result, 'mutate', 'release.ship', startTime);
}
```

### 10.3 Option definitions to add to `release ship` CLI subcommand (release.ts)

Add these `.option()` calls to the `release ship` subcommand definition (after line 62, before `.action()`):

```typescript
.option('--guided', 'Print human-readable step output as the release progresses')
.option('--channel <channel>', 'Override channel (latest|beta|alpha) — default: auto-resolved from branch')
.option('--push-mode <mode>', 'Push mode: direct|pr|auto (default: direct or from config)')
.option('--bump-version', 'Bump VERSION and package.json before shipping')
```

**Updated `.action()` handler** to pass new params:
```typescript
.action(async (version: string, opts: Record<string, unknown>) => {
  await dispatchFromCli('mutate', 'pipeline', 'release.ship', {
    version,
    epicId: opts['epic'],
    dryRun: opts['dryRun'],
    push: opts['push'] !== false,
    remote: opts['remote'],
    // NEW:
    guided: opts['guided'],
    channel: opts['channel'],
    pushMode: opts['pushMode'],
    bumpVersion: opts['bumpVersion'],
  }, { command: 'release' });
});
```

---

## Appendix A: Key Observations for Wave 2 Agents

1. **PushPolicy vs ReleaseConfig**: `PushPolicy` is in `release-manifest.ts`, NOT in `release-config.ts`. `ReleaseConfig` is the top-level config from `.cleo/config.json`. `PushPolicy` is read separately by `readPushPolicy()` (private). Wave 2 must decide whether to consolidate these or keep them separate.

2. **branch_target gate is currently binary**: It only compares to `'main'` or `'develop'` (hardcoded). The enhanced version must read from `GitFlowConfig` first, then fall back to hardcoded defaults.

3. **`branchOk` allows HEAD**: Line 556 `currentBranch === 'HEAD'` passes the gate for detached HEAD state. This must be preserved.

4. **`release.ship` in pipeline.ts uses `mutateRelease()` NOT `await`**: Line 148 calls `this.mutateRelease(...)` without `await` — this is NOT a bug, it's because the method is declared `private async` and returns a Promise that the surrounding `async mutate()` awaits implicitly via the `return` statement. Wave 2 agents must NOT add redundant `await`.

5. **`execFileSync` is synchronous**: All git calls in `release-manifest.ts` use `execFileSync` (synchronous). New calls to `detectBranchProtection` will be async. The `runReleaseGates()` function is already `async`, so this is compatible. However, `pushRelease()` uses `execFileSync` too — Wave 2 agents adding async PR creation to `pushRelease()` must convert the function to properly `await` the PR calls.

6. **No `PushConfig` interface exists**: The spec prompt asks about `PushConfig` — this does not exist in the codebase. The push configuration uses `PushPolicy` in `release-manifest.ts`. Do not create a redundant `PushConfig` interface; extend `PushPolicy` as specified in Section 8.4.

7. **`releaseShip` return data shape**: The current `return { success: true, data: { version, epicId, commitSha, gitTag, pushedAt, changelog } }` must be extended with `channel` and `prResult` fields. Do not remove existing fields.

8. **`guided` output must use `process.stdout.write()`**: Not `console.log()`. This avoids interference with JSON mode or log-level filtering.

9. **Channel validation is a WARNING not a hard gate failure**: `validateVersionChannel()` returns a `ChannelValidationResult` with `valid: boolean`. A `valid: false` result should be logged/displayed but MUST NOT cause `allPassed` to become false in `runReleaseGates()`. It is informational.

10. **File import paths require `.js` extension**: This is an ESM project with `"type": "module"`. All new import statements MUST use `.js` extensions (e.g. `from './channel.js'`), even though the source files are `.ts`.

---

## Appendix B: Config JSON Shape for New Features

The new fields will be read from `.cleo/config.json`. Example config structure:

```json
{
  "release": {
    "gitFlow": {
      "enabled": true,
      "branches": {
        "main": "main",
        "develop": "develop",
        "featurePrefix": "feature/",
        "hotfixPrefix": "hotfix/",
        "releasePrefix": "release/"
      }
    },
    "push": {
      "mode": "auto",
      "channelMap": {
        "main": "latest",
        "develop": "beta",
        "feature": "alpha",
        "custom": {
          "hotfix/*": "latest"
        }
      }
    }
  }
}
```

All new `readConfigValueSync()` calls in `loadReleaseConfig()` must use the exact dot-path strings shown above (e.g. `'release.gitFlow.enabled'`, `'release.push.mode'`, etc.).
