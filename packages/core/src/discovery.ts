/**
 * Greenfield/Brownfield project discovery & classification (Phase 5).
 *
 * Classifies a project directory as either:
 *   - **greenfield**: empty or nearly-empty, no code, no git history
 *   - **brownfield**: existing codebase with files, possibly git history
 *
 * Used by `cleo init` (Phase 5 bootstrap) to choose the correct seed
 * pipeline:
 *   - Greenfield → seed a Vision/PRD "research" epic so the agent starts
 *     from a blank-slate planning posture
 *   - Brownfield → invoke codebase mapping and anchor findings in BRAIN as
 *     baseline context (per ULTRAPLAN §1 "Context Anchoring")
 *
 * Classification is intentionally simple and transparent — no heuristics,
 * no ML, just file/directory presence checks. A project qualifies as
 * brownfield if ANY of these are true:
 *   - `.git/` directory exists (under a size threshold we still treat as
 *     brownfield since history matters)
 *   - source files exist under common source dirs (src, lib, app, packages)
 *   - any manifest file exists (package.json, Cargo.toml, go.mod, pyproject.toml)
 *   - markdown docs already exist (README.md, docs/)
 *
 * @task Phase 5 — Greenfield/brownfield bootstrap + context anchoring
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Classification result for a project directory.
 */
export interface ProjectClassification {
  /** Project type: 'greenfield' (empty/new) or 'brownfield' (existing). */
  kind: 'greenfield' | 'brownfield';
  /** Absolute path that was classified. */
  directory: string;
  /** Signal list — which indicators led to the classification. */
  signals: ClassificationSignal[];
  /** Total non-hidden files found at the top level (for reporting). */
  topLevelFileCount: number;
  /** Whether a `.git/` directory is present. */
  hasGit: boolean;
}

/** A single classification signal detected on the filesystem. */
export interface ClassificationSignal {
  /** Canonical signal id for programmatic handling. */
  id:
    | 'git-dir'
    | 'source-dir'
    | 'package-manifest'
    | 'docs'
    | 'rust-manifest'
    | 'go-manifest'
    | 'python-manifest'
    | 'readme'
    | 'empty';
  /** Human-readable description of what was detected. */
  description: string;
  /** File or directory that triggered this signal. */
  path: string;
}

// ============================================================================
// Detection helpers
// ============================================================================

/** Common source directory names that indicate an existing codebase. */
const SOURCE_DIRS = ['src', 'lib', 'app', 'packages', 'crates', 'cmd', 'internal'];

/** Manifest files that indicate a managed project. */
const MANIFESTS: Array<{
  file: string;
  signal: ClassificationSignal['id'];
  description: string;
}> = [
  { file: 'package.json', signal: 'package-manifest', description: 'Node.js manifest' },
  { file: 'Cargo.toml', signal: 'rust-manifest', description: 'Rust manifest' },
  { file: 'go.mod', signal: 'go-manifest', description: 'Go manifest' },
  { file: 'pyproject.toml', signal: 'python-manifest', description: 'Python manifest (PEP 621)' },
  { file: 'requirements.txt', signal: 'python-manifest', description: 'Python requirements.txt' },
  { file: 'setup.py', signal: 'python-manifest', description: 'Python setup.py' },
];

/** Docs files/directories that indicate prior work. */
const DOCS_MARKERS: Array<{ path: string; signal: ClassificationSignal['id'] }> = [
  { path: 'README.md', signal: 'readme' },
  { path: 'README.rst', signal: 'readme' },
  { path: 'docs', signal: 'docs' },
];

/**
 * Check if a directory (at the top level only) contains any files that are
 * NOT part of the CLEO scaffolding itself. Used to decide whether the caller
 * is about to `cleo init` into an already-populated directory.
 */
function countMeaningfulTopLevelFiles(directory: string): number {
  if (!existsSync(directory)) return 0;
  try {
    const entries = readdirSync(directory);
    let count = 0;
    for (const entry of entries) {
      // Ignore hidden files, the CLEO dir itself, and common CI/git debris
      if (
        entry.startsWith('.') ||
        entry === '.cleo' ||
        entry === 'node_modules' ||
        entry === 'target' ||
        entry === 'dist' ||
        entry === 'build'
      ) {
        continue;
      }
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Classify a project directory as greenfield or brownfield.
 *
 * Read-only — never mutates the filesystem. Safe to call at any time.
 *
 * @param directory - Absolute or relative path; defaults to process.cwd()
 * @returns Classification result with signals and metadata
 *
 * @example
 * ```typescript
 * const classification = classifyProject('/my/project');
 * if (classification.kind === 'greenfield') {
 *   // Seed initial Vision epic
 * } else {
 *   // Run codebase mapping
 * }
 * ```
 */
export function classifyProject(directory?: string): ProjectClassification {
  const root = resolve(directory ?? process.cwd());
  const signals: ClassificationSignal[] = [];

  // Signal 1: .git directory
  const gitPath = join(root, '.git');
  const hasGit = existsSync(gitPath);
  if (hasGit) {
    signals.push({
      id: 'git-dir',
      description: '.git/ directory present — project has version history',
      path: gitPath,
    });
  }

  // Signal 2: manifest files
  for (const manifest of MANIFESTS) {
    const manifestPath = join(root, manifest.file);
    if (existsSync(manifestPath)) {
      signals.push({
        id: manifest.signal,
        description: manifest.description,
        path: manifestPath,
      });
    }
  }

  // Signal 3: common source directories
  for (const dir of SOURCE_DIRS) {
    const srcPath = join(root, dir);
    if (existsSync(srcPath) && isNonEmptyDir(srcPath)) {
      signals.push({
        id: 'source-dir',
        description: `Source directory ${dir}/ contains files`,
        path: srcPath,
      });
      break; // One source-dir signal is enough
    }
  }

  // Signal 4: docs / README
  for (const marker of DOCS_MARKERS) {
    const markerPath = join(root, marker.path);
    if (existsSync(markerPath)) {
      signals.push({
        id: marker.signal,
        description: `${marker.path} present`,
        path: markerPath,
      });
      break;
    }
  }

  const topLevelFileCount = countMeaningfulTopLevelFiles(root);

  // Empty signal if we have nothing
  if (signals.length === 0 && topLevelFileCount === 0) {
    signals.push({
      id: 'empty',
      description: 'No source files, manifests, git history, or docs detected',
      path: root,
    });
  }

  // Classification rule: brownfield if ANY non-'empty' signal present
  const kind: ProjectClassification['kind'] = signals.some((s) => s.id !== 'empty')
    ? 'brownfield'
    : 'greenfield';

  return {
    kind,
    directory: root,
    signals,
    topLevelFileCount,
    hasGit,
  };
}

/**
 * True if a directory exists AND contains at least one non-hidden entry.
 */
function isNonEmptyDir(dirPath: string): boolean {
  try {
    const stat = statSync(dirPath);
    if (!stat.isDirectory()) return false;
    const entries = readdirSync(dirPath).filter((e) => !e.startsWith('.'));
    return entries.length > 0;
  } catch {
    return false;
  }
}
