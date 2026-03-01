/**
 * Stage artifact scaffolding for RCASD lifecycle stages.
 *
 * Ensures each stage has a canonical markdown artifact under:
 *   .cleo/rcasd/{epicId}/{stage-subdir}/{epicId}-{stage}.md
 *
 * Frontmatter is maintained with related links so backlinks can be
 * discovered via frontmatter graph traversal.
 *
 * @task T5217
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { ensureStagePath, getStagePath } from './rcasd-paths.js';
import {
  addFrontmatter,
  buildFrontmatter,
  type RelatedLink,
} from './frontmatter.js';
import { STAGE_DEFINITIONS, STAGE_PREREQUISITES, type Stage } from './stages.js';
import { getProjectRoot } from '../paths.js';

export interface StageArtifactResult {
  absolutePath: string;
  outputFile: string;
  related: RelatedLink[];
}

function stageSlug(stage: string): string {
  return stage.replace(/_/g, '-');
}

function toRelatedLinkType(stage: string): RelatedLink['type'] {
  switch (stage) {
    case 'research':
      return 'research';
    case 'consensus':
      return 'consensus';
    case 'architecture_decision':
      return 'adr';
    case 'specification':
      return 'spec';
    default:
      return 'file';
  }
}

function buildDefaultBody(epicId: string, stage: Stage): string {
  const stageLabel = STAGE_DEFINITIONS[stage].name;
  return [
    `# ${stageLabel} (${epicId})`,
    '',
    '## Summary',
    '',
    `Lifecycle artifact for stage \`${stage}\` on epic \`${epicId}\`.`,
    '',
    '## Notes',
    '',
  ].join('\n');
}

function toWorkspaceRelative(path: string, cwd?: string): string {
  const projectRoot = getProjectRoot(cwd);
  return relative(projectRoot, path).replaceAll('\\', '/');
}

function buildRelatedLinks(epicId: string, stage: Stage, absolutePath: string, cwd?: string): RelatedLink[] {
  const prereqs = STAGE_PREREQUISITES[stage] ?? [];
  const related: RelatedLink[] = [{ type: 'task', id: epicId }];
  const artifactDir = dirname(absolutePath);

  for (const prereq of prereqs) {
    const prereqDir = getStagePath(epicId, prereq, cwd);
    const prereqFile = join(prereqDir, `${epicId}-${stageSlug(prereq)}.md`);
    if (!existsSync(prereqFile)) {
      continue;
    }

    related.push({
      type: toRelatedLinkType(prereq),
      path: relative(artifactDir, prereqFile).replaceAll('\\', '/'),
    });
  }

  return related;
}

/**
 * Ensure stage artifact exists and frontmatter/backlinks are up to date.
 */
export async function ensureStageArtifact(
  epicId: string,
  stage: Stage,
  cwd?: string,
): Promise<StageArtifactResult> {
  const stageDir = ensureStagePath(epicId, stage, cwd);
  const fileName = `${epicId}-${stageSlug(stage)}.md`;
  const absolutePath = join(stageDir, fileName);
  const outputFile = toWorkspaceRelative(absolutePath, cwd);

  const currentContent = existsSync(absolutePath)
    ? await readFile(absolutePath, 'utf-8')
    : buildDefaultBody(epicId, stage);

  const related = buildRelatedLinks(epicId, stage, absolutePath, cwd);
  const metadata = buildFrontmatter(epicId, stage, {
    task: epicId,
    related,
  });

  const nextContent = addFrontmatter(currentContent, metadata);
  await writeFile(absolutePath, nextContent, 'utf-8');

  return {
    absolutePath,
    outputFile,
    related,
  };
}
