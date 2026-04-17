/**
 * CLI check command group — dispatches to the check domain.
 *
 * Subcommands: schema, coherence, task, output, chain-validate, canon, protocol
 * @task T132
 * @task T260 — generic protocol subcommand exposing all 12 protocols
 * @task T476 — output and chain-validate subcommands
 */

import { defineCommand } from 'citty';
import { dispatchFromCli } from '../../dispatch/adapters/cli.js';

/**
 * The 12 supported protocol types — must stay in sync with
 * packages/core/src/orchestration/protocol-validators.ts#PROTOCOL_TYPES.
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

/** cleo check schema — validate schema by type */
const checkSchemaCommand = defineCommand({
  meta: {
    name: 'schema',
    description: 'Validate schema (type: todo, config, archive, log, sessions)',
  },
  args: { type: { type: 'positional', description: 'Schema type to validate', required: true } },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'schema',
      { type: args.type as string },
      { command: 'check' },
    );
  },
});

/** cleo check coherence — run coherence check across task data */
const checkCoherenceCommand = defineCommand({
  meta: { name: 'coherence', description: 'Run coherence check across task data' },
  async run() {
    await dispatchFromCli('query', 'check', 'coherence', {}, { command: 'check' });
  },
});

/** cleo check task — validate a specific task */
const checkTaskCommand = defineCommand({
  meta: { name: 'task', description: 'Validate a specific task' },
  args: { taskId: { type: 'positional', description: 'Task ID to validate', required: true } },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'task',
      { taskId: args.taskId as string },
      { command: 'check' },
    );
  },
});

/** cleo check output — validate an agent output file against the manifest schema */
const checkOutputCommand = defineCommand({
  meta: {
    name: 'output',
    description: 'Validate an agent output file against the manifest schema',
  },
  args: {
    filePath: { type: 'positional', description: 'Path to agent output file', required: true },
    'task-id': { type: 'string', description: 'Task ID the output file belongs to' },
  },
  async run({ args }) {
    await dispatchFromCli(
      'query',
      'check',
      'output',
      { filePath: args.filePath as string, taskId: args['task-id'] as string | undefined },
      { command: 'check', operation: 'check.output' },
    );
  },
});

/** cleo check chain-validate — validate a WarpChain definition from a JSON file */
const checkChainValidateCommand = defineCommand({
  meta: {
    name: 'chain-validate',
    description: 'Validate a WarpChain definition from a JSON file',
  },
  args: {
    file: {
      type: 'positional',
      description: 'JSON file containing the WarpChain definition',
      required: true,
    },
  },
  async run({ args }) {
    const { readFileSync } = await import('node:fs');
    let chain: unknown;
    try {
      chain = JSON.parse(readFileSync(args.file as string, 'utf8'));
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
  },
});

/** cleo check canon — CI gate: detect canon drift between docs and live code */
const checkCanonCommand = defineCommand({
  meta: { name: 'canon', description: 'CI gate: detect canon drift between docs and live code' },
  async run() {
    await dispatchFromCli('query', 'check', 'canon', {}, { command: 'check' });
  },
});

/** cleo check protocol — validate any of the 12 RCASD-IVTR+C protocols */
const checkProtocolCommand = defineCommand({
  meta: {
    name: 'protocol',
    description: `Validate any of the 12 RCASD-IVTR+C protocols: ${SUPPORTED_PROTOCOL_TYPES.join(', ')}`,
  },
  args: {
    protocolType: {
      type: 'positional',
      description: 'Protocol type to validate',
      required: true,
    },
    'task-id': { type: 'string', description: 'Task ID to validate (mode=task, default)' },
    'manifest-file': { type: 'string', description: 'Manifest file to validate (mode=manifest)' },
    strict: { type: 'boolean', description: 'Exit with error code on violations' },
    'voting-matrix-file': { type: 'string', description: 'consensus: voting matrix JSON file' },
    'epic-id': { type: 'string', description: 'decomposition: parent epic ID' },
    'sibling-count': { type: 'string', description: 'decomposition: actual sibling count' },
    'max-siblings': { type: 'string', description: 'decomposition: configured max siblings' },
    'spec-file': { type: 'string', description: 'specification: path to spec markdown' },
    'has-code-changes': {
      type: 'boolean',
      description: 'research: code changes detected (forbidden)',
    },
    'has-task-tags': {
      type: 'boolean',
      description: 'implementation: @task tags present in code',
    },
    'has-contribution-tags': {
      type: 'boolean',
      description: 'contribution: @contribution tags present',
    },
    version: { type: 'string', description: 'release: target version (semver/calver)' },
    'has-changelog': { type: 'boolean', description: 'release: changelog updated' },
    'artifact-type': {
      type: 'string',
      description: 'artifact-publish: artifact handler (npm-package, docker-image, ...)',
    },
    'build-passed': { type: 'boolean', description: 'artifact-publish: build step succeeded' },
    'has-attestation': {
      type: 'boolean',
      description: 'provenance: in-toto attestation generated',
    },
    'has-sbom': {
      type: 'boolean',
      description: 'provenance: SBOM (CycloneDX/SPDX) generated',
    },
    'adr-content': { type: 'string', description: 'ADR: ADR markdown body for section check' },
    status: {
      type: 'string',
      description: 'ADR: lifecycle status (proposed|accepted|superseded|deprecated)',
    },
    'hitl-reviewed': { type: 'boolean', description: 'ADR: HITL review completed' },
    'downstream-flagged': {
      type: 'boolean',
      description: 'ADR: downstream artifacts flagged for review',
    },
    'persisted-in-db': {
      type: 'boolean',
      description: 'ADR: persisted in canonical decisions table',
    },
    'spec-match-confirmed': {
      type: 'boolean',
      description: 'validation: implementation matches spec',
    },
    'test-suite-passed': {
      type: 'boolean',
      description: 'validation: existing test suite passed',
    },
    'protocol-compliance-checked': {
      type: 'boolean',
      description: 'validation: upstream protocols checked',
    },
    framework: { type: 'string', description: 'testing: detected test framework' },
    'tests-run': { type: 'string', description: 'testing: total tests executed' },
    'tests-passed': { type: 'string', description: 'testing: tests that passed' },
    'tests-failed': { type: 'string', description: 'testing: tests that failed' },
    'coverage-percent': { type: 'string', description: 'testing: coverage percentage' },
    'coverage-threshold': { type: 'string', description: 'testing: configured coverage threshold' },
    'ivt-loop-converged': { type: 'boolean', description: 'testing: IVT loop converged on spec' },
    'ivt-loop-iterations': { type: 'string', description: 'testing: IVT iteration count' },
  },
  async run({ args }) {
    const protocolType = args.protocolType as string;
    if (!(SUPPORTED_PROTOCOL_TYPES as readonly string[]).includes(protocolType)) {
      console.error(
        `Unknown protocol type "${protocolType}". Supported: ${SUPPORTED_PROTOCOL_TYPES.join(', ')}`,
      );
      process.exit(2);
    }
    const mode: 'task' | 'manifest' = args['manifest-file'] ? 'manifest' : 'task';
    await dispatchFromCli(
      'query',
      'check',
      'protocol',
      {
        protocolType,
        mode,
        taskId: args['task-id'] as string | undefined,
        manifestFile: args['manifest-file'] as string | undefined,
        strict: args.strict as boolean | undefined,
        votingMatrixFile: args['voting-matrix-file'] as string | undefined,
        epicId: args['epic-id'] as string | undefined,
        siblingCount:
          args['sibling-count'] !== undefined
            ? Number.parseInt(args['sibling-count'] as string, 10)
            : undefined,
        maxSiblings:
          args['max-siblings'] !== undefined
            ? Number.parseInt(args['max-siblings'] as string, 10)
            : undefined,
        specFile: args['spec-file'] as string | undefined,
        hasCodeChanges: args['has-code-changes'] as boolean | undefined,
        hasTaskTags: args['has-task-tags'] as boolean | undefined,
        hasContributionTags: args['has-contribution-tags'] as boolean | undefined,
        version: args.version as string | undefined,
        hasChangelog: args['has-changelog'] as boolean | undefined,
        artifactType: args['artifact-type'] as string | undefined,
        buildPassed: args['build-passed'] as boolean | undefined,
        hasAttestation: args['has-attestation'] as boolean | undefined,
        hasSbom: args['has-sbom'] as boolean | undefined,
        adrContent: args['adr-content'] as string | undefined,
        status: args.status as string | undefined,
        hitlReviewed: args['hitl-reviewed'] as boolean | undefined,
        downstreamFlagged: args['downstream-flagged'] as boolean | undefined,
        persistedInDb: args['persisted-in-db'] as boolean | undefined,
        specMatchConfirmed: args['spec-match-confirmed'] as boolean | undefined,
        testSuitePassed: args['test-suite-passed'] as boolean | undefined,
        protocolComplianceChecked: args['protocol-compliance-checked'] as boolean | undefined,
        framework: args.framework as string | undefined,
        testsRun:
          args['tests-run'] !== undefined
            ? Number.parseInt(args['tests-run'] as string, 10)
            : undefined,
        testsPassed:
          args['tests-passed'] !== undefined
            ? Number.parseInt(args['tests-passed'] as string, 10)
            : undefined,
        testsFailed:
          args['tests-failed'] !== undefined
            ? Number.parseInt(args['tests-failed'] as string, 10)
            : undefined,
        coveragePercent:
          args['coverage-percent'] !== undefined
            ? Number.parseFloat(args['coverage-percent'] as string)
            : undefined,
        coverageThreshold:
          args['coverage-threshold'] !== undefined
            ? Number.parseFloat(args['coverage-threshold'] as string)
            : undefined,
        ivtLoopConverged: args['ivt-loop-converged'] as boolean | undefined,
        ivtLoopIterations:
          args['ivt-loop-iterations'] !== undefined
            ? Number.parseInt(args['ivt-loop-iterations'] as string, 10)
            : undefined,
      },
      { command: 'check' },
    );
  },
});

/**
 * Root check command group — validation and compliance checks.
 *
 * Dispatches to the check domain. Supports schema validation, coherence,
 * task checks, output validation, WarpChain validation, canon drift
 * detection, and RCASD-IVTR+C protocol checks.
 */
export const checkCommand = defineCommand({
  meta: { name: 'check', description: 'Validation and compliance checks' },
  subCommands: {
    schema: checkSchemaCommand,
    coherence: checkCoherenceCommand,
    task: checkTaskCommand,
    output: checkOutputCommand,
    'chain-validate': checkChainValidateCommand,
    canon: checkCanonCommand,
    protocol: checkProtocolCommand,
  },
});
