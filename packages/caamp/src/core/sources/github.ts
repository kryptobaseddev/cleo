/**
 * GitHub fetcher for skill/MCP sources
 *
 * Clones repos or fetches specific paths via simple-git.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { fetchWithTimeout } from '../network/fetch.js';

/**
 * Result of fetching a Git repository to a local temporary directory.
 *
 * @public
 */
export interface GitFetchResult {
  /** Absolute path to the fetched content on disk. */
  localPath: string;
  /** Cleanup function that removes the temporary directory. */
  cleanup: () => Promise<void>;
}

/**
 * Clone a GitHub repo to a temp directory.
 *
 * @remarks
 * Performs a shallow clone (`--depth 1`) to minimize download size. If a
 * `subPath` is provided, the returned `localPath` points to that subdirectory
 * within the cloned repository.
 *
 * @param owner - GitHub repository owner (user or organization)
 * @param repo - GitHub repository name
 * @param ref - Branch or tag to clone (defaults to the repo's default branch)
 * @param subPath - Subdirectory within the repo to target
 * @returns Object with local path and cleanup function
 *
 * @example
 * ```typescript
 * const { localPath, cleanup } = await cloneRepo("anthropics", "courses", "main", "skills");
 * try {
 *   console.log(`Cloned to: ${localPath}`);
 * } finally {
 *   await cleanup();
 * }
 * ```
 *
 * @public
 */
export async function cloneRepo(
  owner: string,
  repo: string,
  ref?: string,
  subPath?: string,
): Promise<GitFetchResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'caamp-'));
  const repoUrl = `https://github.com/${owner}/${repo}.git`;

  const git = simpleGit();

  const cloneOptions = ['--depth', '1'];
  if (ref) {
    cloneOptions.push('--branch', ref);
  }

  await git.clone(repoUrl, tmpDir, cloneOptions);

  const localPath = subPath ? join(tmpDir, subPath) : tmpDir;

  return {
    localPath,
    cleanup: async () => {
      try {
        await rm(tmpDir, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Fetch a specific file from GitHub using the raw API.
 *
 * @remarks
 * Uses `raw.githubusercontent.com` to fetch file content without cloning
 * the entire repository. Returns `null` on any fetch error.
 *
 * @param owner - GitHub repository owner
 * @param repo - GitHub repository name
 * @param path - File path within the repository
 * @param ref - Branch or tag to fetch from (defaults to `"main"`)
 * @returns File content as a string, or `null` if the file cannot be fetched
 *
 * @example
 * ```typescript
 * const content = await fetchRawFile("owner", "repo", "skills/my-skill/SKILL.md");
 * if (content) {
 *   console.log(content);
 * }
 * ```
 *
 * @public
 */
export async function fetchRawFile(
  owner: string,
  repo: string,
  path: string,
  ref = 'main',
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * Check if a GitHub repo exists.
 *
 * @remarks
 * Sends a HEAD request to the GitHub API to verify repository existence
 * without downloading content.
 *
 * @param owner - GitHub repository owner
 * @param repo - GitHub repository name
 * @returns `true` if the repository exists and is accessible
 *
 * @example
 * ```typescript
 * const exists = await repoExists("anthropics", "courses");
 * console.log(exists ? "Repo found" : "Repo not found");
 * ```
 *
 * @public
 */
export async function repoExists(owner: string, repo: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`https://api.github.com/repos/${owner}/${repo}`, {
      method: 'HEAD',
    });
    return response.ok;
  } catch {
    return false;
  }
}
