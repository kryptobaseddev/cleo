/**
 * Canonical spawn prompt builder — T882.
 *
 * Produces fully-resolved, self-contained spawn prompts for subagents spawned
 * via `cleo orchestrate spawn <taskId>`. The resulting prompt is 100%
 * copy-pastable into any LLM runtime (Claude, GPT-4, Gemini, open-source) and
 * embeds everything the subagent needs to execute without re-resolving
 * protocol content.
 *
 * ## Tier system
 *
 * | Tier | Content |
 * |------|---------|
 * | 0    | Minimal: task metadata + return-format contract + evidence-gate commands |
 * | 1    | Standard (DEFAULT): tier 0 + CLEO-INJECTION.md embed + stage-specific guidance + quality-gate commands + absolute paths + session linkage |
 * | 2    | Full: tier 1 + ct-cleo + ct-orchestrator skill excerpts + SUBAGENT-PROTOCOL-BLOCK + anti-pattern reference |
 *
 * ## Protocol phases (RCASD-IVTR+C)
 *
 * Ten phases get stage-specific guidance blocks (research, consensus,
 * architecture_decision, specification, decomposition, implementation,
 * validation, testing, release, contribution). Every phase produces the
 * same outer prompt structure — only the `Stage-Specific Guidance` section
 * varies.
 *
 * ## Consolidation
 *
 * Replaces the inlined `buildSpawnPrompt` helper that previously lived in
 * `packages/core/src/orchestration/index.ts`. `prepareSpawn` delegates here.
 * `prepareSpawnContext` in `packages/core/src/skills/dispatch.ts` is a
 * skill-auto-dispatch helper (different role — selects WHICH skill to use)
 * and is not a spawn prompt builder; callers can compose it with
 * {@link buildSpawnPrompt} but should not confuse the two.
 *
 * @task T882
 * @task T883
 * @task T884
 * @task T885
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task } from '@cleocode/contracts';
import { resolveSkillPath } from '../skills/skill-paths.js';

/**
 * Locate `packages/core/templates/CLEO-INJECTION.md` at runtime.
 *
 * Handles three layouts:
 * 1. **TS source** — module at `packages/core/src/orchestration/spawn-prompt.ts`
 *    (dev via vitest/ts-node) → walk up to `packages/core/`.
 * 2. **Compiled dist** — module at `packages/core/dist/orchestration/spawn-prompt.js`
 *    (published npm package) → walk up to `packages/core/`.
 * 3. **Bundled** — when `@cleocode/cleo` bundles this module into
 *    `packages/cleo/dist/cli/index.js`, `import.meta.url` points at the
 *    bundle, NOT at the original source. In that case fall back to a
 *    `node_modules/@cleocode/core/templates/CLEO-INJECTION.md` lookup
 *    starting from the bundle directory. In the monorepo dev setup
 *    `packages/cleo/node_modules/@cleocode/core` is a pnpm symlink to
 *    `packages/core/`, so this resolves correctly too.
 *
 * Returns the absolute path to CLEO-INJECTION.md, or `null` if no layout
 * contains the file. The cached string in {@link loadCleoInjection} degrades
 * gracefully on `null`.
 */
function locateCleoInjectionTemplate(): string | null {
  const thisFile = fileURLToPath(import.meta.url);
  const candidates: string[] = [];

  // Layout 1 + 2: walk up from this file until we find a `templates/` sibling
  // of our own package (or hit filesystem root).
  let dir = dirname(thisFile);
  for (let i = 0; i < 8; i++) {
    const direct = join(dir, 'templates', 'CLEO-INJECTION.md');
    if (existsSync(direct)) return direct;
    candidates.push(direct);
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  // Layout 3: bundled — try node_modules/@cleocode/core/templates/ from a
  // few ancestor directories of the bundle.
  let baseDir = dirname(thisFile);
  for (let i = 0; i < 8; i++) {
    const nm = join(baseDir, 'node_modules', '@cleocode', 'core', 'templates', 'CLEO-INJECTION.md');
    if (existsSync(nm)) return nm;
    const parent = resolve(baseDir, '..');
    if (parent === baseDir) break;
    baseDir = parent;
  }

  return null;
}

// ============================================================================
// Types
// ============================================================================

/** Protocol tiers per ADR-051 / T882 spawn contract. */
export type SpawnTier = 0 | 1 | 2;

/** Default tier when none specified. */
export const DEFAULT_SPAWN_TIER: SpawnTier = 1;

/**
 * Canonical set of RCASD-IVTR+C protocol phases.
 *
 * The orchestrator's `autoDispatch` may emit any of these strings; the
 * `architecture_decision`, `validation`, and `testing` phases are available
 * here even if `autoDispatch` falls back to `implementation` / `consensus`.
 */
export type SpawnProtocolPhase =
  | 'research'
  | 'consensus'
  | 'architecture_decision'
  | 'specification'
  | 'decomposition'
  | 'implementation'
  | 'validation'
  | 'testing'
  | 'release'
  | 'contribution';

/** All known protocol phases (for iteration in tests). */
export const ALL_SPAWN_PROTOCOL_PHASES: readonly SpawnProtocolPhase[] = [
  'research',
  'consensus',
  'architecture_decision',
  'specification',
  'decomposition',
  'implementation',
  'validation',
  'testing',
  'release',
  'contribution',
] as const;

/**
 * Input to {@link buildSpawnPrompt}.
 *
 * Absolute paths (manifest, rcasd dir, test-runs dir) are resolved by the
 * caller against the orchestrator's project root so the subagent never has
 * to guess. The session id is threaded from `session.status` so the subagent
 * logs every mutation against the orchestrator's active session.
 */
export interface BuildSpawnPromptInput {
  /** Full task record as loaded from the store. */
  task: Task;
  /** Dispatched protocol phase (auto-selected or overridden). */
  protocol: SpawnProtocolPhase | string;
  /** Tier 0/1/2 — defaults to {@link DEFAULT_SPAWN_TIER}. */
  tier?: SpawnTier;
  /** Absolute project root. */
  projectRoot: string;
  /** Orchestrator's active session id, if known. */
  sessionId?: string | null;
  /** Current date (ISO yyyy-mm-dd). Defaults to today. */
  date?: string;
}

/**
 * Output of {@link buildSpawnPrompt}.
 *
 * `prompt` is the fully-resolved text. `unresolvedTokens` is non-empty only
 * if a `{{TOKEN}}` or `@missing.md` reference could not be resolved — callers
 * should surface this as a validation error so no unresolved prompt ships.
 */
export interface BuildSpawnPromptResult {
  prompt: string;
  tier: SpawnTier;
  protocol: string;
  unresolvedTokens: string[];
  /** Token kv map used to resolve the prompt (for diagnostics/tests). */
  tokens: Record<string, string>;
}

// ============================================================================
// Template content loaders (with memoization)
// ============================================================================

interface TemplateCache {
  cleoInjection: string | null;
  ctCleoExcerpt: string | null;
  ctOrchestratorExcerpt: string | null;
  subagentProtocolBlock: string | null;
}

const CACHE: TemplateCache = {
  cleoInjection: null,
  ctCleoExcerpt: null,
  ctOrchestratorExcerpt: null,
  subagentProtocolBlock: null,
};

/**
 * Reset the template content cache.
 *
 * Intended for tests — every production call uses the memoized content so
 * that tier 2 prompt assembly does not re-read the filesystem per call.
 */
export function resetSpawnPromptCache(): void {
  CACHE.cleoInjection = null;
  CACHE.ctCleoExcerpt = null;
  CACHE.ctOrchestratorExcerpt = null;
  CACHE.subagentProtocolBlock = null;
}

/**
 * Load CLEO-INJECTION.md template content from the @cleocode/core package.
 *
 * Primary location is `packages/core/templates/CLEO-INJECTION.md` (source of
 * truth for the monorepo). If not found the function returns `null` — callers
 * should degrade gracefully rather than throwing, so that a stale worktree
 * does not break spawn prompt generation.
 */
function loadCleoInjection(): string | null {
  if (CACHE.cleoInjection !== null) return CACHE.cleoInjection;
  try {
    const templatePath = locateCleoInjectionTemplate();
    if (templatePath) {
      CACHE.cleoInjection = readFileSync(templatePath, 'utf-8');
      return CACHE.cleoInjection;
    }
  } catch {
    // fall-through
  }
  return null;
}

/**
 * Load an excerpt from a skill's SKILL.md file.
 *
 * Excerpts are trimmed to the first N characters so that tier 2 prompts do
 * not balloon. If the skill is not found (CAAMP not installed, filesystem
 * error) returns `null` and the caller omits the excerpt.
 */
function loadSkillExcerpt(skillName: string, maxChars: number, projectRoot: string): string | null {
  const skillDir = resolveSkillPath(skillName, projectRoot);
  if (!skillDir) return null;
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) return null;
  try {
    const content = readFileSync(skillFile, 'utf-8');
    if (content.length <= maxChars) return content;
    // Truncate at a newline boundary for readability.
    const sliced = content.slice(0, maxChars);
    const lastNewline = sliced.lastIndexOf('\n');
    return lastNewline > 0
      ? `${sliced.slice(0, lastNewline)}\n\n> [excerpt — full skill at ${skillFile}]`
      : `${sliced}\n\n> [excerpt — full skill at ${skillFile}]`;
  } catch {
    return null;
  }
}

/**
 * Load SUBAGENT-PROTOCOL-BLOCK.md from the ct-orchestrator skill.
 *
 * Used by tier 2 prompts so subagents see the exact return-format contract
 * alongside the spawn prompt. If the skill is missing the function returns
 * `null` and the caller falls back to the inlined `returnFormatBlock`.
 */
function loadSubagentProtocolBlock(projectRoot: string): string | null {
  if (CACHE.subagentProtocolBlock !== null) return CACHE.subagentProtocolBlock;
  const skillDir = resolveSkillPath('ct-orchestrator', projectRoot);
  if (!skillDir) return null;
  const blockPath = join(skillDir, 'references', 'SUBAGENT-PROTOCOL-BLOCK.md');
  if (!existsSync(blockPath)) return null;
  try {
    CACHE.subagentProtocolBlock = readFileSync(blockPath, 'utf-8');
    return CACHE.subagentProtocolBlock;
  } catch {
    return null;
  }
}

// ============================================================================
// Section builders
// ============================================================================

/** Build the header block — identity banner + tier + protocol. */
function buildHeader(task: Task, protocol: string, tier: SpawnTier): string {
  return [
    `# CLEO Subagent Spawn — ${task.id}`,
    '',
    `> **Task**: ${task.id} · **Protocol**: ${protocol} · **Tier**: ${tier} · **Generated**: ${new Date().toISOString()}`,
    '',
    'You are a CLEO subagent. This prompt is fully self-contained. You do not need to re-resolve any protocol content — everything required to execute, verify, and close this task is embedded below.',
    '',
    'Return ONLY the one-line completion message specified in the **Return Format Contract** section. Do NOT summarize work in the response body.',
    '',
  ].join('\n');
}

/** Build the task identity block — id, title, description, epic, size, priority, labels, acceptance, deps. */
function buildTaskIdentity(task: Task): string {
  const lines: string[] = [
    '## Task Identity',
    '',
    `- **ID**: \`${task.id}\``,
    `- **Title**: ${task.title}`,
  ];
  if (task.description) lines.push(`- **Description**: ${task.description}`);
  lines.push(`- **Type**: ${task.type ?? 'task'}`);
  lines.push(`- **Size**: ${task.size ?? 'medium'}`);
  lines.push(`- **Priority**: ${task.priority ?? 'medium'}`);
  lines.push(`- **Status**: ${task.status}`);
  if (task.parentId) lines.push(`- **Parent Epic**: \`${task.parentId}\``);
  if (task.pipelineStage) lines.push(`- **Pipeline Stage**: ${task.pipelineStage}`);
  if (task.labels?.length) lines.push(`- **Labels**: ${task.labels.join(', ')}`);
  if (task.depends?.length) lines.push(`- **Depends On**: ${task.depends.join(', ')}`);
  lines.push('');

  if (task.acceptance?.length) {
    lines.push('### Acceptance Criteria');
    lines.push('');
    for (const item of task.acceptance) {
      if (typeof item === 'string') {
        lines.push(`- ${item}`);
      } else {
        // Structured AcceptanceGate — render req id (if any) + kind + description
        const kind = item.kind;
        const reqId = item.req ? `\`${item.req}\` · ` : '';
        const desc = item.description ?? '';
        lines.push(`- [${reqId}${kind}] ${desc}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build stage-specific guidance.
 *
 * Each protocol phase maps to a concrete set of actions, output locations,
 * and success criteria. The contents are inlined so the subagent does not
 * need to re-read SKILL.md at runtime.
 */
function buildStageGuidance(protocol: string, rcasdDir: string, outputDir: string): string {
  const guidance: Record<string, string> = {
    research: [
      '## Stage-Specific Guidance — Research (RCASD)',
      '',
      '**Objective**: Gather information and evidence. Do NOT implement. Do NOT make architectural decisions.',
      '',
      'Deliverables:',
      `- Research document at \`${rcasdDir}/research/<topic-slug>.md\``,
      '- Cite ALL sources (files, URLs, memory IDs) with absolute paths or full URLs',
      '- Summarize findings in a top-level **Key Findings** bullet list (3–7 items)',
      '- Flag open questions in a **Needs Follow-up** bullet list',
      '',
      'Tools to use:',
      '- `cleo memory find "<query>"` — prior observations/decisions',
      '- `cleo nexus context <symbol>` — code context (if applicable)',
      '- `Grep`/`Glob` for codebase traversal',
      '- `WebFetch`/`WebSearch` for external sources',
    ].join('\n'),
    consensus: [
      '## Stage-Specific Guidance — Consensus (RCASD)',
      '',
      '**Objective**: Validate approach. Challenge claims. Vote on options.',
      '',
      'Deliverables:',
      `- Consensus document at \`${rcasdDir}/consensus/<topic-slug>.md\``,
      '- Explicit vote: APPROVE / REJECT / ABSTAIN with rationale',
      '- Risk register: 3–5 items, ranked',
      '- Alternatives considered and why rejected',
    ].join('\n'),
    architecture_decision: [
      '## Stage-Specific Guidance — Architecture Decision (RCASD)',
      '',
      '**Objective**: Write an ADR. Pick a pattern. Define integration points.',
      '',
      'Deliverables:',
      `- ADR at \`.cleo/adrs/ADR-<NNN>-<slug>.md\` (next unused number)`,
      '- Structure: Context → Decision → Consequences → Alternatives',
      '- Reference all contracts/interfaces touched (absolute paths)',
      '- Link back to the epic task id in the ADR front-matter',
    ].join('\n'),
    specification: [
      '## Stage-Specific Guidance — Specification (RCASD)',
      '',
      '**Objective**: Write an RFC-2119-compliant specification.',
      '',
      'Deliverables:',
      `- Spec document at \`${rcasdDir}/specification/<topic-slug>-spec.md\``,
      '- Use MUST / MUST NOT / SHOULD / MAY consistently',
      '- Include: contracts, data shapes, error codes, acceptance criteria',
      '- Every acceptance criterion MUST be programmatically verifiable',
    ].join('\n'),
    decomposition: [
      '## Stage-Specific Guidance — Decomposition (RCASD)',
      '',
      '**Objective**: Break the epic into atomic child tasks with deps.',
      '',
      'Deliverables:',
      '- Atomic tasks added via `cleo add "<title>" --type task --parent <epicId>`',
      '- Each task has: pipe-separated `--acceptance` criteria, `--size`, `--priority`',
      '- Dependencies wired via `cleo update <id> --depends <otherId>`',
      `- Decomposition summary at \`${rcasdDir}/decomposition/<epic-slug>-plan.md\``,
    ].join('\n'),
    implementation: [
      '## Stage-Specific Guidance — Implementation (IVTR)',
      '',
      '**Objective**: Write code that satisfies every acceptance criterion.',
      '',
      'Deliverables:',
      '- Source changes under `packages/<pkg>/src/`',
      '- Tests under `packages/<pkg>/src/**/__tests__/*.test.ts` (vitest)',
      '- TSDoc comments on every exported function/class/type',
      '- Commit atomically (one feature/fix per commit) with conventional commit messages',
      '',
      'Quality Bar:',
      '- NEVER `any` or `unknown` shortcuts — see `@~/.agents/AGENTS.md` code-quality rules',
      '- Import types from `@cleocode/contracts` — never inline/mock',
      '- `pnpm biome check --write .` must show no warnings',
      '- `pnpm run build` must succeed (full dep graph)',
      '- `pnpm run test` must show zero new failures',
    ].join('\n'),
    validation: [
      '## Stage-Specific Guidance — Validation (IVTR)',
      '',
      '**Objective**: Verify implementation against spec + ADRs + contracts.',
      '',
      'Deliverables:',
      `- Validation report at \`${outputDir}/<taskId>-validation.md\``,
      '- Run `cleo verify <id> --run` and capture output',
      '- Cross-check every acceptance criterion vs the diff (`git diff --stat HEAD`)',
      '- If any criterion fails, mark status `blocked` with a concrete fix plan',
    ].join('\n'),
    testing: [
      '## Stage-Specific Guidance — Testing (IVTR)',
      '',
      '**Objective**: Prove behavior via tests. Zero-regression mandate.',
      '',
      'Deliverables:',
      '- Unit tests for every new code path (vitest `describe`/`it` blocks)',
      '- Integration tests under `packages/<pkg>/src/**/__tests__/*.test.ts`',
      `- Vitest JSON output captured at \`${outputDir}/<taskId>-vitest.json\``,
      '- Evidence atom: `tool:pnpm-test` or `test-run:<vitest-json-path>`',
    ].join('\n'),
    release: [
      '## Stage-Specific Guidance — Release (IVTR)',
      '',
      '**Objective**: Version, changelog, tag, publish. No partial releases.',
      '',
      'Deliverables:',
      '- Bump monorepo + package versions (CalVer YYYY.MM.patch)',
      '- CHANGELOG.md entry under the new version',
      '- Tag via `git tag v<version>` and push with `--tags`',
      '- CI must be GREEN before `npm publish` (`cleo release ship`)',
      '- Do NOT force-push or bypass hooks',
    ].join('\n'),
    contribution: [
      '## Stage-Specific Guidance — Contribution (Cross-cutting)',
      '',
      '**Objective**: Track attribution and discovered follow-ups.',
      '',
      'Deliverables:',
      '- Append manifest entry with `needs_followup: [taskId, …]` for every gap found',
      '- Link to upstream PR/issue when applicable (`cleo docs add <taskId> --url`)',
      '- Credit Co-Authored-By if paired with another agent',
    ].join('\n'),
  };
  return guidance[protocol] ?? guidance['implementation'] ?? '';
}

/** Build the evidence-based gate block (T832 / ADR-051). */
function buildEvidenceGateBlock(taskId: string): string {
  return [
    '## Evidence-Based Gate Ritual (MANDATORY · ADR-051 · T832)',
    '',
    'Every gate write MUST carry programmatic evidence. CLEO validates evidence against git, the filesystem, and the toolchain. `cleo verify --all` without `--evidence` is REJECTED with `E_EVIDENCE_MISSING`.',
    '',
    '### Step 1 — capture evidence per gate',
    '',
    '```bash',
    '# implemented — commit + file list',
    `cleo verify ${taskId} --gate implemented \\`,
    '  --evidence "commit:$(git rev-parse HEAD);files:<comma-separated-paths>"',
    '',
    '# testsPassed — tool run or vitest json',
    `cleo verify ${taskId} --gate testsPassed --evidence "tool:pnpm-test"`,
    '#  OR',
    `cleo verify ${taskId} --gate testsPassed --evidence "test-run:/tmp/vitest-out.json"`,
    '',
    '# qaPassed — biome + tsc exit 0',
    `cleo verify ${taskId} --gate qaPassed --evidence "tool:biome;tool:tsc"`,
    '',
    '# documented — docs path',
    `cleo verify ${taskId} --gate documented --evidence "files:docs/<path>.md"`,
    '',
    '# cleanupDone — summary note',
    `cleo verify ${taskId} --gate cleanupDone --evidence "note:<summary>"`,
    '',
    '# securityPassed — scan or waiver',
    `cleo verify ${taskId} --gate securityPassed --evidence "tool:security-scan"`,
    '#  OR',
    `cleo verify ${taskId} --gate securityPassed --evidence "note:no network surface"`,
    '```',
    '',
    '### Step 2 — then complete',
    '',
    '```bash',
    `cleo memory observe "<concise learning>" --title "<title>"`,
    `cleo complete ${taskId}`,
    '```',
    '',
    'On `complete`, CLEO re-validates every hard atom (commit reachable, file sha256, test-run hash). Tampering → `E_EVIDENCE_STALE` — re-run verify with updated evidence.',
    '',
    '**Forbidden**: `cleo complete --force` (REMOVED per ADR-051). `cleo verify --all` without `--evidence` (REJECTED). `note:` as the only atom on `implemented` or `testsPassed` (INSUFFICIENT).',
  ].join('\n');
}

/** Build the quality-gate block — biome + build + test. */
function buildQualityGateBlock(): string {
  return [
    '## Quality Gates (run before every `cleo complete`)',
    '',
    '```bash',
    'pnpm biome ci .        # full repo, strict — same as CI',
    'pnpm run build         # full dep graph build',
    'pnpm run test          # zero new failures vs main',
    'git diff --stat HEAD   # verify the diff matches the story',
    '```',
    '',
    'If ANY gate fails, fix it before completing. Do not bypass. Do not `--no-verify`. Do not amend published commits.',
  ].join('\n');
}

/** Build the return-format contract — exact strings the subagent may return. */
function buildReturnFormatBlock(protocol: string): string {
  const type =
    protocol === 'research'
      ? 'Research'
      : protocol === 'consensus'
        ? 'Consensus'
        : protocol === 'specification'
          ? 'Specification'
          : protocol === 'decomposition'
            ? 'Decomposition'
            : protocol === 'architecture_decision'
              ? 'ADR'
              : protocol === 'validation'
                ? 'Validation'
                : protocol === 'testing'
                  ? 'Testing'
                  : protocol === 'release'
                    ? 'Release'
                    : protocol === 'contribution'
                      ? 'Contribution'
                      : 'Implementation';
  return [
    '## Return Format Contract (MANDATORY)',
    '',
    'On completion, return EXACTLY ONE of these strings and nothing else:',
    '',
    '```',
    `${type} complete. See MANIFEST.jsonl for summary.`,
    `${type} partial. See MANIFEST.jsonl for details.`,
    `${type} blocked. See MANIFEST.jsonl for blocker details.`,
    '```',
    '',
    'Do NOT include the actual findings or code diffs in the response. Everything that matters goes to:',
    '',
    '1. The output file in the **File Paths** section',
    '2. The pipeline manifest (via `cleo` or `mutate pipeline.manifest.append`)',
    '3. The task record itself (gates, status, notes)',
  ].join('\n');
}

/** Build the file-paths block — absolute paths the subagent MUST use. */
function buildFilePathsBlock(
  taskId: string,
  outputDir: string,
  manifestPath: string,
  rcasdDir: string,
  testRunsDir: string,
): string {
  return [
    '## File Paths (absolute — do not guess)',
    '',
    '| Purpose | Absolute Path |',
    '|---------|---------------|',
    `| Agent output directory | \`${outputDir}\` |`,
    `| Manifest (JSONL) | \`${manifestPath}\` |`,
    `| RCASD workspace (${taskId}) | \`${rcasdDir}\` |`,
    `| Test-run captures | \`${testRunsDir}\` |`,
  ].join('\n');
}

/** Build the session-linkage block — thread orchestrator session id to subagent. */
function buildSessionBlock(sessionId: string | null | undefined): string {
  if (!sessionId) {
    return [
      '## Session Linkage',
      '',
      'No active orchestrator session was found at spawn time. Before running any mutation, start one with:',
      '',
      '```bash',
      'cleo session start --scope global --name "<descriptive name>"',
      '```',
    ].join('\n');
  }
  return [
    '## Session Linkage',
    '',
    `- **Orchestrator Session**: \`${sessionId}\``,
    '- Log every mutation (task start/complete, memory observe, verify) against THIS session. Do not start a new one unless explicitly told.',
    '- If the session has ended by the time you run, the orchestrator will hand you a new one via `cleo orchestrate handoff`.',
  ].join('\n');
}

/** Build the tier 0 protocol pointer — one-liner pointing at the canonical template. */
function buildTier0ProtocolPointer(): string {
  return [
    '## CLEO Protocol (tier 0 reference)',
    '',
    'Full protocol reference: `~/.cleo/templates/CLEO-INJECTION.md` (global) or `packages/core/templates/CLEO-INJECTION.md` (source).',
    '',
    'Cheapest-first discovery: `cleo session status` → `cleo dash` → `cleo current` → `cleo next` → `cleo show <id>`.',
  ].join('\n');
}

/** Build the tier 1 CLEO-INJECTION embed. */
function buildTier1InjectionEmbed(): string {
  const content = loadCleoInjection();
  if (!content) {
    return [
      '## CLEO Protocol (embedded)',
      '',
      '> WARNING: CLEO-INJECTION.md template not found at spawn time.',
      'Fall back to `cleo admin help --tier 1` for the current operation set.',
    ].join('\n');
  }
  return [
    '## CLEO Protocol (embedded — tier 1)',
    '',
    '<details><summary>Click to expand full protocol</summary>',
    '',
    content,
    '',
    '</details>',
  ].join('\n');
}

/** Build the tier 2 skill excerpts — ct-cleo + ct-orchestrator. */
function buildTier2SkillExcerpts(projectRoot: string): string {
  const ctCleo = loadSkillExcerpt('ct-cleo', 6000, projectRoot);
  const ctOrch = loadSkillExcerpt('ct-orchestrator', 6000, projectRoot);
  const block = loadSubagentProtocolBlock(projectRoot);

  const parts: string[] = ['## Skill Excerpts (tier 2)', ''];
  if (ctCleo) {
    parts.push('### ct-cleo (CLEO protocol guide)');
    parts.push('');
    parts.push(ctCleo);
    parts.push('');
  }
  if (ctOrch) {
    parts.push('### ct-orchestrator (multi-agent coordination)');
    parts.push('');
    parts.push(ctOrch);
    parts.push('');
  }
  if (block) {
    parts.push('### Subagent Protocol Block (return-format spec)');
    parts.push('');
    parts.push(block);
    parts.push('');
  }
  if (parts.length === 2) {
    parts.push(
      '> Skills not installed in this environment. Run `cleo skill install ct-cleo` and `cleo skill install ct-orchestrator` for offline tier-2 prompts.',
    );
  }
  return parts.join('\n');
}

/** Build the anti-pattern reference. */
function buildAntiPatternBlock(): string {
  return [
    '## Anti-Patterns (instant rejection)',
    '',
    '- Returning content in the response body (bloats orchestrator context — write to file, return one-line summary).',
    '- Editing files between `cleo verify` and `cleo complete` (caught by `E_EVIDENCE_STALE`).',
    '- Passing `note:` alone as evidence for `implemented` / `testsPassed` (rejected as `E_EVIDENCE_INSUFFICIENT`).',
    '- Skipping `cleo session status` at spawn (loses prior context, duplicates work).',
    '- Running `cleo list` without `--parent` (returns full tree — use `cleo find` for discovery).',
    '- `as any` or `as unknown as X` type casts (project rule, see `@~/.agents/AGENTS.md`).',
    '- Committing `.cleo/tasks.db` or `.cleo/brain.db` (git-ignored — see ADR-013).',
  ].join('\n');
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Build a fully-resolved, self-contained spawn prompt.
 *
 * The returned prompt is copy-pastable into any LLM runtime and contains
 * everything the subagent needs to execute, verify, and close the task
 * without re-resolving protocol content.
 *
 * @see {@link BuildSpawnPromptInput} for input shape.
 * @see {@link BuildSpawnPromptResult} for output shape including unresolved-token diagnostics.
 */
export function buildSpawnPrompt(input: BuildSpawnPromptInput): BuildSpawnPromptResult {
  const tier: SpawnTier = input.tier ?? DEFAULT_SPAWN_TIER;
  const date = input.date ?? new Date().toISOString().split('T')[0] ?? '';
  const taskId = input.task.id;
  const epicId = input.task.parentId ?? '';
  const protocol = input.protocol;

  // Absolute paths resolved against the orchestrator's project root.
  const outputDir = join(input.projectRoot, '.cleo', 'agent-outputs');
  const manifestPath = join(outputDir, 'MANIFEST.jsonl');
  const rcasdDir = join(input.projectRoot, '.cleo', 'rcasd', taskId);
  const testRunsDir = join(input.projectRoot, '.cleo', 'test-runs');

  const tokens: Record<string, string> = {
    TASK_ID: taskId,
    DATE: date,
    EPIC_ID: epicId,
    OUTPUT_DIR: outputDir,
    MANIFEST_PATH: manifestPath,
    RCASD_DIR: rcasdDir,
    TEST_RUNS_DIR: testRunsDir,
    PROJECT_ROOT: input.projectRoot,
    SESSION_ID: input.sessionId ?? '',
    PROTOCOL: protocol,
    TIER: String(tier),
    TOPIC_SLUG: slugify(input.task.title),
  };

  // ── Section assembly ──────────────────────────────────────────────────
  //
  // Two-pass assembly: authored sections (which contain `{{TOKEN}}` markers
  // the builder actually wants resolved) are rendered first and token-
  // substituted. Embedded content (CLEO-INJECTION.md excerpt, skill SKILL.md
  // excerpts) is appended verbatim — those files may contain `{{TOKEN}}`
  // examples in their documentation, and flagging those as unresolved would
  // falsely fail validation.
  const authoredSections: string[] = [];
  const embeddedSections: string[] = [];

  authoredSections.push(buildHeader(input.task, protocol, tier));
  authoredSections.push(buildTaskIdentity(input.task));
  authoredSections.push(
    buildFilePathsBlock(taskId, outputDir, manifestPath, rcasdDir, testRunsDir),
  );
  authoredSections.push(buildSessionBlock(input.sessionId));
  authoredSections.push(buildStageGuidance(protocol, rcasdDir, outputDir));
  authoredSections.push(buildEvidenceGateBlock(taskId));
  authoredSections.push(buildQualityGateBlock());
  authoredSections.push(buildReturnFormatBlock(protocol));

  // Tier-specific content — tier 0 pointer is authored; tier 1/2 embeds
  // are verbatim and therefore land in `embeddedSections`.
  if (tier === 0) {
    authoredSections.push(buildTier0ProtocolPointer());
  } else if (tier === 1) {
    embeddedSections.push(buildTier1InjectionEmbed());
  } else {
    // tier 2
    embeddedSections.push(buildTier1InjectionEmbed());
    embeddedSections.push(buildTier2SkillExcerpts(input.projectRoot));
    // The anti-patterns block is authored by us, so keep its tokens subject
    // to resolution (currently there are none — but structurally it belongs
    // with authored content).
    authoredSections.push(buildAntiPatternBlock());
  }

  const authored = authoredSections.join('\n\n');
  const { resolved, unresolved } = resolvePromptTokens(authored, tokens);

  const embedded = embeddedSections.join('\n\n');
  const finalPrompt = embedded ? `${resolved}\n\n${embedded}` : resolved;

  return {
    prompt: finalPrompt,
    tier,
    protocol,
    unresolvedTokens: unresolved,
    tokens,
  };
}

/**
 * Resolve `{{TOKEN}}` placeholders in a prompt string.
 *
 * Unknown tokens are left as-is and reported via `unresolved`. `@path.md`
 * references are checked separately — if the file exists on disk the
 * reference is considered resolved; otherwise it is reported.
 *
 * Exported for reuse and testing.
 */
export function resolvePromptTokens(
  prompt: string,
  context: Record<string, string>,
): { resolved: string; unresolved: string[] } {
  const unresolved: string[] = [];

  // {{TOKEN}} substitution
  const resolved = prompt.replace(/\{\{([A-Z_]+)\}\}/g, (full, token: string) => {
    if (context[token] !== undefined) return context[token] ?? '';
    unresolved.push(token);
    return full;
  });

  // @path.md file references — verify existence
  const refRegex = /@([a-zA-Z0-9_./~-]+\.md)/g;
  for (const match of resolved.matchAll(refRegex)) {
    const ref = match[1];
    if (!ref) continue;
    // Reserved references that are valid template placeholders — do not flag
    if (ref.startsWith('~/') || ref.startsWith('./') || ref.startsWith('../')) continue;
    // We don't have cwd context here to resolve relative paths; keep conservative
    // and do not flag relative refs. Only flag absolute refs that are clearly
    // missing.
    if (ref.startsWith('/') && !existsSync(ref)) {
      unresolved.push(`@${ref}`);
    }
  }

  return { resolved, unresolved };
}

/**
 * Slugify a title into a URL-safe topic slug.
 * Exported for reuse by the orchestrate engine (spawn filename generation).
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}
