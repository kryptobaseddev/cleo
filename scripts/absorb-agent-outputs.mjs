/**
 * absorb-agent-outputs.mjs
 *
 * Classifies .md files under .cleo/agent-outputs/ and ingests them into BRAIN
 * observations (via `cleo memory observe`) and/or docs attachments (via `cleo
 * docs add`). Superseded / stale files are moved to _archive/.
 *
 * Classification logic (in priority order):
 *   superseded  — file starts with "STALE" marker or contains it prominently
 *   handoff     — session handoff / next-session files (archived, key learning extracted)
 *   decision    — council reports, ADR-related decisions, architecture decisions
 *   research    — research reports, analysis, technical deep-dives
 *   pattern     — identified recurring patterns, best practices
 *   learning    — implementation summaries, lessons learned, fix reports
 *   observation — campaign trackers, audit reports, validation reports, release plans
 *
 * Idempotency: a JSON state file (.cleo/absorb-agent-outputs-state.json) tracks
 * which paths have already been processed (by content-hash). Re-running skips
 * already-imported entries.
 *
 * Usage:
 *   node scripts/absorb-agent-outputs.mjs [--dry-run] [--dir <path>] [--limit <n>]
 *
 * Options:
 *   --dry-run   Print what would be ingested without actually running cleo commands
 *   --dir       Agent-outputs directory (default: .cleo/agent-outputs)
 *   --limit     Process at most N files (useful for testing)
 *   --verbose   Print full classification details for each file
 *
 * @task T1613
 * @epic T1611
 */

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const isVerbose = args.includes('--verbose');
const dirArgIdx = args.indexOf('--dir');
const limitArgIdx = args.indexOf('--limit');

const PROJECT_ROOT = process.cwd();

const AGENT_OUTPUTS_DIR =
  dirArgIdx !== -1 && args[dirArgIdx + 1]
    ? resolve(args[dirArgIdx + 1])
    : join(PROJECT_ROOT, '.cleo', 'agent-outputs');

const LIMIT =
  limitArgIdx !== -1 && args[limitArgIdx + 1]
    ? Number.parseInt(args[limitArgIdx + 1], 10)
    : Number.POSITIVE_INFINITY;

const ARCHIVE_DIR = join(AGENT_OUTPUTS_DIR, '_archive');
const STATE_PATH = join(PROJECT_ROOT, '.cleo', 'absorb-agent-outputs-state.json');

// ---------------------------------------------------------------------------
// State management (idempotency)
// ---------------------------------------------------------------------------

/** @returns Map of relPath -> contentHash for already-processed files */
function loadState() {
  try {
    if (!existsSync(STATE_PATH)) return new Map();
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    return new Map(Object.entries(parsed.processed ?? {}));
  } catch {
    return new Map();
  }
}

/** Persist updated state map */
function saveState(processed) {
  const obj = Object.fromEntries(processed);
  writeFileSync(STATE_PATH, JSON.stringify({ processed: obj, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
}

/** Compute a short SHA-256 hash of file content */
function fileHash(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a markdown file into one of:
 *   superseded | handoff | decision | research | pattern | learning | observation
 *
 * Returns: { type, memoryType, shouldArchive, linkedTask, title, summary }
 *
 * @param {string} filePath
 * @param {string} content
 */
function classifyFile(filePath, content) {
  const fileName = filePath.split('/').pop() ?? filePath;
  const baseName = fileName.replace(/\.md$/i, '');
  const firstLines = content.slice(0, 1500).toLowerCase();
  const titleMatch = content.match(/^#\s+(.+)/m);
  const rawTitle = titleMatch ? titleMatch[1].trim() : baseName.replace(/[-_]/g, ' ');

  // Extract a task reference from filename or content
  const taskRefMatch = fileName.match(/^(T\d+)/i) ?? content.match(/\b(T\d{3,5})\b/);
  const linkedTask = taskRefMatch ? taskRefMatch[1].toUpperCase() : null;

  // -------------------------------------------------------------------------
  // 1. Superseded / stale files
  // -------------------------------------------------------------------------
  if (
    firstLines.includes('stale — do not read') ||
    firstLines.includes('deprecated as canonical state') ||
    firstLines.includes('superseded') ||
    fileName.startsWith('MANIFEST') ||
    fileName === 'pipeline_manifest.md'
  ) {
    return {
      type: 'superseded',
      memoryType: null,
      shouldArchive: true,
      linkedTask,
      title: rawTitle,
      summary: `Superseded/stale file archived: ${fileName}`,
    };
  }

  // -------------------------------------------------------------------------
  // 2. Handoff files — archive but extract a learning
  // -------------------------------------------------------------------------
  if (
    /handoff/i.test(fileName) ||
    /next.session/i.test(fileName) ||
    /HANDOFF/i.test(fileName)
  ) {
    return {
      type: 'handoff',
      memoryType: 'session_summary',
      shouldArchive: true,
      linkedTask,
      title: rawTitle,
      summary: buildSummary(content, 800),
    };
  }

  // -------------------------------------------------------------------------
  // 3. Council / decision files
  // -------------------------------------------------------------------------
  if (
    /council/i.test(fileName) ||
    /decision/i.test(fileName) ||
    firstLines.includes('the council —') ||
    firstLines.includes('adr-') ||
    firstLines.includes('architecture decision') ||
    /ADR/i.test(fileName)
  ) {
    return {
      type: 'decision',
      memoryType: 'decision',
      shouldArchive: false,
      linkedTask,
      title: rawTitle,
      summary: buildSummary(content, 800),
    };
  }

  // -------------------------------------------------------------------------
  // 4. Research files
  // -------------------------------------------------------------------------
  if (
    /research/i.test(fileName) ||
    /R-[a-z]/i.test(fileName) ||
    firstLines.includes('research date') ||
    firstLines.includes('technical analysis') ||
    firstLines.includes('technical research') ||
    firstLines.includes('analysis report') ||
    /bench(mark)?/i.test(fileName) ||
    /ladybug/i.test(fileName) ||
    /rcasd.*round/i.test(fileName)
  ) {
    return {
      type: 'research',
      memoryType: 'discovery',
      shouldArchive: false,
      linkedTask,
      title: rawTitle,
      summary: buildSummary(content, 800),
    };
  }

  // -------------------------------------------------------------------------
  // 5. Pattern files
  // -------------------------------------------------------------------------
  if (
    /pattern/i.test(fileName) ||
    firstLines.includes('recurring pattern') ||
    firstLines.includes('best practice') ||
    /playbook/i.test(fileName) ||
    /protocol/i.test(fileName)
  ) {
    return {
      type: 'pattern',
      memoryType: 'pattern',
      shouldArchive: false,
      linkedTask,
      title: rawTitle,
      summary: buildSummary(content, 800),
    };
  }

  // -------------------------------------------------------------------------
  // 6. Implementation / fix / release notes → learning
  // -------------------------------------------------------------------------
  if (
    /impl(ementation)?/i.test(fileName) ||
    /fix-/i.test(fileName) ||
    /^fix/i.test(fileName) ||
    /release/i.test(fileName) ||
    /complete$/i.test(baseName) ||
    /shipped/i.test(fileName) ||
    firstLines.includes('status**: complete') ||
    firstLines.includes('status: complete') ||
    firstLines.includes('status**: shipped') ||
    firstLines.includes('status: shipped') ||
    firstLines.includes('## what was built') ||
    firstLines.includes('## implementation summary') ||
    firstLines.includes('completion report') ||
    /T\d+-impl/i.test(fileName) ||
    /T\d+.*complete/i.test(fileName) ||
    /^T\d+-release/i.test(fileName)
  ) {
    return {
      type: 'learning',
      memoryType: 'feature',
      shouldArchive: false,
      linkedTask,
      title: rawTitle,
      summary: buildSummary(content, 800),
    };
  }

  // -------------------------------------------------------------------------
  // 7. Audit / validation / plan / campaign / inventory → observation
  // -------------------------------------------------------------------------
  return {
    type: 'observation',
    memoryType: 'change',
    shouldArchive: false,
    linkedTask,
    title: rawTitle,
    summary: buildSummary(content, 800),
  };
}

/**
 * Build a concise summary from the first N characters of content.
 * Strips markdown header noise, returns plain-ish text.
 *
 * @param {string} content
 * @param {number} maxChars
 * @returns {string}
 */
function buildSummary(content, maxChars) {
  // Remove frontmatter
  let text = content.replace(/^---[\s\S]*?---\s*/m, '');
  // Remove markdown image syntax
  text = text.replace(/!\[.*?\]\(.*?\)/g, '');
  // Collapse whitespace
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  // Truncate
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  }
  return text;
}

// ---------------------------------------------------------------------------
// File discovery (only .md files at root of agent-outputs, skip _archive)
// ---------------------------------------------------------------------------

/**
 * Discover all .md files immediately under AGENT_OUTPUTS_DIR (non-recursive).
 * Excludes the _archive subdirectory and MANIFEST files.
 *
 * @returns {string[]} Absolute file paths
 */
function discoverFiles() {
  if (!existsSync(AGENT_OUTPUTS_DIR)) {
    console.error(`Agent-outputs directory not found: ${AGENT_OUTPUTS_DIR}`);
    process.exit(1);
  }

  return readdirSync(AGENT_OUTPUTS_DIR)
    .filter((name) => {
      if (name === '_archive') return false;
      const full = join(AGENT_OUTPUTS_DIR, name);
      const stat = statSync(full);
      return stat.isFile() && name.toLowerCase().endsWith('.md');
    })
    .map((name) => join(AGENT_OUTPUTS_DIR, name));
}

// ---------------------------------------------------------------------------
// cleo CLI wrappers
// ---------------------------------------------------------------------------

/**
 * Run a cleo CLI command, returning parsed JSON output.
 *
 * @param {string[]} cmdArgs
 * @returns {{ success: boolean, data: unknown, error?: unknown, raw: string }}
 */
function runCleo(cmdArgs) {
  if (isDryRun) {
    console.log(`  [DRY-RUN] cleo ${cmdArgs.join(' ')}`);
    return { success: true, data: { dryRun: true }, raw: '' };
  }

  const result = spawnSync('cleo', cmdArgs, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const raw = result.stdout ?? '';
  const stderr = result.stderr ?? '';

  try {
    const parsed = JSON.parse(raw);
    return { success: parsed.success === true, data: parsed.data, error: parsed.error, raw };
  } catch {
    // Non-JSON output (some cleo commands print plain text)
    if (result.status === 0) {
      return { success: true, data: raw.trim(), raw };
    }
    return { success: false, data: null, error: stderr || raw, raw };
  }
}

/**
 * Ingest a file as a BRAIN observation.
 *
 * @param {{ title: string, summary: string, memoryType: string, linkedTask: string|null }} opts
 * @returns {{ success: boolean, observationId: string|null }}
 */
function ingestAsObservation({ title, summary, memoryType, linkedTask }) {
  const truncatedTitle = title.slice(0, 120);
  const truncatedSummary = summary.slice(0, 2000);

  const cmdArgs = [
    'memory', 'observe',
    truncatedSummary,
    '--title', truncatedTitle,
    '--type', memoryType,
    '--agent', 'absorb-agent-outputs',
    '--source-type', 'auto',
  ];

  const result = runCleo(cmdArgs);

  if (isVerbose) {
    console.log(`    observe result: success=${result.success}`);
  }

  // Extract observation ID from data if present
  let observationId = null;
  if (result.data && typeof result.data === 'object') {
    observationId = result.data.id ?? result.data.observationId ?? null;
  }

  return { success: result.success, observationId };
}

/**
 * Attach a file to a task via `cleo docs add`.
 *
 * @param {string} taskId
 * @param {string} filePath
 * @param {string} desc
 * @returns {{ success: boolean }}
 */
function attachToTask(taskId, filePath, desc) {
  const cmdArgs = [
    'docs', 'add',
    taskId,
    filePath,
    '--desc', desc.slice(0, 200),
    '--attached-by', 'absorb-agent-outputs',
  ];

  const result = runCleo(cmdArgs);
  return { success: result.success };
}

/**
 * Archive a file by moving it to _archive/.
 *
 * @param {string} filePath
 */
function archiveFile(filePath) {
  if (!existsSync(ARCHIVE_DIR)) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
  const fileName = filePath.split('/').pop();
  const dest = join(ARCHIVE_DIR, fileName);

  if (isDryRun) {
    console.log(`  [DRY-RUN] archive ${fileName} → _archive/`);
    return;
  }

  // If destination exists, add a timestamp suffix to avoid collision
  const finalDest = existsSync(dest)
    ? join(ARCHIVE_DIR, `${Date.now()}-${fileName}`)
    : dest;

  renameSync(filePath, finalDest);
}

// ---------------------------------------------------------------------------
// Stats tracker
// ---------------------------------------------------------------------------

const stats = {
  total: 0,
  skipped: 0,
  superseded: 0,
  handoff: 0,
  decision: 0,
  research: 0,
  pattern: 0,
  learning: 0,
  observation: 0,
  archived: 0,
  docsAttached: 0,
  errors: 0,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('absorb-agent-outputs.mjs');
  console.log(`  Source: ${AGENT_OUTPUTS_DIR}`);
  console.log(`  Archive: ${ARCHIVE_DIR}`);
  console.log(`  State: ${STATE_PATH}`);
  console.log(`  Dry-run: ${isDryRun}`);
  console.log('');

  const processed = loadState();
  const files = discoverFiles();

  console.log(`Found ${files.length} .md files to evaluate`);
  if (!isDryRun) {
    mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  let count = 0;

  for (const filePath of files) {
    if (count >= LIMIT) {
      console.log(`Limit of ${LIMIT} reached — stopping.`);
      break;
    }

    const relPath = relative(PROJECT_ROOT, filePath);
    const fileName = filePath.split('/').pop();

    // Compute hash for idempotency
    let hash;
    try {
      hash = fileHash(filePath);
    } catch {
      console.warn(`  WARN: cannot read ${fileName} — skipping`);
      stats.errors++;
      continue;
    }

    const stateKey = relPath;
    if (processed.get(stateKey) === hash) {
      if (isVerbose) {
        console.log(`  SKIP (already processed): ${fileName}`);
      }
      stats.skipped++;
      continue;
    }

    let content;
    try {
      content = readFileSync(filePath, 'utf-8').trim();
    } catch {
      console.warn(`  WARN: cannot read ${fileName} — skipping`);
      stats.errors++;
      continue;
    }

    if (!content) {
      stats.skipped++;
      continue;
    }

    stats.total++;
    count++;

    const classification = classifyFile(filePath, content);
    const { type, memoryType, shouldArchive, linkedTask, title, summary } = classification;

    console.log(`[${String(count).padStart(3)}] ${fileName}`);
    console.log(`      type=${type} memoryType=${memoryType ?? 'n/a'} task=${linkedTask ?? 'none'} archive=${shouldArchive}`);

    stats[type] = (stats[type] ?? 0) + 1;

    let observationId = null;

    // Ingest into BRAIN (all except pure-superseded MANIFEST files)
    if (memoryType !== null) {
      const ingested = ingestAsObservation({ title, summary, memoryType, linkedTask });
      if (!ingested.success) {
        console.warn(`      WARN: memory observe failed for ${fileName}`);
        stats.errors++;
      } else {
        observationId = ingested.observationId;
      }
    }

    // Attach to linked task if we have one and the file has substantive content
    if (linkedTask && !shouldArchive && !isDryRun) {
      const attached = attachToTask(linkedTask, filePath, `Agent output: ${title.slice(0, 120)}`);
      if (attached.success) {
        stats.docsAttached++;
      }
      // We don't warn on attachment failure — task may not exist in current DB
    }

    // Archive superseded and handoff files
    if (shouldArchive) {
      archiveFile(filePath);
      stats.archived++;
    }

    // Mark as processed
    processed.set(stateKey, hash);

    // Save state periodically (every 10 files) to survive partial runs
    if (count % 10 === 0 && !isDryRun) {
      saveState(processed);
    }
  }

  // Final state save
  if (!isDryRun) {
    saveState(processed);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('');
  console.log('=== Summary ===');
  console.log(`  Evaluated:   ${stats.total}`);
  console.log(`  Skipped:     ${stats.skipped} (already processed)`);
  console.log(`  Superseded:  ${stats.superseded}`);
  console.log(`  Handoff:     ${stats.handoff}`);
  console.log(`  Decision:    ${stats.decision}`);
  console.log(`  Research:    ${stats.research}`);
  console.log(`  Pattern:     ${stats.pattern}`);
  console.log(`  Learning:    ${stats.learning}`);
  console.log(`  Observation: ${stats.observation}`);
  console.log(`  Archived:    ${stats.archived}`);
  console.log(`  Docs linked: ${stats.docsAttached}`);
  console.log(`  Errors:      ${stats.errors}`);
  if (isDryRun) {
    console.log('');
    console.log('DRY-RUN complete — no changes written.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
