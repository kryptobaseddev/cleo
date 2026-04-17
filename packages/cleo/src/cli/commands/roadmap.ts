/**
 * CLI roadmap command — roadmap generation from pending epics and changelog.
 *
 * Dispatches to `admin.roadmap` in the system engine, which calls
 * `getRoadmap()` from core. Not wired via registry at CLI layer because
 * roadmap is a pure query with no session dependency — calling core
 * through the dispatch layer (admin.roadmap) is the correct pattern.
 *
 * @task T4538
 * @epic T4454
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * Native citty command for `cleo roadmap` — generates a project roadmap
 * from task provenance with epics grouped by status and progress.
 *
 * @task T4538
 * @epic T487
 */
export const roadmapCommand = defineCommand({
  meta: {
    name: 'roadmap',
    description:
      'Generate project roadmap from task provenance — epics grouped by status with progress',
  },
  args: {
    'include-history': {
      type: 'boolean',
      description: 'Include release history from CHANGELOG.md',
    },
    'upcoming-only': {
      type: 'boolean',
      description: 'Only show pending/upcoming epics (exclude completed)',
    },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'admin',
      'roadmap',
      {
        includeHistory: args['include-history'],
        upcomingOnly: args['upcoming-only'],
      },
      { command: 'roadmap', operation: 'admin.roadmap' },
    );
  },
});
