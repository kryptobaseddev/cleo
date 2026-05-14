import { execFileSync } from 'node:child_process';
import type {
  BranchProtectionResult,
  CleoKnownLabel,
  CleoLabelPalette,
  LabelDefinition,
  LabelEnsureResult,
  PRCreateOptions,
  PRLabelResolution,
  PRMode,
  PRResult,
  RepoIdentity,
} from '@cleocode/contracts';

// Re-export contract types so existing consumers that import from this module
// keep working. New code SHOULD import directly from `@cleocode/contracts`.
export type {
  BranchProtectionResult,
  CleoKnownLabel,
  CleoLabelPalette,
  LabelDefinition,
  LabelEnsureResult,
  PRCreateOptions,
  PRLabelResolution,
  PRMode,
  PRResult,
  RepoIdentity,
};

/**
 * Extract the stderr text from a thrown `execFileSync` error, falling back
 * to `err.message` or `String(err)`. Centralised so every call-site uses
 * the same narrowing rather than re-doing the `instanceof Error && 'stderr' in …`
 * dance four times.
 */
function execStderr(err: unknown): string {
  if (err instanceof Error && 'stderr' in err) {
    const fromStderr = (err as NodeJS.ErrnoException & { stderr?: unknown }).stderr;
    if (fromStderr !== undefined && fromStderr !== null) return String(fromStderr);
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

// --- Functions (all exported) ---

/**
 * Check if the `gh` CLI is available by attempting to run `gh --version`.
 * Does NOT use `which` to remain cross-platform.
 */
export function isGhCliAvailable(): boolean {
  try {
    execFileSync('gh', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse a GitHub remote URL (HTTPS or SSH) into owner and repo components.
 * Returns null if the URL cannot be parsed.
 *
 * Supported formats:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git
 *   git@github.com:owner/repo
 */
export function extractRepoOwnerAndName(remote: string): RepoIdentity | null {
  const trimmed = remote.trim();

  // HTTPS pattern: https://github.com/owner/repo[.git]
  const httpsMatch = trimmed.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH pattern: git@github.com:owner/repo[.git]
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

/**
 * Detect whether a branch has protection rules enabled.
 *
 * Strategy 1 (preferred): use `gh api` to query GitHub branch protection.
 * Strategy 2 (fallback): use `git push --dry-run` and inspect stderr.
 */
export async function detectBranchProtection(
  branch: string,
  remote: string,
  projectRoot?: string,
): Promise<BranchProtectionResult> {
  const cwdOpts = projectRoot ? { cwd: projectRoot } : {};

  // Strategy 1: gh CLI via GitHub API
  if (isGhCliAvailable()) {
    try {
      const remoteUrl = execFileSync('git', ['remote', 'get-url', remote], {
        encoding: 'utf-8',
        stdio: 'pipe',
        ...cwdOpts,
      }).trim();

      const identity = extractRepoOwnerAndName(remoteUrl);
      if (identity) {
        const { owner, repo } = identity;
        try {
          execFileSync('gh', ['api', `/repos/${owner}/${repo}/branches/${branch}/protection`], {
            encoding: 'utf-8',
            stdio: 'pipe',
            ...cwdOpts,
          });
          // Exit code 0 means protection rules exist
          return { protected: true, detectionMethod: 'gh-api' };
        } catch (apiErr: unknown) {
          const stderr = execStderr(apiErr);
          if (stderr.includes('404') || stderr.includes('Not Found')) {
            // 404 means no protection configured
            return { protected: false, detectionMethod: 'gh-api' };
          }
          // Any other API error — fall through to strategy 2
        }
      }
      // Parse failure — fall through to strategy 2
    } catch {
      // git remote get-url failed — fall through to strategy 2
    }
  }

  // Strategy 2: git push --dry-run
  try {
    const result = execFileSync('git', ['push', '--dry-run', remote, `HEAD:${branch}`], {
      encoding: 'utf-8',
      stdio: 'pipe',
      ...cwdOpts,
    });
    // If stderr from a successful dry-run contains protection signals
    const output = typeof result === 'string' ? result : '';
    if (
      output.includes('protected branch') ||
      output.includes('GH006') ||
      output.includes('refusing to allow')
    ) {
      return { protected: true, detectionMethod: 'push-dry-run' };
    }
    return { protected: false, detectionMethod: 'push-dry-run' };
  } catch (pushErr: unknown) {
    const stderr = execStderr(pushErr);
    if (
      stderr.includes('protected branch') ||
      stderr.includes('GH006') ||
      stderr.includes('refusing to allow')
    ) {
      return { protected: true, detectionMethod: 'push-dry-run' };
    }

    return {
      protected: false,
      detectionMethod: 'unknown',
      error: stderr,
    };
  }
}

/**
 * Known channel/release labels and the colors/descriptions used when CLEO
 * auto-creates them. Kept in one place so the palette is consistent across
 * projects that opt into auto-create. Typed against the {@link CleoLabelPalette}
 * contract so the names match the {@link CleoKnownLabel} discriminated union.
 */
const KNOWN_CLEO_LABELS: CleoLabelPalette = {
  release: { color: '0E8A16', description: 'CLEO release PR' },
  latest: { color: '1D76DB', description: 'Targets the latest stable channel' },
  beta: { color: 'FBCA04', description: 'Targets the beta channel' },
  alpha: { color: 'D93F0B', description: 'Targets the alpha channel' },
};

/**
 * Return the names of labels currently defined on the GitHub repo for `cwd`.
 *
 * Uses `gh label list --json name` and tolerates failures by returning an
 * empty list (caller falls back to "skip filtering"). The intent is to avoid
 * `gh pr create --label X` failing the entire release because a label happens
 * to be missing on a particular repo.
 */
export function listExistingLabels(projectRoot?: string): string[] {
  if (!isGhCliAvailable()) return [];
  try {
    const stdout = execFileSync('gh', ['label', 'list', '--limit', '200', '--json', 'name'], {
      encoding: 'utf-8',
      stdio: 'pipe',
      ...(projectRoot ? { cwd: projectRoot } : {}),
    });
    const parsed = JSON.parse(stdout) as Array<{ name?: string }>;
    return parsed.map((row) => row.name ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Create labels on the GitHub repo that are missing locally but recognised by
 * CLEO. Returns the subset of `requested` that now exists (either pre-existed
 * or was created successfully). Silently skips unknown labels.
 *
 * `gh label create` is idempotent under the `--force` flag in modern gh
 * versions, but to stay portable we filter against `listExistingLabels` first.
 */
export function ensureCleoLabelsExist(
  requested: string[],
  projectRoot?: string,
): LabelEnsureResult {
  if (!isGhCliAvailable()) {
    return { ensured: [], created: [], missing: requested };
  }
  const existing = new Set(listExistingLabels(projectRoot));
  const created: string[] = [];
  const ensured: string[] = [];
  const missing: string[] = [];

  for (const name of requested) {
    if (existing.has(name)) {
      ensured.push(name);
      continue;
    }
    // Narrow `name: string` to `CleoKnownLabel` via the palette's own keys
    // so the index access is type-safe (no `any` from a string lookup).
    const knownNames = Object.keys(KNOWN_CLEO_LABELS) as CleoKnownLabel[];
    const knownName = knownNames.find((k) => k === name);
    if (!knownName) {
      missing.push(name);
      continue;
    }
    const meta = KNOWN_CLEO_LABELS[knownName];
    try {
      execFileSync(
        'gh',
        ['label', 'create', name, '--color', meta.color, '--description', meta.description],
        {
          encoding: 'utf-8',
          stdio: 'pipe',
          ...(projectRoot ? { cwd: projectRoot } : {}),
        },
      );
      created.push(name);
      ensured.push(name);
    } catch {
      missing.push(name);
    }
  }

  return { ensured, created, missing };
}

/**
 * Build the markdown body for a GitHub pull request.
 */
export function buildPRBody(opts: PRCreateOptions): string {
  const epicLine = opts.epicId ? `**Epic**: ${opts.epicId}\n\n` : '';
  return [
    `## Release v${opts.version}`,
    '',
    `${epicLine}This PR merges the ${opts.head} branch into ${opts.base} to publish the release.`,
    '',
    '### Checklist',
    '- [ ] CHANGELOG.md updated',
    '- [ ] All release tasks complete',
    '- [ ] Version bump committed',
    '',
    '---',
    '*Created by CLEO release pipeline*',
  ].join('\n');
}

/**
 * Format human-readable instructions for creating a PR manually.
 */
export function formatManualPRInstructions(opts: PRCreateOptions): string {
  const epicSuffix = opts.epicId ? ` (${opts.epicId})` : '';
  return [
    'Branch protection detected or gh CLI unavailable. Create the PR manually:',
    '',
    `  gh pr create \\`,
    `    --base ${opts.base} \\`,
    `    --head ${opts.head} \\`,
    `    --title "${opts.title}" \\`,
    `    --body "Release v${opts.version}${epicSuffix}"`,
    '',
    `Or visit: https://github.com/[owner]/[repo]/compare/${opts.base}...${opts.head}`,
    '',
    'After merging, CI will automatically publish to npm.',
  ].join('\n');
}

/**
 * Resolve the set of labels to actually pass to `gh pr create`, given the set
 * requested by the caller.
 *
 * Order:
 *   1. Auto-create CLEO-known labels (release/latest/beta/alpha) if absent
 *   2. Query the repo's existing labels and intersect — labels we can't auto-
 *      create are dropped here (with a `missing` list returned for logging)
 *   3. Return the final ensured set so `gh pr create --label …` never errors
 *      out on a non-existent label
 *
 * Exported so the engine layer (and tests) can preview filtering before a
 * real PR is opened.
 */
export function resolvePRLabels(
  requested: string[] | undefined,
  projectRoot?: string,
): PRLabelResolution {
  if (!requested || requested.length === 0) {
    return { labels: [], created: [], missing: [] };
  }
  if (!isGhCliAvailable()) {
    // Without gh we can't validate — pass through and let the caller decide.
    return { labels: requested, created: [], missing: [] };
  }
  const ensured = ensureCleoLabelsExist(requested, projectRoot);
  return {
    labels: ensured.ensured,
    created: ensured.created,
    missing: ensured.missing,
  };
}

/**
 * Create a GitHub pull request using the `gh` CLI, or return manual instructions
 * if the CLI is unavailable or the operation fails.
 *
 * Labels in `opts.labels` are filtered against the repo's existing labels via
 * {@link resolvePRLabels} — labels that don't exist (and aren't in CLEO's
 * known palette) are silently dropped rather than failing the PR. If `gh pr
 * create` still rejects a label (race with another label deletion, custom
 * validation, etc.), the call retries once without any labels.
 */
export async function createPullRequest(opts: PRCreateOptions): Promise<PRResult> {
  if (!isGhCliAvailable()) {
    return {
      mode: 'manual',
      instructions: formatManualPRInstructions(opts),
    };
  }

  const body = buildPRBody(opts);
  const labelResolution = resolvePRLabels(opts.labels, opts.projectRoot);

  const buildArgs = (labels: string[]): string[] => {
    const args: string[] = [
      'pr',
      'create',
      '--base',
      opts.base,
      '--head',
      opts.head,
      '--title',
      opts.title,
      '--body',
      body,
    ];
    for (const label of labels) {
      args.push('--label', label);
    }
    return args;
  };

  const runGh = (labels: string[]): string =>
    execFileSync('gh', buildArgs(labels), {
      encoding: 'utf-8',
      stdio: 'pipe',
      ...(opts.projectRoot ? { cwd: opts.projectRoot } : {}),
    });

  const isLabelError = (msg: string): boolean =>
    /not\s+found|no\s+such\s+label|could\s+not\s+add\s+label|invalid\s+label/i.test(msg);

  try {
    const output = runGh(labelResolution.labels);
    const prUrl = output.trim();
    const numberMatch = prUrl.match(/\/pull\/(\d+)$/);
    const prNumber = numberMatch ? parseInt(numberMatch[1], 10) : undefined;
    return {
      mode: 'created',
      prUrl,
      prNumber,
    };
  } catch (err: unknown) {
    const stderr = execStderr(err);

    // PR already exists — extract URL and return skipped
    if (stderr.includes('already exists')) {
      const urlMatch = stderr.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      const existingUrl = urlMatch ? urlMatch[0] : undefined;
      return {
        mode: 'skipped',
        prUrl: existingUrl,
        instructions: 'PR already exists',
      };
    }

    // Label-related failure — retry once with no labels so the release can ship
    if (labelResolution.labels.length > 0 && isLabelError(stderr)) {
      try {
        const output = runGh([]);
        const prUrl = output.trim();
        const numberMatch = prUrl.match(/\/pull\/(\d+)$/);
        const prNumber = numberMatch ? parseInt(numberMatch[1], 10) : undefined;
        return {
          mode: 'created',
          prUrl,
          prNumber,
          instructions:
            `PR created without labels — ` +
            `gh rejected labels [${labelResolution.labels.join(', ')}]: ${stderr.trim()}`,
        };
      } catch (retryErr: unknown) {
        return {
          mode: 'manual',
          instructions: formatManualPRInstructions(opts),
          error: execStderr(retryErr),
        };
      }
    }

    return {
      mode: 'manual',
      instructions: formatManualPRInstructions(opts),
      error: stderr,
    };
  }
}
