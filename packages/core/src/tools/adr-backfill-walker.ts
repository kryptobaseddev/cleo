/**
 * ADR Backfill Walker — T1829
 *
 * One-time idempotent script that parses every `.cleo/adrs/*.md` (and the 9
 * unique ADRs in `docs/adr/`) and creates a `brain_decisions` row for each one.
 *
 * ## Usage
 *
 * ```bash
 * # Dry-run (no writes):
 * node packages/core/dist/tools/adr-backfill-walker.js --dry-run
 *
 * # Apply (writes to brain.db):
 * node packages/core/dist/tools/adr-backfill-walker.js --apply
 * ```
 *
 * ## Idempotency
 *
 * Rows are skipped when an existing `brain_decisions` row already has
 * `adrNumber` populated for that ADR number.  The check is transactional:
 * `SELECT … WHERE adr_number = ?`.
 *
 * ## Collisions (ADR-051..054)
 *
 * The four ADR numbers 051–054 each have two conflicting files in two
 * different directories. This walker uses `.cleo/adrs/` as the canonical
 * SSoT (per Epsilon audit decision) and SKIPS the `docs/adr/` versions.
 * A note is written to the report for each skipped collision.
 *
 * ## Duplicates (ADR-031/033, ADR-032/034)
 *
 * ADR-033 duplicates ADR-031 and ADR-034 duplicates ADR-032. The first
 * number is kept as canonical; the second is inserted with
 * `supersededBy = <first>` and `confirmationState = 'superseded'`.
 *
 * @task T1829
 * @epic T1824
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * ADR numbers in the collision zone (051–054).
 * `.cleo/adrs/` versions are canonical; `docs/adr/` versions are skipped.
 */
const COLLISION_ADR_NUMBERS = new Set([51, 52, 53, 54]);

/**
 * Exact-duplicate pair map: secondary ADR → canonical ADR.
 * The secondary ADR will be inserted with `supersededBy = canonical`.
 */
const DUPLICATE_PAIRS: Record<number, number> = {
  33: 31, // ADR-033 duplicates ADR-031
  34: 32, // ADR-034 duplicates ADR-032
};

// ─── Frontmatter parsing ──────────────────────────────────────────────────────

interface AdrFrontmatter {
  /** ADR number extracted from filename or frontmatter, e.g. 51 */
  adrNumber: number;
  /** ADR title */
  title: string;
  /** Lifecycle status: accepted | proposed | superseded | rejected | archived | draft */
  status: string;
  /** Date string */
  date?: string;
  /** Supersedes ADR number (if any, from frontmatter "Supersedes:" or "supersedes:") */
  supersedesAdrNumber?: number;
  /** Superseded-by ADR number (if any) */
  supersededByAdrNumber?: number;
}

/**
 * Extract ADR number from a filename like `ADR-031-foo.md`.
 * Returns -1 if no match.
 */
function extractAdrNumberFromFilename(filename: string): number {
  const m = filename.match(/^ADR-(\d{3})/i);
  return m ? parseInt(m[1], 10) : -1;
}

/**
 * Parse the frontmatter and first heading of an ADR markdown file.
 *
 * Supports two formats:
 * 1. YAML frontmatter (---…---)
 * 2. Markdown bold-field format (**Status**: …)
 *
 * Falls back to sensible defaults when fields are absent.
 */
function parseAdrFrontmatter(content: string, filename: string): AdrFrontmatter {
  const adrNumber = extractAdrNumberFromFilename(filename);
  let title = filename.replace(/\.md$/, '');
  let status = 'accepted';
  let date: string | undefined;
  let supersedesAdrNumber: number | undefined;
  let supersededByAdrNumber: number | undefined;

  // ── YAML frontmatter (--- ... ---) ──────────────────────────────────────────
  const yamlMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (yamlMatch) {
    const yamlBlock = yamlMatch[1];

    // title
    const titleLine = yamlBlock.match(/^title:\s*(.+)$/m);
    if (titleLine) title = titleLine[1].trim().replace(/^['"]|['"]$/g, '');

    // status
    const statusLine = yamlBlock.match(/^status:\s*(.+)$/m);
    if (statusLine) status = statusLine[1].trim().toLowerCase();

    // date
    const dateLine = yamlBlock.match(/^(?:created|date|updated):\s*(.+)$/m);
    if (dateLine) date = dateLine[1].trim();

    // supersedes: ADR-NNN or just NNN
    const supersedesLine = yamlBlock.match(/^supersedes:\s*(.+)$/im);
    if (supersedesLine) {
      const val = supersedesLine[1].trim();
      if (val !== '~' && val !== 'null' && val !== '') {
        const m = val.match(/(\d{3})/);
        if (m) supersedesAdrNumber = parseInt(m[1], 10);
      }
    }

    // superseded-by
    const supersededByLine = yamlBlock.match(/^superseded.by:\s*(.+)$/im);
    if (supersededByLine) {
      const val = supersededByLine[1].trim();
      if (val !== '~' && val !== 'null' && val !== '') {
        const m = val.match(/(\d{3})/);
        if (m) supersededByAdrNumber = parseInt(m[1], 10);
      }
    }
  }

  // ── Markdown heading extraction (after possible YAML block) ─────────────────
  // Find first H1 or H2 heading for a better title
  const headingMatch = content.match(/^#+\s+(.+)$/m);
  if (headingMatch && (title === filename.replace(/\.md$/, '') || yamlMatch)) {
    // Only override with heading if we got a title from YAML that looks synthetic,
    // or if there was no YAML title. Use heading as secondary source.
    if (!yamlMatch?.toString().includes('title:')) {
      title = headingMatch[1].trim();
    }
  }

  // ── Markdown bold-field format: **Status**: ... ──────────────────────────────
  if (!yamlMatch) {
    // status
    const boldStatus = content.match(/\*\*[Ss]tatus\*\*\s*:?\s*(.+?)(?:\n|$)/m);
    if (boldStatus) {
      // Strip markdown formatting and extra notes
      status = boldStatus[1].replace(/\*+/g, '').split(/[·(,]/)[0].trim().toLowerCase();
    }

    // date
    const boldDate = content.match(/\*\*[Dd]ate\*\*\s*:?\s*(.+?)(?:\n|$)/m);
    if (boldDate) date = boldDate[1].replace(/\*+/g, '').trim();

    // supersedes (prose / bold)
    const supersedesMatch = content.match(/[Ss]upersedes[:\s]+(?:ADR-)?(\d{3})/g);
    if (supersedesMatch) {
      const m = supersedesMatch[0].match(/(\d{3})/);
      if (m) supersedesAdrNumber = parseInt(m[1], 10);
    }

    // superseded-by
    const supersededByMatch = content.match(/[Ss]uperseded[- ][Bb]y[:\s]+(?:ADR-)?(\d{3})/g);
    if (supersededByMatch) {
      const m = supersededByMatch[0].match(/(\d{3})/);
      if (m) supersededByAdrNumber = parseInt(m[1], 10);
    }

    // Get title from first heading
    const h1 = content.match(/^#\s+(.+)$/m);
    const h2 = content.match(/^##\s+(.+)$/m);
    if (h1) title = h1[1].trim();
    else if (h2) title = h2[1].trim();
  }

  // Normalise status
  const statusLower = status.toLowerCase();
  if (statusLower.includes('accept')) status = 'accepted';
  else if (statusLower.includes('supersed')) status = 'superseded';
  else if (statusLower.includes('reject')) status = 'rejected';
  else if (statusLower.includes('archive')) status = 'archived';
  else if (statusLower.includes('draft')) status = 'draft';
  else if (statusLower.includes('propos')) status = 'proposed';
  else status = 'accepted'; // default for established ADRs

  return { adrNumber, title, status, date, supersedesAdrNumber, supersededByAdrNumber };
}

/**
 * Build a concise decision text and rationale from an ADR.
 * Uses the title + first non-heading paragraph from the body as rationale.
 */
function buildDecisionText(
  title: string,
  content: string,
): { decision: string; rationale: string } {
  const decision = title.slice(0, 250);

  // Strip YAML frontmatter if present
  let body = content.replace(/^---[\s\S]*?---\r?\n/, '');

  // Strip headings
  body = body.replace(/^#+\s+.+$/gm, '').trim();

  // Strip bold-field metadata lines like **Status**: ...
  body = body.replace(/^\*\*[^*]+\*\*\s*:.*$/gm, '').trim();

  // Strip horizontal rules
  body = body.replace(/^---+$/gm, '').trim();

  // Find first non-empty paragraph
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const rationale =
    paragraphs.length > 0
      ? paragraphs[0].replace(/\n/g, ' ').replace(/\s+/g, ' ').slice(0, 500)
      : `ADR file: ${title}`;

  return { decision, rationale: rationale || `Architectural decision: ${title}` };
}

// ─── Database helpers ─────────────────────────────────────────────────────────

/** Check if a brain_decisions row with this adrNumber already exists. */
async function rowExistsForAdrNumber(
  projectRoot: string,
  adrNumber: number,
): Promise<{ exists: boolean; rowId?: string }> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  const { brainDecisions } = await import('../store/memory-schema.js');
  const { eq } = await import('drizzle-orm');
  const db = await getBrainDb(projectRoot);
  const rows = await db
    .select({ id: brainDecisions.id })
    .from(brainDecisions)
    .where(eq(brainDecisions.adrNumber, adrNumber))
    .limit(1);
  return rows.length > 0 ? { exists: true, rowId: rows[0].id } : { exists: false };
}

/** Get the next available decision ID (D001, D002, …). */
async function nextDecisionId(projectRoot: string): Promise<string> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  const { brainDecisions } = await import('../store/memory-schema.js');
  const { desc } = await import('drizzle-orm');
  const db = await getBrainDb(projectRoot);
  const rows = await db
    .select({ id: brainDecisions.id })
    .from(brainDecisions)
    .orderBy(desc(brainDecisions.id))
    .limit(1);
  if (rows.length === 0) return 'D001';
  const last = rows[0].id;
  const num = parseInt(last.replace(/\D/g, ''), 10);
  return Number.isNaN(num) ? 'D001' : `D${String(num + 1).padStart(3, '0')}`;
}

/** Resolve the brain_decisions ID for a given ADR number (used for supersedure links). */
async function decisionIdForAdrNumber(
  projectRoot: string,
  adrNumber: number,
): Promise<string | null> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  const { brainDecisions } = await import('../store/memory-schema.js');
  const { eq } = await import('drizzle-orm');
  const db = await getBrainDb(projectRoot);
  const rows = await db
    .select({ id: brainDecisions.id })
    .from(brainDecisions)
    .where(eq(brainDecisions.adrNumber, adrNumber))
    .limit(1);
  return rows.length > 0 ? rows[0].id : null;
}

/** Write a brain_decisions row directly via Drizzle (bypasses storeDecision gate pipeline). */
async function insertAdrDecisionRow(
  projectRoot: string,
  opts: {
    id: string;
    adrNumber: number;
    adrPath: string;
    decision: string;
    rationale: string;
    confirmationState: 'accepted' | 'proposed' | 'superseded';
    decidedBy: 'owner' | 'agent' | 'council';
    supersedes?: string; // brain_decisions ID
    supersededBy?: string; // brain_decisions ID
    contentHash: string;
  },
): Promise<void> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  const { brainDecisions } = await import('../store/memory-schema.js');
  const db = await getBrainDb(projectRoot);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  await db.insert(brainDecisions).values({
    id: opts.id,
    type: 'architecture',
    decision: opts.decision,
    rationale: opts.rationale,
    confidence: 'high',
    outcome: 'success',
    qualityScore: 0.85,
    memoryTier: 'long',
    memoryType: 'semantic',
    sourceConfidence: 'owner',
    verified: true,
    contentHash: opts.contentHash,
    adrNumber: opts.adrNumber,
    adrPath: opts.adrPath,
    supersedes: opts.supersedes,
    supersededBy: opts.supersededBy,
    confirmationState: opts.confirmationState,
    decidedBy: opts.decidedBy,
    createdAt: now,
    updatedAt: now,
    provenanceClass: 'swept-clean',
    peerId: 'adr-backfill-walker',
    peerScope: 'project',
    decisionCategory: 'architectural',
  });
}

// ─── Report structures ────────────────────────────────────────────────────────

interface WalkerResult {
  adrNumber: number;
  filename: string;
  filePath: string;
  action: 'inserted' | 'skipped-exists' | 'skipped-collision' | 'skipped-error';
  note?: string;
  decisionId?: string;
  supersedureTo?: string; // for duplicate pairs: "supersededBy ADR-031"
}

// ─── Main walker ──────────────────────────────────────────────────────────────

/**
 * Main walker function.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param dryRun      - When true, no writes are performed.
 * @returns Array of results per ADR file processed.
 */
export async function runAdrBackfillWalker(
  projectRoot: string,
  dryRun: boolean,
): Promise<WalkerResult[]> {
  const results: WalkerResult[] = [];
  const cleoCanonicalsDir = join(projectRoot, '.cleo', 'adrs');
  const docsAdrDir = join(projectRoot, 'docs', 'adr');

  // ── Collect all ADR files ─────────────────────────────────────────────────

  const allFiles: Array<{ dir: string; filename: string; source: 'cleo' | 'docs' }> = [];

  // Primary: .cleo/adrs/
  const cleoFiles = await readdir(cleoCanonicalsDir).catch(() => [] as string[]);
  for (const f of cleoFiles) {
    if (f.endsWith('.md') && /^ADR-\d{3}/i.test(f)) {
      allFiles.push({ dir: cleoCanonicalsDir, filename: f, source: 'cleo' });
    }
  }

  // Secondary: docs/adr/ — only include ADR numbers NOT already in .cleo/adrs/
  const cleoAdrNumbers = new Set(
    cleoFiles.map((f) => extractAdrNumberFromFilename(f)).filter((n) => n > 0),
  );

  if (existsSync(docsAdrDir)) {
    const docsFiles = await readdir(docsAdrDir).catch(() => [] as string[]);
    for (const f of docsFiles) {
      if (!f.endsWith('.md')) continue;
      const n = extractAdrNumberFromFilename(f);
      if (n <= 0) continue; // skip unnumbered drafts

      if (COLLISION_ADR_NUMBERS.has(n)) {
        // Collision: docs/adr/ version skipped; .cleo/adrs/ is canonical
        results.push({
          adrNumber: n,
          filename: f,
          filePath: join(docsAdrDir, f),
          action: 'skipped-collision',
          note: `ADR-${String(n).padStart(3, '0')} collision: docs/adr/ version skipped. .cleo/adrs/ is canonical. HITL needed before merging.`,
        });
        continue;
      }

      if (!cleoAdrNumbers.has(n)) {
        allFiles.push({ dir: docsAdrDir, filename: f, source: 'docs' });
      }
    }
  }

  // Sort by ADR number for deterministic order
  allFiles.sort((a, b) => {
    const na = extractAdrNumberFromFilename(a.filename);
    const nb = extractAdrNumberFromFilename(b.filename);
    return na - nb;
  });

  // ── Process each ADR file ─────────────────────────────────────────────────

  for (const { dir, filename } of allFiles) {
    const filePath = join(dir, filename);
    const adrNumber = extractAdrNumberFromFilename(filename);
    const relPath = relative(projectRoot, filePath).replace(/\\/g, '/');

    let content: string;
    try {
      content = await readFile(filePath, 'utf8');
    } catch (err) {
      results.push({
        adrNumber,
        filename,
        filePath,
        action: 'skipped-error',
        note: `Could not read file: ${String(err)}`,
      });
      continue;
    }

    const fm = parseAdrFrontmatter(content, filename);
    const { decision, rationale } = buildDecisionText(fm.title, content);

    // Idempotency check: skip if row with this adrNumber already exists
    const existing = await rowExistsForAdrNumber(projectRoot, adrNumber);
    if (existing.exists) {
      results.push({
        adrNumber,
        filename,
        filePath,
        action: 'skipped-exists',
        note: `brain_decisions row ${existing.rowId} already has adrNumber=${adrNumber}`,
        decisionId: existing.rowId,
      });
      continue;
    }

    // Determine confirmation state
    let confirmationState: 'accepted' | 'proposed' | 'superseded' = 'accepted';
    if (fm.status === 'superseded' || fm.status === 'archived' || fm.status === 'rejected') {
      confirmationState = 'superseded';
    } else if (fm.status === 'proposed' || fm.status === 'draft') {
      confirmationState = 'proposed';
    }

    // Check if this is a known duplicate (secondary of a pair)
    const canonicalAdrNumber = DUPLICATE_PAIRS[adrNumber];
    let supersededByDecisionId: string | undefined;
    let supersededByNote: string | undefined;

    if (canonicalAdrNumber !== undefined) {
      confirmationState = 'superseded';
      supersededByNote = `Duplicate of ADR-${String(canonicalAdrNumber).padStart(3, '0')} — marked superseded`;
      if (!dryRun) {
        supersededByDecisionId =
          (await decisionIdForAdrNumber(projectRoot, canonicalAdrNumber)) ?? undefined;
      }
    }

    // Resolve supersedes link from frontmatter
    let supersedesDecisionId: string | undefined;
    if (fm.supersedesAdrNumber !== undefined && !dryRun) {
      supersedesDecisionId =
        (await decisionIdForAdrNumber(projectRoot, fm.supersedesAdrNumber)) ?? undefined;
    }

    const { createHash } = await import('node:crypto');
    const contentHash = createHash('sha256')
      .update((decision + '\n' + rationale).toLowerCase())
      .digest('hex')
      .slice(0, 16);

    if (dryRun) {
      results.push({
        adrNumber,
        filename,
        filePath,
        action: 'inserted',
        note: `[DRY-RUN] Would insert: decision="${decision.slice(0, 80)}…" status=${confirmationState} path=${relPath}${supersededByNote ? ` note=${supersededByNote}` : ''}`,
        supersedureTo: canonicalAdrNumber
          ? `supersededBy ADR-${String(canonicalAdrNumber).padStart(3, '0')}`
          : undefined,
      });
      continue;
    }

    // Live insert
    try {
      const id = await nextDecisionId(projectRoot);
      await insertAdrDecisionRow(projectRoot, {
        id,
        adrNumber,
        adrPath: relPath,
        decision,
        rationale,
        confirmationState,
        decidedBy: 'owner',
        supersedes: supersedesDecisionId,
        supersededBy: supersededByDecisionId,
        contentHash,
      });
      results.push({
        adrNumber,
        filename,
        filePath,
        action: 'inserted',
        note: `Inserted as ${id} (adrNumber=${adrNumber}, state=${confirmationState})${supersededByNote ? ` — ${supersededByNote}` : ''}`,
        decisionId: id,
        supersedureTo: canonicalAdrNumber
          ? `supersededBy ADR-${String(canonicalAdrNumber).padStart(3, '0')}`
          : undefined,
      });
    } catch (err) {
      results.push({
        adrNumber,
        filename,
        filePath,
        action: 'skipped-error',
        note: `Insert failed: ${String(err)}`,
      });
    }
  }

  return results;
}

// ─── Report writer ────────────────────────────────────────────────────────────

/**
 * Write the backfill report to `.cleo/agent-outputs/T1824-5-backfill-report.md`.
 */
async function writeReport(
  projectRoot: string,
  results: WalkerResult[],
  dryRun: boolean,
): Promise<string> {
  const inserted = results.filter((r) => r.action === 'inserted');
  const skippedExists = results.filter((r) => r.action === 'skipped-exists');
  const skippedCollision = results.filter((r) => r.action === 'skipped-collision');
  const skippedError = results.filter((r) => r.action === 'skipped-error');
  const duplicatePairs = results.filter((r) => r.supersedureTo);

  const date = new Date().toISOString().split('T')[0];
  const mode = dryRun ? 'DRY-RUN (no writes)' : 'APPLIED';

  const lines: string[] = [
    '# ADR Backfill Walker Report — T1829',
    '',
    `**Date**: ${date}`,
    `**Mode**: ${mode}`,
    `**Task**: T1829`,
    `**Epic**: T1824`,
    '',
    '---',
    '',
    '## Summary',
    '',
    `| Category | Count |`,
    `|----------|-------|`,
    `| Inserted (or would-insert in dry-run) | ${inserted.length} |`,
    `| Skipped — row already exists | ${skippedExists.length} |`,
    `| Skipped — collision (HITL needed) | ${skippedCollision.length} |`,
    `| Skipped — error | ${skippedError.length} |`,
    `| Duplicate-pair supersession applied | ${duplicatePairs.length} |`,
    '',
    '---',
    '',
  ];

  if (inserted.length > 0) {
    lines.push('## Inserted Rows');
    lines.push('');
    for (const r of inserted) {
      const prefix = dryRun ? '[DRY-RUN] ' : '';
      lines.push(`- **ADR-${String(r.adrNumber).padStart(3, '0')}** (\`${basename(r.filePath)}\`)`);
      if (r.decisionId) lines.push(`  - Decision ID: \`${r.decisionId}\``);
      if (r.note) lines.push(`  - ${r.note.replace(/^\[DRY-RUN\] /, prefix)}`);
      if (r.supersedureTo) lines.push(`  - Supersession: ${r.supersedureTo}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  if (skippedExists.length > 0) {
    lines.push('## Skipped — Already Populated');
    lines.push('');
    for (const r of skippedExists) {
      lines.push(`- **ADR-${String(r.adrNumber).padStart(3, '0')}**: ${r.note ?? ''}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  if (skippedCollision.length > 0) {
    lines.push('## Skipped — ADR Number Collisions (HITL Required)');
    lines.push('');
    lines.push(
      'These ADR numbers exist in BOTH `.cleo/adrs/` and `docs/adr/` with **different content**.',
    );
    lines.push(
      'The `.cleo/adrs/` version is canonical. Owner must decide how to renumber the `docs/adr/` versions.',
    );
    lines.push('');
    for (const r of skippedCollision) {
      lines.push(`### ADR-${String(r.adrNumber).padStart(3, '0')}`);
      lines.push('');
      lines.push(`- **File skipped**: \`${r.filePath}\``);
      lines.push(`- **Reason**: ${r.note ?? ''}`);
      lines.push('');
    }
    lines.push('**Action required**: File HITL request to owner for renumbering decision.');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  if (skippedError.length > 0) {
    lines.push('## Skipped — Errors');
    lines.push('');
    for (const r of skippedError) {
      lines.push(`- **ADR-${String(r.adrNumber).padStart(3, '0')}**: ${r.note ?? ''}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  if (duplicatePairs.length > 0) {
    lines.push('## Duplicate-Pair Supersession');
    lines.push('');
    lines.push(
      'The following ADRs were identified as exact duplicates within `.cleo/adrs/` and were',
    );
    lines.push(
      'inserted with `confirmationState=superseded` and a `supersededBy` link to the canonical ADR.',
    );
    lines.push('');
    for (const r of duplicatePairs) {
      lines.push(
        `- **ADR-${String(r.adrNumber).padStart(3, '0')}** → ${r.supersedureTo} (\`${basename(r.filePath)}\`)`,
      );
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  lines.push('## Collision Details');
  lines.push('');
  lines.push('### ADR-051..054 Collision Pairs');
  lines.push('');
  lines.push('| ADR Number | `.cleo/adrs/` file (canonical) | `docs/adr/` file (skipped) |');
  lines.push('|------------|-------------------------------|----------------------------|');
  lines.push(
    '| ADR-051 | `ADR-051-programmatic-gate-integrity.md` | `ADR-051-override-patterns.md` |',
  );
  lines.push('| ADR-052 | `ADR-052-caamp-keeps-commander.md` | `ADR-052-sdk-consolidation.md` |');
  lines.push(
    '| ADR-053 | `ADR-053-project-agnostic-release-pipeline.md` | `ADR-053-playbook-runtime.md` |',
  );
  lines.push(
    '| ADR-054 | `ADR-054-manifest-unification.md` | `ADR-054-migration-system-hybrid-path-a-plus.md` |',
  );
  lines.push('');
  lines.push(
    'Owner must decide renumbering: e.g. `docs/adr/ADR-052-sdk-consolidation.md` → ADR-065.',
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Generated by `packages/core/src/tools/adr-backfill-walker.ts` (T1829)*');

  const report = lines.join('\n');
  const reportPath = join(projectRoot, '.cleo', 'agent-outputs', 'T1824-5-backfill-report.md');
  await mkdir(join(projectRoot, '.cleo', 'agent-outputs'), { recursive: true });
  await writeFile(reportPath, report, 'utf8');
  return reportPath;
}

// ─── CLI entrypoint ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');

  if (!dryRun && !apply) {
    console.error(
      'Usage: adr-backfill-walker.js --dry-run | --apply\n\n' +
        '  --dry-run  Show what would be inserted, no writes\n' +
        '  --apply    Write brain_decisions rows for all ADRs\n',
    );
    process.exit(1);
  }

  // Resolve project root (walk up from CWD looking for .cleo/)
  const { getProjectRoot } = await import('../paths.js');
  const projectRoot = getProjectRoot();

  console.log(`[T1829] ADR Backfill Walker`);
  console.log(`[T1829] Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  console.log(`[T1829] Project root: ${projectRoot}`);
  console.log('');

  const results = await runAdrBackfillWalker(projectRoot, dryRun);

  const inserted = results.filter((r) => r.action === 'inserted');
  const skippedExists = results.filter((r) => r.action === 'skipped-exists');
  const skippedCollision = results.filter((r) => r.action === 'skipped-collision');
  const skippedError = results.filter((r) => r.action === 'skipped-error');

  console.log(`Results:`);
  console.log(`  Inserted (or would-insert): ${inserted.length}`);
  console.log(`  Skipped (already exist):    ${skippedExists.length}`);
  console.log(`  Skipped (collision/HITL):   ${skippedCollision.length}`);
  console.log(`  Skipped (error):            ${skippedError.length}`);
  console.log('');

  for (const r of results) {
    const icon =
      r.action === 'inserted'
        ? '[+]'
        : r.action === 'skipped-exists'
          ? '[=]'
          : r.action === 'skipped-collision'
            ? '[!]'
            : '[E]';
    const num = String(r.adrNumber).padStart(3, '0');
    console.log(`  ${icon} ADR-${num} ${r.filename}${r.note ? ` — ${r.note}` : ''}`);
  }

  console.log('');
  const reportPath = await writeReport(projectRoot, results, dryRun);
  console.log(`[T1829] Report written to: ${reportPath}`);

  if (skippedError.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[T1829] Fatal error:', err);
  process.exit(1);
});
