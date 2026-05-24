/**
 * `cleo docs graph --root <slug>|<taskId>` — traverse the docs provenance
 * graph from a root doc or task and return a typed
 * {@link import('@cleocode/contracts').DocProvenanceResponse} envelope.
 *
 * The verb is the read surface for the provenance graph established by
 * ADR-078 §4 and the T10166 contract. Default depth is `2` hops; pass
 * `--depth N` to widen or narrow the BFS. Pass `--format dot` to render the
 * envelope as a Graphviz DOT string (the JSON envelope is still returned so
 * agent callers always see structured output).
 *
 * @see DocProvenanceResponse — packages/contracts/src/docs/provenance.ts
 * @see buildDocProvenanceGraph — packages/core/src/docs/build-provenance-graph.ts
 *
 * @task T10164 (Epic T10157 / Saga T9855)
 * @adr ADR-078
 */

import { ExitCode } from '@cleocode/contracts';
import {
  buildDocProvenanceGraph,
  DocProvenanceRootNotFoundError,
  renderProvenanceGraphAsDot,
} from '@cleocode/core/internal'; // core-first-allowed: T10164 docs.graph helpers not yet promoted to public barrel
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/**
 * `cleo docs graph` — provenance-graph traversal verb (T10164).
 *
 * @task T10164
 */
export const graphCommand = defineCommand({
  meta: {
    name: 'graph',
    description:
      'Traverse the docs provenance graph from a root (slug or task ID) and ' +
      'return a typed DocProvenanceResponse envelope. ' +
      'Walks supersedes/superseded-by chains plus cross-entity edges to ' +
      'owning + related tasks. Default depth=2. Pass --format dot for ' +
      'Graphviz output (still wrapped in the envelope under data.dot).',
  },
  args: {
    root: {
      type: 'string',
      description:
        'Root identifier — a canonical doc slug (e.g. adr-078-docs-provenance) ' +
        'or a CLEO task ID (T####). Required.',
      required: true,
    },
    depth: {
      type: 'string',
      description: 'Maximum BFS hops from the root (default: 2; minimum: 0).',
    },
    format: {
      type: 'string',
      description: 'Output format: json (default) | dot.',
    },
  },
  async run({ args }) {
    const root = String(args.root);
    const depth = parseDepth(args.depth);
    const format = parseFormat(args.format);

    try {
      const graph = await buildDocProvenanceGraph({ root, depth });
      const payload: Record<string, unknown> = { ...graph };
      if (format === 'dot') {
        payload['dot'] = renderProvenanceGraphAsDot(graph);
      }
      cliOutput(payload, { command: 'docs graph', operation: 'docs.graph' });
    } catch (err) {
      if (err instanceof DocProvenanceRootNotFoundError) {
        cliError(err.message, ExitCode.NOT_FOUND, {
          name: 'E_DOC_PROVENANCE_ROOT_NOT_FOUND',
          fix:
            'Verify the root with `cleo docs list --project --type adr` (or your kind) ' +
            'and pass an existing slug or task ID. Slugs and task IDs are matched ' +
            'against attachments.slug and attachment_refs.owner_id respectively.',
          details: { root },
        });
        process.exit(ExitCode.NOT_FOUND);
      }
      const message = err instanceof Error ? err.message : String(err);
      cliError(`docs graph failed: ${message}`, ExitCode.GENERAL_ERROR, {
        name: 'E_DOCS_GRAPH_FAILED',
      });
      process.exit(ExitCode.GENERAL_ERROR);
    }
  },
});

/**
 * Parse and validate the `--depth N` flag. Returns the default (2) when
 * unset; throws a `cliError` + exits on a non-integer or negative value.
 *
 * @internal
 */
function parseDepth(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 2;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    cliError(
      `--depth must be a non-negative integer (got '${String(raw)}')`,
      ExitCode.VALIDATION_ERROR,
      { name: 'E_VALIDATION' },
    );
    process.exit(ExitCode.VALIDATION_ERROR);
  }
  return parsed;
}

/**
 * Parse and validate the `--format` flag. Returns `'json'` when unset; exits
 * on any other value besides `'json'` or `'dot'`.
 *
 * @internal
 */
function parseFormat(raw: unknown): 'json' | 'dot' {
  if (raw === undefined || raw === null || raw === '') return 'json';
  const candidate = String(raw);
  if (candidate !== 'json' && candidate !== 'dot') {
    cliError(`--format must be one of: json|dot — got '${candidate}'`, ExitCode.VALIDATION_ERROR, {
      name: 'E_VALIDATION',
    });
    process.exit(ExitCode.VALIDATION_ERROR);
  }
  return candidate;
}
