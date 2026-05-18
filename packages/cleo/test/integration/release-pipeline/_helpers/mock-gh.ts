/**
 * Mock `gh` CLI responses for release-pipeline integration tests (T9543).
 *
 * Tests must not make real network calls. This module owns an in-process
 * registry of canned responses and exposes {@link runMockGh} as the
 * gh-invocation surface. Production code paths that invoke `gh` via
 * `execFileSync` are exercised indirectly — tests call `runMockGh` directly
 * to simulate what the real verb would observe.
 *
 * **Why not `vi.spyOn(child_process, 'execFileSync')`?**
 *
 * ESM module namespaces are non-configurable, so `vi.spyOn` on a re-exported
 * `child_process` symbol throws `Cannot redefine property`. The workaround
 * pattern across the cleocode codebase is to inject the invoker as a
 * function parameter (dependency injection), or — when that is not feasible
 * — to drive the mock at the test layer directly. This module takes the
 * latter approach: tests call `runMockGh` instead of relying on a global
 * monkey-patch.
 *
 * The registry is reset between tests via {@link installGhMock}/`.restore()`
 * so the mocks remain scoped per-test.
 *
 * @task T9543
 */

/**
 * Shape of `gh pr view --json state,mergeCommit,mergedAt` response.
 *
 * The real `gh` CLI emits `mergeCommit: { oid: string }` when the PR is
 * merged. We mirror that shape exactly so call-sites can reuse production
 * parsers.
 */
export interface MockGhPrViewResponse {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeCommit: { oid: string } | null;
  mergedAt: string | null;
  url: string;
}

/**
 * Shape of `gh release view --json tagName,publishedAt,name,url` response.
 */
export interface MockGhReleaseViewResponse {
  tagName: string;
  publishedAt: string;
  name: string;
  url: string;
}

/**
 * Options for {@link mockGhPrView}.
 */
export interface MockGhPrViewOptions {
  /** Final state to report. */
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  /** Merge commit OID. Required when `state='MERGED'`. */
  mergeCommitOid?: string;
  /** ISO-8601 timestamp the PR was merged. Defaults to plan timestamp. */
  mergedAt?: string;
  /** PR URL to surface in the response. */
  url?: string;
}

/**
 * Options for {@link mockGhReleaseView}.
 */
export interface MockGhReleaseViewOptions {
  /** Git tag the release was published against. */
  tagName: string;
  /** ISO-8601 publish timestamp. */
  publishedAt?: string;
  /** Human-friendly release name. */
  name?: string;
  /** Release URL. */
  url?: string;
}

/**
 * Internal registry — maps a substring matcher to a canned response. The
 * mock invoker iterates this list in insertion order and returns the first
 * matching response.
 */
interface MockEntry {
  matchArgs: (args: ReadonlyArray<string>) => boolean;
  response: string;
}

/**
 * Module-scoped state. Reset by every `installGhMock()` call so leaked
 * state between tests is impossible.
 */
interface MockState {
  entries: MockEntry[];
  invocations: Array<{ file: string; args: ReadonlyArray<string> }>;
}

const STATE: MockState = {
  entries: [],
  invocations: [],
};

/**
 * Handle returned by {@link installGhMock}.
 *
 * Tests call `.restore()` in `afterEach` to clear the registry.
 */
export interface GhMockHandle {
  /** Clears the registry + invocations list. */
  restore: () => void;
  /** Returns a snapshot of every captured `runMockGh` invocation. */
  invocations: () => Array<{ file: string; args: ReadonlyArray<string> }>;
}

/**
 * Initializes (or resets) the mock registry for a single test. Returns a
 * handle that the test's `afterEach` MUST call `.restore()` on to keep
 * scenarios isolated.
 *
 * @example
 * ```ts
 * let handle: ReturnType<typeof installGhMock>;
 * beforeEach(() => { handle = installGhMock(); });
 * afterEach(() => { handle.restore(); });
 * ```
 */
export function installGhMock(): GhMockHandle {
  STATE.entries.length = 0;
  STATE.invocations.length = 0;
  return {
    restore: () => {
      STATE.entries.length = 0;
      STATE.invocations.length = 0;
    },
    invocations: () => [...STATE.invocations],
  };
}

/**
 * Test-side surrogate for a `gh` CLI invocation. Production code would call
 * `execFileSync('gh', args)`; tests call this instead to drive the same
 * code path with a canned response.
 *
 * Throws if no registered matcher matches `args` — surfacing missing mocks
 * loudly instead of returning an empty envelope that would silently break a
 * downstream parser.
 *
 * @param args Argument vector passed to the simulated `gh` invocation.
 * @returns The matching canned response (typically JSON).
 */
export function runMockGh(args: ReadonlyArray<string>): string {
  STATE.invocations.push({ file: 'gh', args });
  for (const entry of STATE.entries) {
    if (entry.matchArgs(args)) {
      return entry.response;
    }
  }
  throw new Error(
    `runMockGh: no matcher registered for args [${args.join(' ')}]. ` +
      `Call mockGhPrView() / mockGhReleaseView() / mockGhCommand() first.`,
  );
}

/**
 * Registers a canned `gh pr view --json ...` response.
 *
 * Matches any `gh` invocation whose args contain `pr` and `view`.
 *
 * @example
 * ```ts
 * mockGhPrView({ state: 'MERGED', mergeCommitOid: 'deadbeef' });
 * const raw = runMockGh(['pr', 'view', '--json', 'state,mergeCommit']);
 * const parsed = JSON.parse(raw) as MockGhPrViewResponse;
 * ```
 */
export function mockGhPrView(opts: MockGhPrViewOptions): void {
  if (opts.state === 'MERGED' && !opts.mergeCommitOid) {
    throw new Error("mockGhPrView: 'mergeCommitOid' is required when state='MERGED'");
  }
  const response: MockGhPrViewResponse = {
    state: opts.state,
    mergeCommit: opts.mergeCommitOid ? { oid: opts.mergeCommitOid } : null,
    mergedAt: opts.mergedAt ?? (opts.state === 'MERGED' ? '2026-06-01T13:00:00Z' : null),
    url: opts.url ?? 'https://github.com/example/repo/pull/9999',
  };
  STATE.entries.push({
    matchArgs: (args) => args.includes('pr') && args.includes('view'),
    response: JSON.stringify(response),
  });
}

/**
 * Registers a canned `gh release view --json ...` response.
 *
 * Matches any `gh` invocation whose args contain `release` and `view`.
 */
export function mockGhReleaseView(opts: MockGhReleaseViewOptions): void {
  const response: MockGhReleaseViewResponse = {
    tagName: opts.tagName,
    publishedAt: opts.publishedAt ?? '2026-06-01T13:30:00Z',
    name: opts.name ?? opts.tagName,
    url: opts.url ?? `https://github.com/example/repo/releases/tag/${opts.tagName}`,
  };
  STATE.entries.push({
    matchArgs: (args) => args.includes('release') && args.includes('view'),
    response: JSON.stringify(response),
  });
}

/**
 * Registers a canned `gh ...` response for arbitrary subcommands.
 *
 * Use this when {@link mockGhPrView} / {@link mockGhReleaseView} don't fit —
 * e.g. mocking `gh pr create` or `gh workflow run`.
 *
 * @param matchSubcommand Substring that MUST appear in the args vector for
 *   this entry to match (e.g. `'create'` matches `gh pr create ...`).
 * @param response Either a string body or a JSON-serializable object.
 */
export function mockGhCommand(matchSubcommand: string, response: string | object): void {
  const payload = typeof response === 'string' ? response : JSON.stringify(response);
  STATE.entries.push({
    matchArgs: (args) => args.includes(matchSubcommand),
    response: payload,
  });
}
