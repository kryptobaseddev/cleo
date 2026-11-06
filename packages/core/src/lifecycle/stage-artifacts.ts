/**
 * Stage artifact scaffolding for RCASD lifecycle stages.
 *
 * Writes a stage's canonical markdown artifact, when a caller has real
 * content for it (T14277: never a placeholder), under:
 *   .cleo/rcasd/{epicId}/{stage-subdir}/{epicId}-{stage}.md
 *
 * Frontmatter is maintained with related links so backlinks can be
 * discovered via frontmatter graph traversal.
 *
 * @task T5217
 */

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { WriterRegistry } from '../docs/writer-registry.js';
import { getLogger } from '../logger.js';
import { getProjectRoot } from '../paths.js';
import { addFrontmatter, buildFrontmatter, type RelatedLink } from './frontmatter.js';
import { ensureStagePath, getStagePath } from './rcasd-paths.js';
import { STAGE_PREREQUISITES, type Stage } from './stages.js';

const log = getLogger('lifecycle:stage-artifacts');

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

function toWorkspaceRelative(path: string, cwd?: string): string {
  const projectRoot = getProjectRoot(cwd);
  return relative(projectRoot, path).replaceAll('\\', '/');
}

function buildRelatedLinks(
  epicId: string,
  stage: Stage,
  absolutePath: string,
  cwd?: string,
): RelatedLink[] {
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
 * Write a stage artifact with real content, its frontmatter and backlinks up
 * to date (T14277). There is no placeholder: a stage transition alone writes
 * no file (the store records the stage), so callers write only when they
 * hold the artifact's content.
 *
 * @param epicId - The epic.
 * @param stage - The stage.
 * @param content - The artifact body (markdown, frontmatter optional).
 * @param cwd - Project root override.
 * @returns Where it was written and its related links.
 */
export async function ensureStageArtifact(
  epicId: string,
  stage: Stage,
  content: string,
  cwd?: string,
): Promise<StageArtifactResult> {
  const stageDir = ensureStagePath(epicId, stage, cwd);
  const fileName = `${epicId}-${stageSlug(stage)}.md`;
  const absolutePath = join(stageDir, fileName);
  const outputFile = toWorkspaceRelative(absolutePath, cwd);
  const currentContent = content;

  const related = buildRelatedLinks(epicId, stage, absolutePath, cwd);
  const metadata = buildFrontmatter(epicId, stage, {
    task: epicId,
    related,
  });

  const nextContent = addFrontmatter(currentContent, metadata);
  await writeFile(absolutePath, nextContent, 'utf-8');

  // T10368: surface the system-managed routing — stage artifact composer
  // is registered as `lifecycle.stage-artifact` in `SYSTEM_MANAGED_ENTRIES`.
  if (process.env['CLEO_QUIET'] !== '1') {
    const entry = WriterRegistry.findSystemManagedById('lifecycle.stage-artifact');
    if (entry !== null) {
      log.debug(
        { path: absolutePath, registryEntry: entry.id, adr: entry.adrRef },
        'system-managed writer (T10368)',
      );
    }
  }

  return {
    absolutePath,
    outputFile,
    related,
  };
}
