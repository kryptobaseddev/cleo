/**
 * TodoWrite integration - grammar transformation and format conversion.
 * Ported from lib/tasks/todowrite-integration.sh
 *
 * @epic T4454
 * @task T4529
 */

import type { Task, TaskStatus } from '../../types/task.js';

/** TodoWrite status values. */
export type TodoWriteStatus = 'pending' | 'in_progress' | 'completed';

/** Verb lookup table for imperative -> present continuous. */
const VERB_TO_ACTIVE: Record<string, string> = {
  add: 'Adding', analyze: 'Analyzing', apply: 'Applying', build: 'Building',
  check: 'Checking', clarify: 'Clarifying', clean: 'Cleaning', cleanup: 'Cleaning up',
  configure: 'Configuring', connect: 'Connecting', consolidate: 'Consolidating',
  convert: 'Converting', copy: 'Copying', create: 'Creating', debug: 'Debugging',
  decouple: 'Decoupling', define: 'Defining', delete: 'Deleting', deploy: 'Deploying',
  design: 'Designing', detect: 'Detecting', develop: 'Developing', disable: 'Disabling',
  document: 'Documenting', download: 'Downloading', enable: 'Enabling', enhance: 'Enhancing',
  ensure: 'Ensuring', establish: 'Establishing', evaluate: 'Evaluating', examine: 'Examining',
  execute: 'Executing', expand: 'Expanding', export: 'Exporting', extend: 'Extending',
  extract: 'Extracting', finalize: 'Finalizing', find: 'Finding', finish: 'Finishing',
  fix: 'Fixing', format: 'Formatting', generate: 'Generating', handle: 'Handling',
  identify: 'Identifying', implement: 'Implementing', import: 'Importing',
  improve: 'Improving', include: 'Including', initialize: 'Initializing',
  inspect: 'Inspecting', install: 'Installing', integrate: 'Integrating',
  investigate: 'Investigating', launch: 'Launching', load: 'Loading', log: 'Logging',
  maintain: 'Maintaining', manage: 'Managing', merge: 'Merging', migrate: 'Migrating',
  modify: 'Modifying', monitor: 'Monitoring', move: 'Moving', normalize: 'Normalizing',
  optimize: 'Optimizing', organize: 'Organizing', parse: 'Parsing', patch: 'Patching',
  perform: 'Performing', plan: 'Planning', prepare: 'Preparing', prevent: 'Preventing',
  process: 'Processing', protect: 'Protecting', provide: 'Providing', publish: 'Publishing',
  query: 'Querying', read: 'Reading', rebuild: 'Rebuilding', reduce: 'Reducing',
  refactor: 'Refactoring', release: 'Releasing', reload: 'Reloading', remove: 'Removing',
  rename: 'Renaming', reorganize: 'Reorganizing', repair: 'Repairing', replace: 'Replacing',
  report: 'Reporting', research: 'Researching', reset: 'Resetting', resolve: 'Resolving',
  restore: 'Restoring', restructure: 'Restructuring', retrieve: 'Retrieving',
  return: 'Returning', review: 'Reviewing', revise: 'Revising', rewrite: 'Rewriting',
  run: 'Running', save: 'Saving', scan: 'Scanning', schedule: 'Scheduling',
  search: 'Searching', secure: 'Securing', send: 'Sending', separate: 'Separating',
  set: 'Setting', setup: 'Setting up', simplify: 'Simplifying', solve: 'Solving',
  sort: 'Sorting', split: 'Splitting', standardize: 'Standardizing', start: 'Starting',
  stop: 'Stopping', store: 'Storing', streamline: 'Streamlining', structure: 'Structuring',
  stub: 'Stubbing', submit: 'Submitting', support: 'Supporting', sync: 'Syncing',
  synchronize: 'Synchronizing', test: 'Testing', trace: 'Tracing', track: 'Tracking',
  transfer: 'Transferring', transform: 'Transforming', translate: 'Translating',
  troubleshoot: 'Troubleshooting', try: 'Trying', unify: 'Unifying',
  uninstall: 'Uninstalling', update: 'Updating', upgrade: 'Upgrading', upload: 'Uploading',
  use: 'Using', validate: 'Validating', verify: 'Verifying', view: 'Viewing',
  watch: 'Watching', wrap: 'Wrapping', write: 'Writing',
};

/** Status mappings. */
const STATUS_TO_TODOWRITE: Record<TaskStatus, TodoWriteStatus> = {
  pending: 'pending',
  active: 'in_progress',
  blocked: 'pending',
  done: 'completed',
  cancelled: 'completed',
};

const STATUS_FROM_TODOWRITE: Record<TodoWriteStatus, TaskStatus> = {
  pending: 'pending',
  in_progress: 'active',
  completed: 'done',
};

/** Non-verb first words. */
const NON_VERB_WORDS = new Set([
  'core', 'api', 'ui', 'ux', 'db', 'database', 'frontend', 'backend', 'server',
  'client', 'user', 'admin', 'auth', 'config', 'configuration', 'data', 'file',
  'files', 'module', 'component', 'class', 'function', 'method', 'service',
  'controller', 'model', 'view', 'unit', 'integration', 'e2e', 'performance',
  'security', 'load', 'stress', 'smoke', 'regression', 'bug', 'feature', 'issue',
  'task', 'story', 'epic', 'ticket', 'pr', 'review', 'release', 'version', 'v1',
  'v2', 'patch', 'new', 'old', 'main', 'primary', 'secondary', 'final', 'initial',
  'temp', 'temporary', 'quick', 'fast', 'slow', 'high', 'medium', 'low', 'blocked',
  'pending', 'active', 'done', 'critical', 'urgent', 'important',
]);

function isVowel(ch: string): boolean {
  return 'aeiou'.includes(ch);
}

function isConsonant(ch: string): boolean {
  return 'bcdfghjklmnpqrstvwxyz'.includes(ch);
}

/**
 * Apply English grammar rules to convert verb to -ing form.
 */
export function applyGrammarRules(verb: string): string {
  if (verb.length < 2) return verb + 'ing';

  const last = verb[verb.length - 1];
  const secondLast = verb[verb.length - 2];

  // Rule: 'ie' -> 'ying'
  if (verb.endsWith('ie')) {
    return verb.slice(0, -2) + 'ying';
  }

  // Rule: 'e' (not 'ee') -> drop 'e', add 'ing'
  if (last === 'e' && secondLast !== 'e') {
    return verb.slice(0, -1) + 'ing';
  }

  // Rule: CVC pattern for short words -> double consonant
  if (verb.length <= 4 && isConsonant(last) && isVowel(secondLast)) {
    if (last !== 'w' && last !== 'x' && last !== 'y') {
      return verb + last + 'ing';
    }
  }

  return verb + 'ing';
}

/**
 * Convert imperative task title to present continuous (activeForm).
 */
export function convertToActiveForm(title: string): string {
  if (!title) return '';

  const firstWord = title.split(' ')[0];
  const firstWordLower = firstWord.toLowerCase();
  const rest = title.includes(' ') ? title.slice(title.indexOf(' ') + 1) : '';

  // Handle prefix patterns like "BUG:", "FEAT:", "T123:"
  if (/^[A-Z0-9._-]+:$/.test(firstWord) || /^T\d+(\.\d+)?:$/.test(firstWord)) {
    return `Working on: ${title}`;
  }

  // Strip trailing colon/punctuation for lookup
  const cleaned = firstWordLower.replace(/[:.]$/, '');

  // Already in -ing form
  if (cleaned.endsWith('ing') && cleaned.length > 4) {
    const capitalized = firstWord[0].toUpperCase() + firstWord.slice(1);
    return rest ? `${capitalized} ${rest}` : capitalized;
  }

  // Lookup table
  if (VERB_TO_ACTIVE[cleaned]) {
    return rest ? `${VERB_TO_ACTIVE[cleaned]} ${rest}` : VERB_TO_ACTIVE[cleaned];
  }

  // Check if likely a verb
  if (NON_VERB_WORDS.has(cleaned) || cleaned.length <= 2) {
    return `Working on: ${title}`;
  }

  // Apply grammar rules
  const transformed = applyGrammarRules(cleaned);
  const capitalized = transformed[0].toUpperCase() + transformed.slice(1);
  return rest ? `${capitalized} ${rest}` : capitalized;
}

/**
 * Map CLEO status to TodoWrite status.
 */
export function mapStatusToTodoWrite(status: TaskStatus): TodoWriteStatus {
  return STATUS_TO_TODOWRITE[status] ?? 'pending';
}

/**
 * Map TodoWrite status to CLEO status.
 */
export function mapStatusFromTodoWrite(status: TodoWriteStatus): TaskStatus {
  return STATUS_FROM_TODOWRITE[status] ?? 'pending';
}

/** TodoWrite task format. */
export interface TodoWriteItem {
  content: string;
  activeForm: string;
  status: TodoWriteStatus;
}

/**
 * Convert a CLEO task to TodoWrite format.
 */
export function taskToTodoWrite(task: Task): TodoWriteItem {
  return {
    content: task.title,
    activeForm: convertToActiveForm(task.title),
    status: mapStatusToTodoWrite(task.status),
  };
}

/**
 * Export CLEO tasks to TodoWrite format.
 */
export function exportToTodoWrite(
  tasks: Task[],
  options?: { statusFilter?: TaskStatus[]; maxTasks?: number },
): { todos: TodoWriteItem[] } {
  const { statusFilter = ['pending', 'active'], maxTasks = 10 } = options ?? {};

  const filterSet = new Set(statusFilter);
  const filtered = tasks
    .filter((t) => filterSet.has(t.status))
    .slice(0, maxTasks);

  return {
    todos: filtered.map(taskToTodoWrite),
  };
}
