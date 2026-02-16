/**
 * CI/CD template generation for release workflows.
 *
 * Generates platform-specific CI/CD configurations (GitHub Actions,
 * GitLab CI, CircleCI) from templates and project configuration.
 *
 * @task T4454
 * @epic T4454
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { loadReleaseConfig } from './release-config.js';

/** Supported CI/CD platforms. */
export type CIPlatform = 'github-actions' | 'gitlab-ci' | 'circleci';

/** All supported platforms. */
export const SUPPORTED_PLATFORMS: CIPlatform[] = ['github-actions', 'gitlab-ci', 'circleci'];

/** Platform-specific output paths. */
const PLATFORM_PATHS: Record<CIPlatform, string> = {
  'github-actions': '.github/workflows/release.yml',
  'gitlab-ci': '.gitlab-ci.yml',
  'circleci': '.circleci/config.yml',
};

/** Get the output path for a CI platform. */
export function getPlatformPath(platform: CIPlatform): string {
  return PLATFORM_PATHS[platform];
}

/** Detect the CI platform from the project. */
export function detectCIPlatform(projectDir?: string): CIPlatform | null {
  const dir = projectDir ?? process.cwd();

  if (existsSync(join(dir, '.github'))) return 'github-actions';
  if (existsSync(join(dir, '.gitlab-ci.yml'))) return 'gitlab-ci';
  if (existsSync(join(dir, '.circleci'))) return 'circleci';
  return null;
}

/** Generate GitHub Actions workflow YAML. */
function generateGitHubActions(config: { version?: string; gates: Array<{ name: string; command: string }> }): string {
  const gateSteps = config.gates.map(g =>
    `      - name: ${g.name}\n        run: ${g.command}`,
  ).join('\n');

  return `name: Release
on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install dependencies
        run: npm ci
${gateSteps}
      - name: Create Release
        uses: softprops/action-gh-release@v1
        with:
          generate_release_notes: true
`;
}

/** Generate GitLab CI YAML. */
function generateGitLabCI(config: { gates: Array<{ name: string; command: string }> }): string {
  const stages = config.gates.map(g => g.name.toLowerCase().replace(/\s+/g, '-'));

  return `stages:
  - test
  - release
${stages.map(s => `  - ${s}`).join('\n')}

${config.gates.map(g => `${g.name.toLowerCase().replace(/\s+/g, '-')}:
  stage: ${g.name.toLowerCase().replace(/\s+/g, '-')}
  script:
    - ${g.command}`).join('\n\n')}

release:
  stage: release
  only:
    - tags
  script:
    - echo "Creating release"
`;
}

/** Generate CircleCI config YAML. */
function generateCircleCI(config: { gates: Array<{ name: string; command: string }> }): string {
  return `version: 2.1

jobs:
  test:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run: npm ci
${config.gates.map(g => `      - run:\n          name: ${g.name}\n          command: ${g.command}`).join('\n')}

  release:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run: echo "Creating release"

workflows:
  release:
    jobs:
      - test:
          filters:
            tags:
              only: /^v.*/
      - release:
          requires:
            - test
          filters:
            tags:
              only: /^v.*/
`;
}

/** Generate CI config for a platform. */
export function generateCIConfig(
  platform: CIPlatform,
  cwd?: string,
): string {
  const releaseConfig = loadReleaseConfig(cwd);
  const gates = releaseConfig.gates.map(g => ({ name: g.name, command: g.command }));

  switch (platform) {
    case 'github-actions':
      return generateGitHubActions({ gates });
    case 'gitlab-ci':
      return generateGitLabCI({ gates });
    case 'circleci':
      return generateCircleCI({ gates });
  }
}

/** Write CI config to the appropriate path. */
export function writeCIConfig(
  platform: CIPlatform,
  options: { projectDir?: string; dryRun?: boolean } = {},
): { action: string; path: string; content: string } {
  const projectDir = options.projectDir ?? process.cwd();
  const outputPath = join(projectDir, getPlatformPath(platform));
  const content = generateCIConfig(platform, projectDir);

  if (options.dryRun) {
    return { action: 'would_write', path: outputPath, content };
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf-8');

  return { action: 'wrote', path: outputPath, content };
}

/** Validate an existing CI config. */
export function validateCIConfig(
  platform: CIPlatform,
  projectDir?: string,
): { valid: boolean; exists: boolean; errors: string[] } {
  const dir = projectDir ?? process.cwd();
  const configPath = join(dir, getPlatformPath(platform));

  if (!existsSync(configPath)) {
    return { valid: false, exists: false, errors: ['Config file not found'] };
  }

  const errors: string[] = [];
  try {
    const content = readFileSync(configPath, 'utf-8');
    if (!content.trim()) errors.push('Config file is empty');
  } catch (err) {
    errors.push(`Cannot read config: ${String(err)}`);
  }

  return { valid: errors.length === 0, exists: true, errors };
}
