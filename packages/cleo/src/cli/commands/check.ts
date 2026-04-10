/**
 * CLI check command group — dispatches to the check domain.
 *
 * Provides CLI access to:
 * - `cleo check schema <type>` — schema validation
 * - `cleo check coherence` — coherence check across task data
 * - `cleo check task <taskId>` — generic task validation
 * - `cleo check output <filePath>` — validate an agent output file
 * - `cleo check chain-validate <file>` — validate a WarpChain definition
 * - `cleo check protocol <protocolType>` — RFC 2119 protocol validation for
 *   any of the 12 supported protocols (research, consensus,
 *   architecture-decision, specification, decomposition, implementation,
 *   contribution, validation, testing, release, artifact-publish,
 *   provenance). Routes through `packages/cleo/src/dispatch/domains/check.ts`
 *   to the engine ops in `validate-engine.ts`, which delegate to the pure
 *   validators in `packages/core/src/orchestration/protocol-validators.ts`.
 *
 * @task T132
 * @task T260 — generic protocol subcommand exposing all 12 protocols
 * @task T476 — output and chain-validate subcommands
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

/**
 * The 12 supported protocol types — must stay in sync with
 * `packages/core/src/orchestration/protocol-validators.ts#PROTOCOL_TYPES`.
 *
 * @task T260
 */
const SUPPORTED_PROTOCOL_TYPES = [
  'research',
  'consensus',
  'architecture-decision',
  'specification',
  'decomposition',
  'implementation',
  'contribution',
  'validation',
  'testing',
  'release',
  'artifact-publish',
  'provenance',
] as const;

/** Register the check command group. */
export function registerCheckCommand(program: Command): void {
  const check = program.command('check').description('Validation and compliance checks');

  check
    .command('schema <type>')
    .description('Validate schema (type: todo, config, archive, log, sessions)')
    .action(async (type: string) => {
      await dispatchFromCli('query', 'check', 'schema', { type }, { command: 'check' });
    });

  check
    .command('coherence')
    .description('Run coherence check across task data')
    .action(async () => {
      await dispatchFromCli('query', 'check', 'coherence', {}, { command: 'check' });
    });

  check
    .command('task <taskId>')
    .description('Validate a specific task')
    .action(async (taskId: string) => {
      await dispatchFromCli('query', 'check', 'task', { taskId }, { command: 'check' });
    });

  check
    .command('output <filePath>')
    .description('Validate an agent output file against the manifest schema')
    .option('--task-id <id>', 'Task ID the output file belongs to')
    .action(async (filePath: string, opts: Record<string, unknown>) => {
      await dispatchFromCli(
        'query',
        'check',
        'output',
        {
          filePath,
          taskId: opts['taskId'] as string | undefined,
        },
        { command: 'check', operation: 'check.output' },
      );
    });

  check
    .command('chain-validate <file>')
    .description('Validate a WarpChain definition from a JSON file')
    .action(async (file: string) => {
      const { readFileSync } = await import('node:fs');
      let chain: unknown;
      try {
        chain = JSON.parse(readFileSync(file, 'utf8'));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Failed to read or parse chain file: ${message}`);
        process.exit(2);
      }
      await dispatchFromCli(
        'query',
        'check',
        'chain.validate',
        { chain },
        { command: 'check', operation: 'check.chain.validate' },
      );
    });

  check
    .command('protocol <protocolType>')
    .description(
      `Validate any of the 12 RCASD-IVTR+C protocols: ${SUPPORTED_PROTOCOL_TYPES.join(', ')}`,
    )
    .option('--task-id <id>', 'Task ID to validate (mode=task, default)')
    .option('--manifest-file <file>', 'Manifest file to validate (mode=manifest)')
    .option('--strict', 'Exit with error code on violations')
    // consensus
    .option('--voting-matrix-file <file>', 'consensus: voting matrix JSON file')
    // decomposition
    .option('--epic-id <id>', 'decomposition: parent epic ID')
    .option('--sibling-count <n>', 'decomposition: actual sibling count', Number)
    .option('--max-siblings <n>', 'decomposition: configured max siblings', Number)
    // specification
    .option('--spec-file <file>', 'specification: path to spec markdown')
    // research
    .option('--has-code-changes', 'research: code changes detected (forbidden)')
    // implementation / contribution
    .option('--has-task-tags', 'implementation: @task tags present in code')
    .option('--has-contribution-tags', 'contribution: @contribution tags present')
    // release
    .option('--version <v>', 'release: target version (semver/calver)')
    .option('--has-changelog', 'release: changelog updated')
    // artifact-publish
    .option(
      '--artifact-type <t>',
      'artifact-publish: artifact handler (npm-package, docker-image, ...)',
    )
    .option('--build-passed', 'artifact-publish: build step succeeded')
    // provenance
    .option('--has-attestation', 'provenance: in-toto attestation generated')
    .option('--has-sbom', 'provenance: SBOM (CycloneDX/SPDX) generated')
    // architecture-decision
    .option('--adr-content <text>', 'ADR: ADR markdown body for section check')
    .option('--status <s>', 'ADR: lifecycle status (proposed|accepted|superseded|deprecated)')
    .option('--hitl-reviewed', 'ADR: HITL review completed')
    .option('--downstream-flagged', 'ADR: downstream artifacts flagged for review')
    .option('--persisted-in-db', 'ADR: persisted in canonical decisions table')
    // validation stage
    .option('--spec-match-confirmed', 'validation: implementation matches spec')
    .option('--test-suite-passed', 'validation: existing test suite passed')
    .option('--protocol-compliance-checked', 'validation: upstream protocols checked')
    // testing stage (IVT loop)
    .option('--framework <name>', 'testing: detected test framework')
    .option('--tests-run <n>', 'testing: total tests executed', Number)
    .option('--tests-passed <n>', 'testing: tests that passed', Number)
    .option('--tests-failed <n>', 'testing: tests that failed', Number)
    .option('--coverage-percent <n>', 'testing: coverage percentage', Number)
    .option('--coverage-threshold <n>', 'testing: configured coverage threshold', Number)
    .option('--ivt-loop-converged', 'testing: IVT loop converged on spec')
    .option('--ivt-loop-iterations <n>', 'testing: IVT iteration count', Number)
    .action(async (protocolType: string, opts: Record<string, unknown>) => {
      if (!(SUPPORTED_PROTOCOL_TYPES as readonly string[]).includes(protocolType)) {
        console.error(
          `Unknown protocol type "${protocolType}". Supported: ${SUPPORTED_PROTOCOL_TYPES.join(', ')}`,
        );
        process.exit(2);
      }
      const mode: 'task' | 'manifest' = opts['manifestFile'] ? 'manifest' : 'task';
      await dispatchFromCli(
        'query',
        'check',
        'protocol',
        {
          protocolType,
          mode,
          taskId: opts['taskId'] as string | undefined,
          manifestFile: opts['manifestFile'] as string | undefined,
          strict: opts['strict'] as boolean | undefined,
          // consensus
          votingMatrixFile: opts['votingMatrixFile'] as string | undefined,
          // decomposition
          epicId: opts['epicId'] as string | undefined,
          siblingCount: opts['siblingCount'] as number | undefined,
          maxSiblings: opts['maxSiblings'] as number | undefined,
          // specification
          specFile: opts['specFile'] as string | undefined,
          // research
          hasCodeChanges: opts['hasCodeChanges'] as boolean | undefined,
          // implementation / contribution
          hasTaskTags: opts['hasTaskTags'] as boolean | undefined,
          hasContributionTags: opts['hasContributionTags'] as boolean | undefined,
          // release
          version: opts['version'] as string | undefined,
          hasChangelog: opts['hasChangelog'] as boolean | undefined,
          // artifact-publish
          artifactType: opts['artifactType'] as string | undefined,
          buildPassed: opts['buildPassed'] as boolean | undefined,
          // provenance
          hasAttestation: opts['hasAttestation'] as boolean | undefined,
          hasSbom: opts['hasSbom'] as boolean | undefined,
          // architecture-decision
          adrContent: opts['adrContent'] as string | undefined,
          status: opts['status'] as string | undefined,
          hitlReviewed: opts['hitlReviewed'] as boolean | undefined,
          downstreamFlagged: opts['downstreamFlagged'] as boolean | undefined,
          persistedInDb: opts['persistedInDb'] as boolean | undefined,
          // validation stage
          specMatchConfirmed: opts['specMatchConfirmed'] as boolean | undefined,
          testSuitePassed: opts['testSuitePassed'] as boolean | undefined,
          protocolComplianceChecked: opts['protocolComplianceChecked'] as boolean | undefined,
          // testing stage (IVT loop)
          framework: opts['framework'] as string | undefined,
          testsRun: opts['testsRun'] as number | undefined,
          testsPassed: opts['testsPassed'] as number | undefined,
          testsFailed: opts['testsFailed'] as number | undefined,
          coveragePercent: opts['coveragePercent'] as number | undefined,
          coverageThreshold: opts['coverageThreshold'] as number | undefined,
          ivtLoopConverged: opts['ivtLoopConverged'] as boolean | undefined,
          ivtLoopIterations: opts['ivtLoopIterations'] as number | undefined,
        },
        { command: 'check' },
      );
    });
}
