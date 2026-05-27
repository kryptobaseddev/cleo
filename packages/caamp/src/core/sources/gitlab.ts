/**
 * GitLab fetcher for skill/MCP sources
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { fetchWithTimeout } from '../network/fetch.js';
import type { GitFetchResult } from './github.js';

/**
 * Clone a GitLab repo to a temp directory.
 *
 * @remarks
 * Performs a shallow clone (`--depth 1`) from `gitlab.com`. If a `subPath`
 * is provided, the returned `localPath` points to that subdirectory within
 * the cloned repository.
 *
 * @param owner - GitLab repository owner (user or group)
 * @param repo - GitLab repository name
 * @param ref - Branch or tag to clone (defaults to the repo's default branch)
 * @param subPath - Subdirectory within the repo to target
 * @returns Object with local path and cleanup function
 *
 * @example
 * ```typescript
 * const { localPath, cleanup } = await cloneGitLabRepo("mygroup", "skills-repo");
 * try {
 *   console.log(`Cloned to: ${localPath}`);
 * } finally {
 *   await cleanup();
 * }
 * ```
 *
 * @public
 */
export async function cloneGitLabRepo(
  owner: string,
  repo: string,
  ref?: string,
  subPath?: string,
): Promise<GitFetchResult> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'caamp-gl-'));
  const repoUrl = `https://gitlab.com/${owner}/${repo}.git`;

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
 * Fetch a specific file from GitLab using the raw API.
 *
 * @remarks
 * Uses the GitLab raw file endpoint to fetch content without cloning.
 * The file path is URL-encoded for GitLab's API format. Returns `null`
 * on any fetch error.
 *
 * @param owner - GitLab repository owner (user or group)
 * @param repo - GitLab repository name
 * @param path - File path within the repository
 * @param ref - Branch or tag to fetch from (defaults to `"main"`)
 * @returns File content as a string, or `null` if the file cannot be fetched
 *
 * @example
 * ```typescript
 * const content = await fetchGitLabRawFile("mygroup", "skills", "my-skill/SKILL.md");
 * if (content) {
 *   console.log(content);
 * }
 * ```
 *
 * @public
 */
export async function fetchGitLabRawFile(
  owner: string,
  repo: string,
  path: string,
  ref = 'main',
): Promise<string | null> {
  const encodedPath = encodeURIComponent(path);
  const url = `https://gitlab.com/${owner}/${repo}/-/raw/${ref}/${encodedPath}`;

  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}
