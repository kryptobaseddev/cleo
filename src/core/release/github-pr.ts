import { execFileSync } from 'node:child_process';

// --- Types (all exported) ---

export interface BranchProtectionResult {
  protected: boolean;
  detectionMethod: 'gh-api' | 'push-dry-run' | 'unknown';
  error?: string;
}

export interface PRCreateOptions {
  base: string;
  head: string;
  title: string;
  body: string;
  labels?: string[];
  version: string;
  epicId?: string;
  projectRoot?: string;
}

export interface PRResult {
  mode: 'created' | 'manual' | 'skipped';
  prUrl?: string;
  prNumber?: number;
  instructions?: string;
  error?: string;
}

export interface RepoIdentity {
  owner: string;
  repo: string;
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
  projectRoot?: string
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
          execFileSync(
            'gh',
            ['api', `/repos/${owner}/${repo}/branches/${branch}/protection`],
            {
              encoding: 'utf-8',
              stdio: 'pipe',
              ...cwdOpts,
            }
          );
          // Exit code 0 means protection rules exist
          return { protected: true, detectionMethod: 'gh-api' };
        } catch (apiErr: unknown) {
          const stderr =
            apiErr instanceof Error && 'stderr' in apiErr
              ? String((apiErr as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '')
              : '';
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
    const result = execFileSync(
      'git',
      ['push', '--dry-run', remote, `HEAD:${branch}`],
      {
        encoding: 'utf-8',
        stdio: 'pipe',
        ...cwdOpts,
      }
    );
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
    const stderr =
      pushErr instanceof Error && 'stderr' in pushErr
        ? String((pushErr as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '')
        : pushErr instanceof Error
          ? pushErr.message
          : String(pushErr);

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
 * Create a GitHub pull request using the `gh` CLI, or return manual instructions
 * if the CLI is unavailable or the operation fails.
 */
export async function createPullRequest(opts: PRCreateOptions): Promise<PRResult> {
  if (!isGhCliAvailable()) {
    return {
      mode: 'manual',
      instructions: formatManualPRInstructions(opts),
    };
  }

  const body = buildPRBody(opts);

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

  if (opts.labels && opts.labels.length > 0) {
    for (const label of opts.labels) {
      args.push('--label', label);
    }
  }

  try {
    const output = execFileSync('gh', args, {
      encoding: 'utf-8',
      stdio: 'pipe',
      ...(opts.projectRoot ? { cwd: opts.projectRoot } : {}),
    });

    const prUrl = output.trim();
    const numberMatch = prUrl.match(/\/pull\/(\d+)$/);
    const prNumber = numberMatch ? parseInt(numberMatch[1], 10) : undefined;

    return {
      mode: 'created',
      prUrl,
      prNumber,
    };
  } catch (err: unknown) {
    const stderr =
      err instanceof Error && 'stderr' in err
        ? String((err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '')
        : err instanceof Error
          ? err.message
          : String(err);

    // Handle case where PR already exists
    if (stderr.includes('already exists')) {
      // Attempt to extract existing PR URL from stderr
      const urlMatch = stderr.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
      const existingUrl = urlMatch ? urlMatch[0] : undefined;
      return {
        mode: 'skipped',
        prUrl: existingUrl,
        instructions: 'PR already exists',
      };
    }

    return {
      mode: 'manual',
      instructions: formatManualPRInstructions(opts),
      error: stderr,
    };
  }
}
