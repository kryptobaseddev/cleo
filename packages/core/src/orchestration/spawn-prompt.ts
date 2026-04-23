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
 * CONDUIT subscription configuration injected into tier-1 / tier-2 spawn prompts.
 *
 * When present, the spawn prompt includes a `## CONDUIT Subscription` section
 * that names the wave topic and coordination topic the agent should subscribe to.
 *
 * @see T1252 CONDUIT A2A
 */
export interface ConduitSubscriptionConfig {
  /** Parent epic ID, e.g. `"T1149"`. */
  epicId: string;
  /** Wave number (integer), e.g. `2`. */
  waveId: number;
  /** Spawned agent peer ID, e.g. `"cleo-lead-2"`. */
  peerId: string;
}

/**
 * Input to {@link buildSpawnPrompt}.
 *
 * Absolute paths (rcasd dir, test-runs dir, output dir) are resolved by the
 * caller against the orchestrator's project root so the subagent never has
 * to guess. Manifest storage is SQLite (`pipeline_manifest`) — not a file
 * path (ADR-027 §6.2, T1096). The session id is threaded from `session.status` so the subagent
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
  /**
   * Harness context the prompt is being rendered for.
   *
   * Purely informational inside this builder — the active
   * {@link BuildSpawnPromptInput.skipCleoInjectionEmbed} flag is what
   * actually gates the embed. The harness hint is recorded so callers can
   * surface it in telemetry / manifest envelopes.
   *
   * @task T889 / T893 / W3-2
   */
  harnessHint?: 'claude-code' | 'generic' | 'bare';
  /**
   * When `true`, the tier-1 / tier-2 CLEO-INJECTION.md embed is replaced
   * with a one-line pointer back to the canonical template path. Keeps the
   * prompt self-contained for bare/generic harnesses while letting
   * Claude-Code harnesses (which auto-load the injection via `AGENTS.md`)
   * skip the ~9KB duplicate.
   *
   * @task T889 / T893 / W3-2
   */
  skipCleoInjectionEmbed?: boolean;
  /**
   * Absolute path to the pre-provisioned worktree for this task.
   *
   * When provided, a `## Worktree Setup (REQUIRED)` section is emitted in
   * the prompt body that names the worktree path, the branch, and the
   * context-isolation constraint. When absent (e.g. `--no-worktree` was
   * passed at spawn time), the section is omitted entirely.
   *
   * The path is also injected as `{{ worktreePath }}` into the token map so
   * stage-guidance templates can reference it without hard-coding.
   *
   * @task T1140 — worktree-by-default spawn prompt
   */
  worktreePath?: string;
  /**
   * Git branch name for the worktree (e.g. `task/T1234`).
   *
   * Only used when {@link worktreePath} is set. Defaults to `task/<taskId>`.
   *
   * @task T1140
   */
  worktreeBranch?: string;
  /**
   * CONDUIT A2A subscription configuration.
   *
   * When provided, a `## CONDUIT Subscription` section is injected into
   * tier-1 and tier-2 prompts, giving the spawned agent its wave topic and
   * coordination topic. Omitted for tier-0 prompts (minimal content) and
   * when not set.
   *
   * @task T1252 CONDUIT A2A
   */
  conduitSubscription?: ConduitSubscriptionConfig;
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

/**
 * Build the `## Worktree Setup (REQUIRED)` section for worker-tier prompts.
 *
 * Emitted when the orchestrate engine has pre-provisioned a git worktree for
 * the task (worktree-by-default per T1140 / ADR-055). The section:
 *
 * - Names the worktree absolute path and branch.
 * - States the context-isolation constraint so the agent knows it is
 *   authorized only within the worktree boundary.
 * - Provides the `FIRST ACTION` directive so the agent initializes its cwd.
 *
 * When `--no-worktree` is passed at spawn time this function is not called
 * and the section is absent. Agents that encounter a prompt without this
 * section may still run on the primary worktree (backward compat).
 *
 * @param worktreePath   - Absolute path to the provisioned worktree.
 * @param worktreeBranch - Branch name (e.g. `task/T1234`).
 * @param taskId         - Task ID for context-isolation text.
 *
 * @task T1140 — worktree-by-default spawn prompt
 */
function buildWorktreeSetupBlock(
  worktreePath: string,
  worktreeBranch: string,
  taskId: string,
): string {
  return [
    '## Worktree Setup (REQUIRED)',
    '',
    `> You are authorized only within \`${worktreePath}\`.`,
    '> All reads, writes, and git operations MUST occur inside this boundary.',
    '',
    `- **Worktree path**: \`${worktreePath}\``,
    `- **Branch**: \`${worktreeBranch}\``,
    `- **Task**: \`${taskId}\``,
    '',
    `**FIRST ACTION**: \`cd ${worktreePath}\``,
    '',
    'You MUST NOT run any of these git commands (a shim on your PATH will exit 77 if you try):',
    '',
    '```',
    'git checkout, git switch, git branch -b/-D, git reset --hard,',
    'git worktree add/remove, git rebase, git stash pop, git push --force',
    '```',
    '',
    'All commits MUST land on YOUR branch only. Cherry-pick to main is handled by the orchestrator.',
  ].join('\n');
}

/** Build the header block — identity banner + tier + protocol. Kept short so
 * the Task section lands in the first 500 chars of the prompt (W3-4 hoist).
 */
function buildHeader(task: Task, protocol: string, tier: SpawnTier): string {
  return [
    `# CLEO Subagent Spawn — ${task.id}`,
    '',
    `> **Task**: ${task.id} · **Protocol**: ${protocol} · **Tier**: ${tier} · **Generated**: ${new Date().toISOString()}`,
    '',
    'Self-contained spawn prompt. Return ONLY the one-line message from **Return Format Contract**.',
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
    `${type} complete. Manifest appended to pipeline_manifest.`,
    `${type} partial. Manifest appended to pipeline_manifest.`,
    `${type} blocked. Manifest appended to pipeline_manifest.`,
    '```',
    '',
    'Do NOT include the actual findings or code diffs in the response. Everything that matters goes to:',
    '',
    '1. The `pipeline_manifest` table via `cleo manifest append` (see **Manifest Protocol** below)',
    '2. The task record itself (gates, status, notes)',
    '3. Files committed to your branch',
  ].join('\n');
}

/**
 * Build the Manifest Protocol block — instructs the subagent to append the
 * completion record to `pipeline_manifest` via `cleo manifest append`.
 *
 * Retired: flat-file manifest append pattern (ADR-027 §6.2, T1096). Replaced by
 * the unified `cleo manifest` CLI dispatching to `pipeline.manifest.*` with
 * SQLite as the single source of truth (no concurrent-append race).
 *
 * @param taskId   - Task the subagent is working on.
 * @param protocol - Protocol phase (maps to the `type` column).
 * @returns Markdown block ready to concatenate into the spawn prompt.
 */
function buildManifestProtocolBlock(taskId: string, protocol: SpawnProtocolPhase | string): string {
  const entryType =
    protocol === 'implementation'
      ? 'implementation'
      : protocol === 'research'
        ? 'research'
        : protocol === 'decomposition'
          ? 'decomposition'
          : protocol === 'validation'
            ? 'validation'
            : protocol === 'testing'
              ? 'testing'
              : protocol === 'release'
                ? 'release'
                : protocol === 'contribution'
                  ? 'contribution'
                  : 'implementation';
  return [
    '## Manifest Protocol (MANDATORY · ADR-027 · T1096)',
    '',
    'Before returning, append a manifest entry to the `pipeline_manifest` table',
    '(SQLite-backed, single source of truth). Do NOT write to any `.jsonl` file',
    'under `.cleo/agent-outputs/` — flat-file manifests were retired because',
    'concurrent appends under parallel-wave orchestration lost entries.',
    '',
    '### Step 1 — Append (shorthand — RECOMMENDED for subagents)',
    '',
    'The CLI fills `id` / `file` / `title` / `date` / `topics` / defaults for you.',
    '',
    '```bash',
    'cleo manifest append \\',
    `  --task ${taskId} \\`,
    `  --type ${entryType} \\`,
    '  --content "<one-paragraph summary: what shipped, commits, gates>" \\',
    '  --status completed     # or partial | blocked',
    '```',
    '',
    '### Step 1 (alternative) — Rich entry (full schema — optional)',
    '',
    'Use the full entry when you need `confidence`, `file_checksum`,',
    'extra `key_findings`, `needs_followup`, or multiple `linked_tasks`.',
    'The `pipeline_manifest` validator REJECTS entries missing any required',
    'field — this is the exact accepted shape:',
    '',
    '```bash',
    "cleo manifest append --entry '{",
    `  "id": "${taskId}-${entryType}-<YYYYMMDDHHMMSS>",`,
    `  "file": ".cleo/agent-outputs/${taskId}-${entryType}.md",`,
    '  "title": "<short headline — max 120 chars>",',
    '  "date": "<YYYY-MM-DD>",',
    '  "status": "completed",',
    `  "agent_type": "${entryType}",`,
    `  "topics": ["${taskId}", "${entryType}"],`,
    '  "key_findings": ["<bullet 1>", "<bullet 2>"],',
    '  "actionable": false,',
    '  "needs_followup": [],',
    `  "linked_tasks": ["${taskId}"],`,
    '  "confidence": 0.9,',
    '  "file_checksum": "sha256:...",',
    '  "duration_seconds": 120',
    "}'",
    '```',
    '',
    'Required fields (validator enforces these — missing any → `E_VALIDATION_FAILED`):',
    '`id`, `file`, `title`, `date`, `status`, `agent_type`, `topics`, `actionable`.',
    'Optional: `confidence`, `file_checksum`, `duration_seconds`.',
    'Do NOT use fields like `task_id`, `type`, `content`, `commits`, `gates_passed`,',
    '`files_changed`, `children_completed` in the JSON — those are not in the schema.',
    'Task association is via `linked_tasks[]` (first element becomes the DB task_id).',
    '',
    '### Step 2 — Verify BEFORE returning (MANDATORY)',
    '',
    'The CLI prints `{"success":true,"data":{"appended":true,"entryId":"..."}}` on',
    'success, OR `{"success":false,"error":{"code":"E_VALIDATION_FAILED",...}}` on',
    'failure. Agents MUST assert the success path before emitting the return string',
    '— hallucinating "Manifest appended" is a protocol violation.',
    '',
    '```bash',
    'APPEND_OUT=$(cleo manifest append --task ' +
      taskId +
      ' --type ' +
      entryType +
      ' --content "...")',
    'echo "$APPEND_OUT" | grep -q \'"appended":true\' || { echo "MANIFEST APPEND FAILED"; exit 1; }',
    'ENTRY_ID=$(echo "$APPEND_OUT" | python3 -c \'import json,sys;print(json.load(sys.stdin)["data"]["entryId"])\')',
    'cleo manifest show "$ENTRY_ID" >/dev/null',
    '```',
    '',
    'The orchestrator retrieves entries via `cleo manifest show <entryId>` or',
    `\`cleo manifest list --task ${taskId}\` (filter matches entries where \`id\``,
    `starts with \`${taskId}\` OR \`linked_tasks\` contains it).`,
  ].join('\n');
}

/**
 * Build the file-paths block — absolute paths the subagent MUST use.
 *
 * @remarks
 * The legacy flat-file manifest row was removed when `pipeline_manifest`
 * (SQLite) became the canonical manifest store (ADR-027 §6.2, T1096). Subagents append
 * manifest entries via `cleo manifest append` — see the Manifest Protocol block
 * rendered alongside this one.
 */
function buildFilePathsBlock(
  taskId: string,
  outputDir: string,
  rcasdDir: string,
  testRunsDir: string,
): string {
  return [
    '## File Paths (absolute — do not guess)',
    '',
    '| Purpose | Absolute Path |',
    '|---------|---------------|',
    `| Agent output directory | \`${outputDir}\` |`,
    `| RCASD workspace (${taskId}) | \`${rcasdDir}\` |`,
    `| Test-run captures | \`${testRunsDir}\` |`,
    '',
    '> Manifest entries are stored in `pipeline_manifest` (tasks.db) and MUST be',
    '> written via `cleo manifest append` (see **Manifest Protocol**). Never',
    '> create a flat `.jsonl` manifest file — the legacy sink was retired (ADR-027).',
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

/**
 * Render a one-line pointer that replaces the tier-1 embed when the calling
 * harness already has `CLEO-INJECTION.md` loaded (see
 * {@link BuildSpawnPromptInput.skipCleoInjectionEmbed}).
 *
 * Saves ~9KB per spawn without losing traceability — the pointer names the
 * canonical source and the AGENTS.md wrapper the harness used.
 *
 * @task T889 / T893 / W3-2
 */
function buildTier1InjectionPointer(): string {
  return [
    '## CLEO Protocol (tier 1 — dedup pointer)',
    '',
    '> Protocol: CLEO-INJECTION.md already loaded via AGENTS.md harness (v2.6.0). See https://github.com/kryptobaseddev/cleocode/blob/main/packages/cleo/AGENTS.md',
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

/**
 * Build the `## CONDUIT Subscription` section for A2A wave coordination.
 *
 * Injected into tier-1 / tier-2 spawn prompts when the orchestrator
 * has configured a wave topic and coordination topic for the task.
 *
 * Follows the pattern established by `buildWorktreeSetupBlock` (T1140):
 * - Names the concrete topic strings so the agent can subscribe immediately.
 * - Provides an SDK usage example (TypeScript).
 *
 * @param config - CONDUIT subscription configuration from the orchestrator.
 * @returns Markdown section ready to concatenate into the spawn prompt.
 *
 * @task T1252 CONDUIT A2A
 */
function buildConduitSubscriptionBlock(config: ConduitSubscriptionConfig): string {
  const { epicId, waveId, peerId } = config;
  const waveTopic = `epic-${epicId}.wave-${waveId}`;
  const coordTopic = `epic-${epicId}.coordination`;

  return [
    '## CONDUIT Subscription (A2A Wave Coordination · T1252)',
    '',
    `> Your peer identity: \`${peerId}\``,
    `> Your wave topic: \`${waveTopic}\``,
    `> Coordination topic: \`${coordTopic}\``,
    '',
    'Subscribe to both topics at startup so you receive wave-completion signals and orchestrator broadcasts.',
    '',
    '### Topics',
    '',
    `**Wave Topic** — \`${waveTopic}\``,
    '- Role: Leads in your wave exchange findings and block/unblock signals.',
    '- Action: Subscribe at spawn; publish findings when work completes.',
    '',
    `**Coordination Topic** — \`${coordTopic}\``,
    '- Role: Orchestrator publishes wave-complete and abort signals.',
    '- Action: Subscribe at spawn; listen for teardown signals.',
    '',
    '### SDK Usage (TypeScript)',
    '',
    '```ts',
    "import { createConduit } from '@cleocode/core';",
    '',
    `const conduit = await createConduit(registry, '${peerId}');`,
    'await conduit.connect();',
    '',
    '// Subscribe to your wave topic and the coordination topic',
    `await conduit.subscribeTopic('${waveTopic}');`,
    `await conduit.subscribeTopic('${coordTopic}');`,
    '',
    '// Listen for peer findings',
    `conduit.onTopic('${waveTopic}', (msg) => {`,
    "  if (msg.kind === 'notify' && msg.payload?.event === 'work-complete') {",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional code example in a string
    '    console.log(`Peer completed: ${msg.fromPeerId}`);',
    '  }',
    '});',
    '',
    '// Listen for orchestrator signals',
    `conduit.onTopic('${coordTopic}', (msg) => {`,
    "  if (msg.kind === 'notify' && msg.payload?.event === 'teardown') {",
    '    // Wave teardown — safe to disconnect',
    '    void conduit.disconnect();',
    '  }',
    '});',
    '',
    '// When your work is done, publish findings',
    `await conduit.publishToTopic('${waveTopic}', 'Work complete', {`,
    "  kind: 'notify',",
    '  payload: {',
    "    event: 'work-complete',",
    `    peerId: '${peerId}',`,
    '    findings: { /* structured output */ },',
    '    completedAt: new Date().toISOString()',
    '  }',
    '});',
    '```',
    '',
    '### CLI Equivalents',
    '',
    '```bash',
    `cleo conduit subscribe --topicName "${waveTopic}"`,
    `cleo conduit subscribe --topicName "${coordTopic}"`,
    `cleo conduit publish --topicName "${waveTopic}" --content "Work complete" --kind notify`,
    `cleo conduit listen --topicName "${waveTopic}"`,
    '```',
  ].join('\n');
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
  //
  // ADR-027 §6.2 / T1096: manifestPath was removed. The `pipeline_manifest`
  // SQLite table is the single source of truth — subagents invoke
  // `cleo manifest append` rather than writing to any flat file.
  const outputDir = join(input.projectRoot, '.cleo', 'agent-outputs');
  const rcasdDir = join(input.projectRoot, '.cleo', 'rcasd', taskId);
  const testRunsDir = join(input.projectRoot, '.cleo', 'test-runs');

  // Worktree path — injected as a token so stage-guidance templates can
  // reference {{ worktreePath }} without hard-coding the directory layout.
  const worktreePath = input.worktreePath ?? '';
  const worktreeBranch = input.worktreeBranch ?? `task/${taskId}`;

  const tokens: Record<string, string> = {
    TASK_ID: taskId,
    DATE: date,
    EPIC_ID: epicId,
    OUTPUT_DIR: outputDir,
    RCASD_DIR: rcasdDir,
    TEST_RUNS_DIR: testRunsDir,
    PROJECT_ROOT: input.projectRoot,
    SESSION_ID: input.sessionId ?? '',
    PROTOCOL: protocol,
    TIER: String(tier),
    TOPIC_SLUG: slugify(input.task.title),
    WORKTREE_PATH: worktreePath,
    WORKTREE_BRANCH: worktreeBranch,
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

  // ── Section order (W3-4 hoist, T894) ─────────────────────────────────
  // The opening ~500 chars MUST carry the task identity + return-format
  // contract — those are what the subagent looks at first. Protocol
  // boilerplate (stage guidance, evidence ritual, quality gates) follows.
  //
  // 1. Header              — short banner (id / protocol / tier)
  // 2. Task Identity       — id, title, description, size, AC
  // 3. Return Format       — contract the subagent must honor on exit
  // 4. Session Linkage     — orchestrator session id
  // 5. Worktree Setup      — pre-provisioned path + context-isolation (T1140)
  // 6. File Paths          — absolute paths
  // 7. Stage Guidance      — phase-specific directives
  // 8. Evidence Gate       — ADR-051 ritual
  // 9. Quality Gates       — biome / build / test
  authoredSections.push(buildHeader(input.task, protocol, tier));
  authoredSections.push(buildTaskIdentity(input.task));
  authoredSections.push(buildReturnFormatBlock(protocol));
  authoredSections.push(buildManifestProtocolBlock(taskId, protocol));
  authoredSections.push(buildSessionBlock(input.sessionId));
  // Worktree Setup (T1140) — only emitted when the engine provisioned one.
  // Omitted when --no-worktree was passed or worktree creation failed.
  if (worktreePath) {
    authoredSections.push(buildWorktreeSetupBlock(worktreePath, worktreeBranch, taskId));
  }
  // CONDUIT Subscription (T1252) — only emitted for tier 1/2 when the
  // orchestrator has configured A2A wave coordination for this task.
  if (tier >= 1 && input.conduitSubscription) {
    authoredSections.push(buildConduitSubscriptionBlock(input.conduitSubscription));
  }
  authoredSections.push(buildFilePathsBlock(taskId, outputDir, rcasdDir, testRunsDir));
  authoredSections.push(buildStageGuidance(protocol, rcasdDir, outputDir));
  authoredSections.push(buildEvidenceGateBlock(taskId));
  authoredSections.push(buildQualityGateBlock());

  // Tier-specific content — tier 0 pointer is authored; tier 1/2 embeds
  // are verbatim and therefore land in `embeddedSections`.
  //
  // When the caller sets `skipCleoInjectionEmbed` (harness already has
  // CLEO-INJECTION.md loaded), the ~9KB embed is replaced by a one-line
  // pointer. The pointer is authored content (no risk of `{{TOKEN}}`
  // false-positives), so it goes into `authoredSections`.
  const shouldDedupInjection = input.skipCleoInjectionEmbed === true;
  if (tier === 0) {
    authoredSections.push(buildTier0ProtocolPointer());
  } else if (tier === 1) {
    if (shouldDedupInjection) {
      authoredSections.push(buildTier1InjectionPointer());
    } else {
      embeddedSections.push(buildTier1InjectionEmbed());
    }
  } else {
    // tier 2
    if (shouldDedupInjection) {
      authoredSections.push(buildTier1InjectionPointer());
    } else {
      embeddedSections.push(buildTier1InjectionEmbed());
    }
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
