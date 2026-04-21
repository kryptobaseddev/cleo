/**
 * Task document exporter — T947 Step 3.
 *
 * Emits a rich Markdown document for a CLEO task using the llmtxt
 * `formatMarkdown` primitive from `llmtxt/export`. The output includes:
 *
 *   1. YAML frontmatter (id, title, status, role, scope, priority, size, …)
 *      via llmtxt's canonical `DocumentExportState` + `formatMarkdown`.
 *   2. Description and acceptance criteria body.
 *   3. Attached blob manifest (via {@link blobList}) with SHA-256 backlinks.
 *   4. Memory observations referencing this task (opt-in), sourced from
 *      the BRAIN accessor.
 *
 * The `formatMarkdown` call is a pass-through to llmtxt — CLEO does NOT
 * re-implement frontmatter serialisation or LF-normalisation. When
 * `llmtxt/export` is unavailable (e.g. stripped bundle), a minimal built-in
 * Markdown builder is used as a graceful fallback.
 *
 * @epic T947
 * @see ./docs-generator.ts (llms.txt attachment generator — different concern)
 * @see ../store/blob-ops.ts (blob manifest reader)
 * @see ../sessions/agent-session-adapter.ts (session recording)
 */

import type { Task } from '@cleocode/contracts';
import { getProjectRoot } from '../paths.js';
import { blobList } from '../store/blob-ops.js';
import { getAccessor } from '../store/data-accessor.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Options for {@link exportDocument}.
 */
export interface ExportDocumentOptions {
  /**
   * CLEO task identifier to export (e.g. `"T947"`).
   */
  readonly taskId: string;

  /**
   * When `true`, the blob attachment manifest (name + SHA-256 + size)
   * is appended as a Markdown section with content-address backlinks.
   *
   * @defaultValue true
   */
  readonly includeAttachments?: boolean;

  /**
   * When `true`, BRAIN observations that reference this task are appended
   * as a Markdown section. Requires the BRAIN accessor to be available.
   *
   * @defaultValue false
   */
  readonly includeMemoryRefs?: boolean;

  /**
   * Absolute project root. Defaults to `getProjectRoot()`.
   */
  readonly projectRoot?: string;
}

/**
 * Result returned by {@link exportDocument}.
 */
export interface ExportDocumentResult {
  /** Full Markdown document with YAML frontmatter. */
  readonly markdown: string;
  /**
   * Number of rendered pages (1 per logical document section:
   * frontmatter + body = 1; each attachment adds 0 pages since they are
   * inline; memory refs section adds 1 when present).
   */
  readonly pages: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate a rich Markdown export of a CLEO task.
 *
 * Uses `llmtxt/export.formatMarkdown` for canonical frontmatter
 * serialisation. Falls back to a built-in Markdown builder when
 * the llmtxt package is unavailable.
 *
 * @param options - Export options (see {@link ExportDocumentOptions}).
 * @returns `{ markdown, pages }` — Markdown string and page count.
 *
 * @throws {Error} when `taskId` does not resolve to a known task.
 *
 * @example
 * ```ts
 * import { exportDocument } from '@cleocode/core/docs/export-document';
 *
 * const { markdown, pages } = await exportDocument({
 *   taskId: 'T947',
 *   includeAttachments: true,
 *   includeMemoryRefs: true,
 * });
 * console.log(markdown);
 * ```
 *
 * @epic T947
 */
export async function exportDocument(
  options: ExportDocumentOptions,
): Promise<ExportDocumentResult> {
  const {
    taskId,
    includeAttachments = true,
    includeMemoryRefs = false,
    projectRoot: projectRootOverride,
  } = options;

  const projectRoot = projectRootOverride ?? getProjectRoot();

  // Resolve the task
  const accessor = await getAccessor(projectRoot);
  const [task] = await accessor.loadTasks([taskId]);
  if (task === undefined) {
    throw new Error(`exportDocument: task ${taskId} not found`);
  }

  // Gather optional blob attachments
  const blobEntries = includeAttachments ? await blobList(taskId, projectRoot).catch(() => []) : [];

  // Gather optional memory refs
  const memoryRefs = includeMemoryRefs ? await loadMemoryRefs(taskId, projectRoot) : [];

  // Build the Markdown document
  const markdown = await buildMarkdown(task, blobEntries, memoryRefs);

  // Page count heuristic:
  //   1 base page (frontmatter + body)
  //   + 1 if memory refs section present
  const pages = 1 + (memoryRefs.length > 0 ? 1 : 0);

  return { markdown, pages };
}

// ─── Internal: Markdown builder ───────────────────────────────────────────────

/** Minimal shape of a BRAIN observation entry needed for this module. */
interface MemoryRef {
  id: string;
  title: string;
  text: string;
  createdAt?: string;
}

/** Minimal shape for a blob entry used locally. */
interface BlobEntry {
  name: string;
  sha256: string;
  sizeBytes: number;
  mimeType?: string;
}

/**
 * Build the full Markdown document.
 *
 * Attempts to use `llmtxt/export.formatMarkdown` for the frontmatter +
 * body section. Falls back to a built-in builder on any failure so the
 * function always succeeds.
 *
 * @internal
 */
async function buildMarkdown(
  task: Task,
  blobs: BlobEntry[],
  memRefs: MemoryRef[],
): Promise<string> {
  const bodyLines = buildBody(task);
  const body = bodyLines.join('\n');

  // Compute a deterministic content hash for the body section.
  // We use llmtxt's hashContent when available, otherwise a simple fallback.
  let contentHash: string;
  try {
    const { hashContent } = await import('llmtxt');
    contentHash = hashContent(body);
  } catch {
    // Fallback: hex of char-code sum (not cryptographic, but deterministic)
    contentHash = fallbackHash(body);
  }

  const exportedAt = new Date().toISOString();

  let markdownBase: string;

  // Prefer llmtxt formatMarkdown for canonical frontmatter
  try {
    const { formatMarkdown } = await import('llmtxt');
    const doc = {
      title: task.title,
      slug: task.id.toLowerCase(),
      version: 1,
      state: mapStatusToState(task.status),
      contributors: ['cleo'],
      contentHash,
      exportedAt,
      content: body,
      labels: task.labels ?? null,
      createdAt: task.createdAt ? new Date(task.createdAt).getTime() : null,
      updatedAt: task.updatedAt ? new Date(task.updatedAt).getTime() : null,
    };
    markdownBase = formatMarkdown(doc, { includeMetadata: true });
  } catch {
    // Fallback: minimal frontmatter + body
    markdownBase = buildFallbackMarkdown(task, body, contentHash, exportedAt);
  }

  // Append optional sections
  const extraSections: string[] = [];

  if (blobs.length > 0) {
    extraSections.push(buildBlobSection(task.id, blobs));
  }

  if (memRefs.length > 0) {
    extraSections.push(buildMemorySection(memRefs));
  }

  if (extraSections.length === 0) {
    return markdownBase;
  }

  // Ensure single trailing newline before appending sections
  const base = markdownBase.replace(/\n+$/, '\n');
  return `${base}\n${extraSections.join('\n')}\n`;
}

/**
 * Build the primary document body: description + acceptance criteria.
 *
 * @internal
 */
function buildBody(task: Task): string[] {
  const lines: string[] = [];

  lines.push(`## ${task.title}`, '');

  if (task.description) {
    lines.push(task.description, '');
  }

  if (task.acceptance && task.acceptance.length > 0) {
    lines.push('### Acceptance Criteria', '');
    for (const item of task.acceptance) {
      if (typeof item === 'string') {
        lines.push(`- ${item}`);
      } else if (typeof item === 'object' && item !== null && 'description' in item) {
        // AcceptanceGate object — surface description field
        const gate = item as { description?: string; kind?: string; req?: string };
        const prefix = gate.req ? `[${gate.req}] ` : '';
        const kindTag = gate.kind ? ` \`(${gate.kind})\`` : '';
        lines.push(`- ${prefix}${gate.description ?? 'gate'}${kindTag}`);
      }
    }
    lines.push('');
  }

  return lines;
}

/**
 * Map CLEO task status to an llmtxt lifecycle state string.
 *
 * @internal
 */
function mapStatusToState(status: string): string {
  switch (status) {
    case 'done':
      return 'LOCKED';
    case 'cancelled':
    case 'archived':
      return 'ARCHIVED';
    case 'in-progress':
    case 'review':
      return 'REVIEW';
    default:
      return 'DRAFT';
  }
}

/**
 * Minimal fallback Markdown when llmtxt/export is unavailable.
 *
 * Emits YAML frontmatter + body without the canonical Rust SSoT formatter.
 *
 * @internal
 */
function buildFallbackMarkdown(
  task: Task,
  body: string,
  contentHash: string,
  exportedAt: string,
): string {
  const frontmatter = [
    '---',
    `id: ${task.id}`,
    `title: ${JSON.stringify(task.title)}`,
    `status: ${task.status}`,
    `priority: ${task.priority}`,
    ...(task.type ? [`type: ${task.type}`] : []),
    ...(task.role ? [`role: ${task.role}`] : []),
    ...(task.scope ? [`scope: ${task.scope}`] : []),
    ...(task.size ? [`size: ${task.size}`] : []),
    ...(task.parentId ? [`parent: ${task.parentId}`] : []),
    `content_hash: ${contentHash}`,
    `exported_at: ${exportedAt}`,
    '---',
    '',
  ];

  return `${frontmatter.join('\n')}${body.trimEnd()}\n`;
}

/**
 * Build the blob attachments section.
 *
 * Each blob is listed with its name, SHA-256 backlink, size, and MIME type.
 *
 * @internal
 */
function buildBlobSection(taskId: string, blobs: BlobEntry[]): string {
  const lines = [`## Attachments (${blobs.length})`, ''];
  for (const blob of blobs) {
    const sizeLabel = formatBytes(blob.sizeBytes);
    const mimeLabel = blob.mimeType ? ` \`${blob.mimeType}\`` : '';
    lines.push(
      `- **${blob.name}**${mimeLabel} — ${sizeLabel}`,
      `  - sha256: \`${blob.sha256}\``,
      `  - backlink: \`cleo docs fetch ${taskId} ${blob.name}\``,
    );
  }
  return lines.join('\n');
}

/**
 * Build the memory observations section.
 *
 * @internal
 */
function buildMemorySection(memRefs: MemoryRef[]): string {
  const lines = [`## Memory Observations (${memRefs.length})`, ''];
  for (const ref of memRefs) {
    const dateLabel = ref.createdAt ? ` — ${ref.createdAt.slice(0, 10)}` : '';
    lines.push(`### ${ref.title}${dateLabel}`, '');
    lines.push(ref.text.slice(0, 500).trimEnd());
    if (ref.text.length > 500) lines.push('_(truncated)_');
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Format a byte count as a human-readable string.
 *
 * @internal
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Simple deterministic hex hash fallback for when llmtxt is unavailable.
 *
 * NOT cryptographically secure — for display / equality only.
 *
 * @internal
 */
function fallbackHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').repeat(8);
}

/**
 * Load BRAIN observations linked to the given taskId via `brain_memory_links`.
 *
 * Uses `getLinksForTask` to find all memory links, then resolves each
 * observation-type link via `getObservation`. Returns an empty array
 * silently on any failure so the caller is never blocked by BRAIN
 * accessor unavailability.
 *
 * @internal
 */
async function loadMemoryRefs(taskId: string, projectRoot: string): Promise<MemoryRef[]> {
  try {
    const { getBrainAccessor } = await import('../store/memory-accessor.js');
    const brain = await getBrainAccessor(projectRoot);

    // Get all memory links for this task
    const links = await brain.getLinksForTask(taskId);

    // Filter to observation-type links and resolve each one
    const obsLinks = links.filter((l) => l.memoryType === 'observation').slice(0, 10);

    const refs: MemoryRef[] = [];
    for (const link of obsLinks) {
      const obs = await brain.getObservation(link.memoryId);
      if (obs !== null) {
        refs.push({
          id: obs.id,
          title: obs.title,
          text: obs.narrative ?? '',
          createdAt: obs.createdAt ?? undefined,
        });
      }
    }

    return refs;
  } catch {
    return [];
  }
}
