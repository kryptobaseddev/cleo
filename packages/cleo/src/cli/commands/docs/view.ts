/**
 * `cleo docs view <slug|id>` — unified doc viewer for terminal display.
 *
 * Resolves a doc by slug or attachment ID through the canonical DocsReadModel,
 * fetches content, and renders it in the terminal with ANSI-formatted markdown.
 *
 * Supports three render modes:
 *   --render terminal  (default) — ANSI-formatted terminal output
 *   --render markdown  — raw markdown content
 *   --render json      — LAFS JSON envelope with metadata + decoded text (base64 for binary)
 *
 * Honors user preferences for color, width, and pagination.
 *
 * @task T11184
 * @epic T10519
 * @saga T10516
 */

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { createDocsReadModel } from '@cleocode/core/docs/docs-read-model';
import { buildDocsFetchResult } from '@cleocode/core/docs/fetch-result';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { type DocsViewOptions, renderDocsView } from '@cleocode/core/render/docs/view';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

function isDocsViewColorMode(value: string): value is NonNullable<DocsViewOptions['color']> {
  return value === 'auto' || value === 'always' || value === 'never';
}

const viewCommand = defineCommand({
  meta: {
    name: 'view',
    description:
      'View a doc by slug or attachment ID in the terminal. ' +
      'Resolves docs through the canonical read model and renders markdown ' +
      'with ANSI formatting (headings, bold, italic, code blocks, links).\n\n' +
      'Positional arguments:\n' +
      '  <slug|id>              Doc slug (kebab-case) or attachment ID (att_*) — required\n\n' +
      'Named arguments:\n' +
      '  --render <mode>        Output mode: terminal (default), markdown, json\n' +
      '  --color <mode>         Color behavior: auto (default), always, never\n' +
      '  --width <N>            Terminal width in columns (default: detected)\n\n' +
      'Examples:\n' +
      '  cleo docs view adr-088-cleo-daemon          # terminal-rendered ADR\n' +
      '  cleo docs view my-handoff --render markdown  # raw markdown\n' +
      '  cleo docs view att_abc123 --render json      # JSON envelope\n' +
      '  cleo docs view my-spec --color never         # no ANSI colors',
  },
  args: {
    'slug-or-id': {
      type: 'positional',
      description: 'Doc slug (kebab-case) or attachment ID (att_*)',
      required: true,
    },
    render: {
      type: 'string',
      description: 'Output mode: terminal (default), markdown, or json',
      default: 'terminal',
    },
    color: {
      type: 'string',
      description: 'Color behavior: auto (default), always, or never',
      default: 'auto',
    },
    width: {
      type: 'string',
      description: 'Terminal width in columns (default: auto-detect)',
    },
  },
  async run({ args }) {
    const ref = String(args['slug-or-id']);
    const renderMode = String(args.render ?? 'terminal');
    const colorMode = String(args.color ?? 'auto');
    const widthArg = args.width ? String(args.width) : undefined;

    if (!['terminal', 'markdown', 'json'].includes(renderMode)) {
      cliError(
        `--render must be one of: terminal|markdown|json — got '${renderMode}'`,
        ExitCode.VALIDATION_ERROR,
        { name: 'E_VALIDATION' },
      );
      return;
    }

    if (!isDocsViewColorMode(colorMode)) {
      cliError(
        `--color must be one of: auto|always|never — got '${colorMode}'`,
        ExitCode.VALIDATION_ERROR,
        { name: 'E_VALIDATION' },
      );
      return;
    }

    let width: number | undefined;
    if (widthArg !== undefined) {
      width = Number.parseInt(widthArg, 10);
      if (Number.isNaN(width) || width < 20 || width > 500) {
        cliError(
          `--width must be an integer between 20 and 500 — got '${widthArg}'`,
          ExitCode.VALIDATION_ERROR,
          { name: 'E_VALIDATION' },
        );
        return;
      }
    }

    const model = createDocsReadModel();
    const doc =
      (await model.resolveBySlug(ref)) ??
      (await model.resolveLatest(ref)) ??
      (await model.resolveByAttachmentId(ref));

    if (!doc) {
      cliError(`Doc not found: ${ref}`, ExitCode.NOT_FOUND, {
        name: 'E_NOT_FOUND',
        fix: `Check available docs with: cleo docs list --type all`,
      });
      return;
    }

    const content = await model.fetchContent(doc);
    if (content === null) {
      cliError(`Content not retrievable: ${ref}`, ExitCode.NOT_FOUND, {
        name: 'E_NOT_FOUND',
        fix: 'The doc metadata exists but its blob may be missing. Try: cleo docs publish <slug>',
      });
      return;
    }

    if (renderMode === 'json') {
      // T13352 — same shared builder as docs.fetch: decoded text by default,
      // real refCount, storage path against the doc's actual store.
      const result = buildDocsFetchResult({ doc, content, projectRoot: getProjectRoot() });
      cliOutput(result, {
        command: 'docs view',
        operation: 'docs.view',
        message: `doc ${doc.slug ?? doc.id} (${result.sizeBytes} bytes)`,
      });
      return;
    }

    if (renderMode === 'markdown') {
      process.stdout.write(content); // stdout-discipline-allowed: raw markdown view mode passthrough // stdout-write-allowed: raw markdown view mode passthrough
      if (!content.endsWith('\n')) process.stdout.write('\n'); // stdout-discipline-allowed: preserve trailing newline for raw markdown // stdout-write-allowed: preserve trailing newline for raw markdown
      return;
    }

    const rendered = renderDocsView(
      content,
      {
        slug: doc.slug ?? undefined,
        type: doc.kind ?? undefined,
        title: doc.title ?? undefined,
        sha256: doc.sha256,
      },
      { width, color: colorMode },
    );

    process.stdout.write(rendered + '\n'); // stdout-discipline-allowed: terminal renderer output passthrough // stdout-write-allowed: terminal renderer output passthrough
  },
});

export { viewCommand };
