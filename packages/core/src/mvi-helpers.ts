/**
 * MVI _next directive helpers for progressive disclosure.
 *
 * When CLEO returns results in minimal MVI mode, `_next` provides a map of
 * available follow-up operations the agent can take. This enables progressive
 * disclosure: agents get lean results and can drill deeper only when needed.
 *
 * @example
 * ```json
 * {"id": "T042", "title": "Fix auth", "status": "active",
 *   "_next": {"full": "cleo show T042", "children": "cleo find --parent T042"}}
 * ```
 *
 * @task T-MVI-06
 */

/** Map of follow-up operation names to CLI command strings. */
export type NextDirectives = Record<string, string>;

/**
 * Build `_next` directives for a full task detail result (tasks.show).
 *
 * @param taskId - The task ID to generate directives for
 * @returns A map of available follow-up operations
 */
export function taskShowNext(taskId: string): NextDirectives {
  return {
    full: `cleo show ${taskId} --mvi full`,
    children: `cleo find --parent ${taskId}`,
    deps: `cleo deps ${taskId}`,
  };
}

/**
 * Build `_next` directives for a task in a list or find result.
 *
 * @param taskId - The task ID to generate directives for
 * @returns A map of available follow-up operations
 */
export function taskListItemNext(taskId: string): NextDirectives {
  return {
    show: `cleo show ${taskId}`,
  };
}

/**
 * Build `_next` directives for a session in a list or find result.
 *
 * @param sessionId - The session ID to generate directives for
 * @returns A map of available follow-up operations
 */
export function sessionListItemNext(sessionId: string): NextDirectives {
  return {
    show: `cleo session show ${sessionId}`,
  };
}

/**
 * Build `_next` directives for a session start result.
 *
 * @returns A map of available follow-up operations after starting a session
 */
export function sessionStartNext(): NextDirectives {
  return {
    current: 'cleo current',
    stop: 'cleo session end',
  };
}

/**
 * Build `_next` directives for a memory search (find) hit.
 *
 * @param entryId - The brain entry ID to generate directives for
 * @returns A map of available follow-up operations
 */
export function memoryFindHitNext(entryId: string): NextDirectives {
  return {
    fetch: `cleo memory fetch ${entryId}`,
  };
}
