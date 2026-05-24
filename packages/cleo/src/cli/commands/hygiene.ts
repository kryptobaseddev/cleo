/**
 * CLI hygiene command — spawn-readiness pre-flight checks (T10451).
 *
 * @task T10451
 * @saga T10431
 */

import { getProjectRoot } from '@cleocode/core';
import { runSpawnReadinessHygieneCli } from '@cleocode/core/hygiene/validate-spawn-readiness.js';
import { defineCommand } from 'citty';

export const hygieneCommand = defineCommand({
  meta: {
    name: 'hygiene',
    description: 'Run spawn-readiness hygiene checks',
  },
  subCommands: {
    'validate-spawn-readiness': defineCommand({
      meta: {
        name: 'validate-spawn-readiness',
        description:
          'Run all pre-spawn hygiene gates (changeset lint, changelog drift, worktree location)',
      },
      args: {
        'project-root': {
          type: 'string',
          description: 'Project root directory (default: auto-detect)',
        },
        'worktree-path': {
          type: 'string',
          description: 'Expected worktree path for location validation',
        },
      },
      async run({ args }) {
        const projectRoot =
          (args['project-root'] as string | undefined) || getProjectRoot() || process.cwd();
        const worktreePath = args['worktree-path'] as string | undefined;
        await runSpawnReadinessHygieneCli(projectRoot, worktreePath);
      },
    }),
  },
});
