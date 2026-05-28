/**
 * `cleo docs view <slug|id>` — unified doc viewer for terminal display.
 *
 * Resolves a doc by slug or attachment ID through the canonical DocsReadModel,
 * fetches content, and renders it in the terminal with ANSI-formatted markdown.
 *
 * Supports three render modes:
 *   --render terminal  (default) — ANSI-formatted terminal output
 *   --render markdown  — raw markdown content
 *   --render json      — LAFS JSON envelope with metadata + base64 content
 *
 * Honors user preferences for color, width, and pagination.
 *
 * @task T11184
 * @epic T10519
 * @saga T10516
 */

import { Buffer } from 'node:buffer';
import { ExitCode } from '@cleocode/contracts';
import { createDocsReadModel } from '@cleocode/core/internal';
import { renderDocsView } from '@cleocode/core';
import { defineCommand } from 'citty';
import { cliError, cliOutput } from '../renderers/index.js';

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

    if (!['auto', 'always', 'never'].includes(colorMode)) {
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

    const contentBytes = Buffer.from(content, 'utf-8');

    if (renderMode === 'json') {
      const bytesBase64 =
        contentBytes.length <= 1024 * 1024 ? contentBytes.toString('base64') : undefined;
      cliOutput(
        {
          metadata: {
            id: doc.id,
            sha256: doc.sha256,
            kind: 'blob',
            mime: doc.mimeType ?? 'text/plain',
            size: doc.sizeBytes,
            description: doc.summary ?? undefined,
            createdAt: doc.createdAt,
            ...(doc.slug ? { slug: doc.slug } : {}),
            ...(doc.kind ? { type: doc.kind } : {}),
            ...(doc.title ? { title: doc.title } : {}),
            ...(doc.blobName ? { blobName: doc.blobName } : {}),
          },
          sizeBytes: contentBytes.length,
          ...(bytesBase64 !== undefined ? { bytesBase64 } : {}),
          inlined: bytesBase64 !== undefined,
        },
        {
          command: 'docs view',
          operation: 'docs.view',
          message: `doc ${doc.slug ?? doc.id} (${contentBytes.length} bytes)`,
        },
      );
      return;
    }

    if (renderMode === 'markdown') {
      process.stdout.write(content);
      if (!content.endsWith('\n')) process.stdout.write('\n');
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

    process.stdout.write(rendered + '\n');
  },
});

export { viewCommand };
