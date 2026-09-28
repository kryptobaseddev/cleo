/**
 * Drizzle schema for the terminal → session binding table
 * (`session_terminal_bindings`) — T12499 · epic T12497.
 *
 * One row per terminal / harness identity key (see
 * `sessions/terminal-identity.ts`), naming the CLEO session that terminal
 * started. Written by `session start`; read by session resolution before the
 * newest-active-row fallback.
 *
 * Pure runtime infrastructure in the PROJECT `cleo.db` only (migration
 * `drizzle-cleo-project/…_t12499-session-terminal-bindings`), following the
 * `schedules` precedent (T11962): it is not part of the exodus target shape
 * under `schema/cleo-project/`. `sessionId` is an INTRA-DB foreign key to
 * `tasks_sessions.id` (same project `cleo.db`), `ON DELETE CASCADE`, so a
 * deleted session takes its bindings with it. Resolution still re-checks that
 * the bound session is active before honouring a binding.
 *
 * @module
 * @task T12499
 * @epic T12497
 */

import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { tasksSessions } from './schema/cleo-project/tasks-core.js';

/** Physical table name — the single source for the accessor and tests. */
export const SESSION_TERMINAL_BINDINGS_TABLE = 'session_terminal_bindings' as const;

/**
 * `session_terminal_bindings` — terminal identity key → CLEO session id.
 *
 * @task T12499
 */
export const sessionTerminalBindings = sqliteTable(
  SESSION_TERMINAL_BINDINGS_TABLE,
  {
    /** Opaque identity key (`env:<VAR>=<value>` or `ppid:<pid>@<start>`). */
    bindingKey: text('binding_key').primaryKey(),
    /** Environment variable the key came from, or `ppid`. */
    keySource: text('key_source').notNull(),
    /** Identity category (`provider` | `multiplexer` | `terminal` | `ppid`). */
    keyKind: text('key_kind').notNull(),
    /** Bound CLEO session id — intra-DB FK to `tasks_sessions.id`, cascading on delete. */
    sessionId: text('session_id')
      .notNull()
      .references(() => tasksSessions.id, { onDelete: 'cascade' }),
    /** ISO-8601 UTC instant the binding was last written. */
    boundAt: text('bound_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [index('ix_session_terminal_bindings_session').on(table.sessionId)],
);
