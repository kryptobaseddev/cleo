/**
 * LLMs.txt document generator for CLEO attachments.
 *
 * Reads all attachments on a target owner (task, session, etc.) and
 * produces an llms.txt-format document per the llmstxt.org spec:
 *   https://llmstxt.org
 *
 * Strategy:
 *   1. Try `llmtxt` npm package `generateOverview()` for per-attachment summaries.
 *   2. Fall back to a built-in minimal generator if llmtxt is unavailable:
 *      concat description + first N bytes of content, sectioned per attachment.
 *
 * The generated output is returned as a string.  The caller decides whether
 * to print it, write it to disk, or store it back as an llms-txt attachment.
 *
 * @epic T760
 * @task T798
 */

import type { AttachmentMetadata } from '@cleocode/contracts';
import { createAttachmentStore } from '../store/attachment-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Options for {@link generateDocsLlmsTxt}. */
export interface GenerateDocsOptions {
  /** Owner entity ID (e.g. `"T798"`, `"ses_..."`). */
  ownerId: string;
  /**
   * Maximum number of bytes to inline per attachment when using the built-in
   * fallback generator.
   *
   * @defaultValue 4000
   */
  maxInlineBytes?: number;
  /** Optional working directory for path resolution. */
  cwd?: string;
}

/** Result from {@link generateDocsLlmsTxt}. */
export interface GenerateDocsResult {
  /** Generated llms.txt-format markdown string. */
  content: string;
  /** Number of attachments processed. */
  attachmentCount: number;
  /** Whether the llmtxt package was used (`true`) or the fallback (`false`). */
  usedLlmtxtPackage: boolean;
  /** Per-attachment summaries used to build the document. */
  sections: Array<{
    attachmentId: string;
    sha256Prefix: string;
    description: string;
    summary: string;
  }>;
}

// ─── llmtxt package (optional, loaded lazily) ─────────────────────────────────

/**
 * Attempt to load `generateOverview` from the `llmtxt` npm package.
 *
 * Returns `null` if the package is not available (e.g. in environments where
 * the optional dependency was not installed).
 */
async function tryLoadGenerateOverview(): Promise<
  ((content: string) => { sections: Array<{ title: string; tokenCount: number }> }) | null
> {
  try {
    const mod = await import('llmtxt');
    if (typeof mod.generateOverview === 'function') {
      return mod.generateOverview as (content: string) => {
        sections: Array<{ title: string; tokenCount: number }>;
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Attachment content loader ────────────────────────────────────────────────

/**
 * Attempt to retrieve the text content of an attachment for summary purposes.
 *
 * Returns an empty string if the attachment is binary or unavailable.
 *
 * @param meta - Attachment metadata row.
 * @param maxBytes - Maximum bytes to load from disk.
 * @param cwd - Optional working directory.
 */
async function loadAttachmentText(
  meta: AttachmentMetadata,
  maxBytes: number,
  cwd?: string,
): Promise<string> {
  const store = createAttachmentStore();

  const kind = meta.attachment.kind;
  // Skip binary-only kinds: blob is potentially binary; pdf is always binary
  if (kind === 'blob') {
    const mime =
      'mime' in meta.attachment && typeof meta.attachment.mime === 'string'
        ? meta.attachment.mime
        : '';
    if (!mime.startsWith('text/') && mime !== 'application/json') {
      return '';
    }
  }

  if (kind === 'local-file' || kind === 'blob') {
    const result = await store.get(meta.sha256, cwd);
    if (!result) return '';
    const text = result.bytes.slice(0, maxBytes).toString('utf-8');
    // Replace non-printable characters except newlines/tabs
    return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  }

  if (kind === 'llms-txt') {
    const att = meta.attachment as import('@cleocode/contracts').LlmsTxtAttachment;
    return att.content.slice(0, maxBytes);
  }

  if (kind === 'url') {
    const att = meta.attachment as import('@cleocode/contracts').UrlAttachment;
    // If the URL was cached, read cached bytes; otherwise return the URL itself.
    if (att.cachedSha256) {
      const result = await store.get(att.cachedSha256, cwd);
      if (result) return result.bytes.slice(0, maxBytes).toString('utf-8');
    }
    return `URL: ${att.url}`;
  }

  return '';
}

// ─── Fallback generator ───────────────────────────────────────────────────────

/**
 * Minimal built-in llms.txt generator.
 *
 * Produces a document with one section per attachment. Each section contains:
 * - Description (from attachment metadata)
 * - First N bytes of text content
 *
 * @param metas - List of attachment metadata rows.
 * @param maxInlineBytes - Max bytes per attachment.
 * @param cwd - Optional working directory.
 */
async function generateFallback(
  metas: AttachmentMetadata[],
  maxInlineBytes: number,
  cwd?: string,
): Promise<
  Array<{
    attachmentId: string;
    sha256Prefix: string;
    description: string;
    summary: string;
  }>
> {
  const sections: Array<{
    attachmentId: string;
    sha256Prefix: string;
    description: string;
    summary: string;
  }> = [];

  for (const meta of metas) {
    const desc =
      'description' in meta.attachment && meta.attachment.description
        ? (meta.attachment.description as string)
        : `Attachment ${meta.id}`;

    const text = await loadAttachmentText(meta, maxInlineBytes, cwd);
    const preview = text
      ? `\`\`\`\n${text.slice(0, 2000)}${text.length > 2000 ? '\n...(truncated)' : ''}\n\`\`\``
      : '(binary or unavailable)';

    sections.push({
      attachmentId: meta.id,
      sha256Prefix: `${meta.sha256.slice(0, 8)}…`,
      description: desc,
      summary: preview,
    });
  }

  return sections;
}

// ─── llmtxt-package generator ─────────────────────────────────────────────────

/**
 * Generate per-attachment summaries using the `llmtxt` package's
 * `generateOverview()` structural analysis.
 *
 * @param metas - List of attachment metadata rows.
 * @param generateOverview - Resolved `generateOverview` function.
 * @param maxInlineBytes - Max bytes to load per attachment.
 * @param cwd - Optional working directory.
 */
async function generateWithLlmtxt(
  metas: AttachmentMetadata[],
  generateOverview: (content: string) => { sections: Array<{ title: string; tokenCount: number }> },
  maxInlineBytes: number,
  cwd?: string,
): Promise<
  Array<{
    attachmentId: string;
    sha256Prefix: string;
    description: string;
    summary: string;
  }>
> {
  const sections: Array<{
    attachmentId: string;
    sha256Prefix: string;
    description: string;
    summary: string;
  }> = [];

  for (const meta of metas) {
    const desc =
      'description' in meta.attachment && meta.attachment.description
        ? (meta.attachment.description as string)
        : `Attachment ${meta.id}`;

    const text = await loadAttachmentText(meta, maxInlineBytes, cwd);

    let summary: string;
    if (text) {
      try {
        const overview = generateOverview(text);
        const sectionList = overview.sections
          .slice(0, 10)
          .map((s) => `  - ${s.title} (~${s.tokenCount} tokens)`)
          .join('\n');
        summary =
          overview.sections.length > 0
            ? `Sections:\n${sectionList}`
            : `(no structural sections detected; ~${text.length} chars)`;
      } catch {
        // generateOverview failed — fall back to preview
        summary = `\`\`\`\n${text.slice(0, 1000)}${text.length > 1000 ? '\n...' : ''}\n\`\`\``;
      }
    } else {
      summary = '(binary or unavailable)';
    }

    sections.push({
      attachmentId: meta.id,
      sha256Prefix: `${meta.sha256.slice(0, 8)}…`,
      description: desc,
      summary,
    });
  }

  return sections;
}

// ─── llmstxt.org format builder ──────────────────────────────────────────────

/**
 * Build the llms.txt-format markdown document from per-attachment sections.
 *
 * Format follows https://llmstxt.org:
 *
 * ```markdown
 * # <title>
 *
 * > <description block>
 *
 * ## <section title>
 *
 * - [<description>](<sha256>): <summary>
 * ```
 *
 * @param ownerId - The owner entity ID (used as the document title).
 * @param sections - Per-attachment summaries.
 * @param usedLlmtxtPackage - Whether llmtxt was used.
 */
function buildLlmsTxt(
  ownerId: string,
  sections: Array<{
    attachmentId: string;
    sha256Prefix: string;
    description: string;
    summary: string;
  }>,
  usedLlmtxtPackage: boolean,
): string {
  const lines: string[] = [
    `# CLEO Attachment Bundle — ${ownerId}`,
    '',
    `> Generated by \`cleo docs generate --for ${ownerId}\`${usedLlmtxtPackage ? ' (via llmtxt)' : ' (built-in fallback)'}.`,
    `> ${sections.length} attachment(s) summarised.`,
    '',
  ];

  if (sections.length === 0) {
    lines.push('No attachments found for this owner.');
    return lines.join('\n');
  }

  lines.push('## Attachments');
  lines.push('');

  for (const section of sections) {
    lines.push(`### ${section.description}`);
    lines.push('');
    lines.push(`- **ID**: \`${section.attachmentId}\``);
    lines.push(`- **SHA-256 prefix**: \`${section.sha256Prefix}\``);
    lines.push('');
    lines.push(section.summary);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate an llms.txt-format document summarising all attachments on `ownerId`.
 *
 * Internally uses the `llmtxt` npm package's `generateOverview()` function for
 * structural section analysis. Falls back to a minimal built-in generator when
 * the package is unavailable.
 *
 * @param options - Generation options.
 * @returns Generated document and metadata.
 *
 * @example
 * ```ts
 * const result = await generateDocsLlmsTxt({ ownerId: 'T798' });
 * console.log(result.content); // llms.txt markdown
 * ```
 *
 * @epic T760
 * @task T798
 */
export async function generateDocsLlmsTxt(
  options: GenerateDocsOptions,
): Promise<GenerateDocsResult> {
  const { ownerId, maxInlineBytes = 4000, cwd } = options;

  // Infer owner type from ID prefix (mirrors docs.ts inferOwnerType)
  let ownerType = 'task';
  if (/^T\d+$/i.test(ownerId)) ownerType = 'task';
  else if (ownerId.startsWith('ses_')) ownerType = 'session';
  else if (ownerId.startsWith('O-')) ownerType = 'observation';
  else if (ownerId.startsWith('D-') || ownerId.startsWith('dec_')) ownerType = 'decision';
  else if (ownerId.startsWith('L-') || ownerId.startsWith('lrn_')) ownerType = 'learning';
  else if (ownerId.startsWith('P-') || ownerId.startsWith('pat_')) ownerType = 'pattern';

  // Load all attachments for this owner
  const store = createAttachmentStore();
  const metas = await store.listByOwner(ownerType, ownerId, cwd);

  // Try llmtxt package first
  const generateOverview = await tryLoadGenerateOverview();
  const usedLlmtxtPackage = generateOverview !== null;

  const sections = usedLlmtxtPackage
    ? await generateWithLlmtxt(metas, generateOverview!, maxInlineBytes, cwd)
    : await generateFallback(metas, maxInlineBytes, cwd);

  const content = buildLlmsTxt(ownerId, sections, usedLlmtxtPackage);

  return {
    content,
    attachmentCount: metas.length,
    usedLlmtxtPackage,
    sections,
  };
}
