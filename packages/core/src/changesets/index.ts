/**
 * Changesets module — CLEO-native task-anchored changeset DSL.
 *
 * Public entry point for parsing `.changeset/*.md` files into validated
 * {@link ChangesetEntry} records. The consumer side (release-plan aggregator)
 * lives in `@cleocode/core/release` and is a T9738 follow-up.
 *
 * @epic T9738
 * @module changesets
 */

export { parseChangesetDir, parseChangesetFile } from './parser.js';
