#!/usr/bin/env node

/**
 * LAFS Conformance CLI — diagnostic/human-readable tool.
 *
 * This CLI is a **diagnostic utility** that validates envelopes and flags
 * against the LAFS schema and conformance checks. It is NOT itself a
 * LAFS-conformant envelope producer. Its output is for human consumption
 * and CI pipelines, not for machine-to-machine chaining.
 *
 * Exemption: The CLI is exempt from LAFS envelope conformance requirements.
 * Its output format is not a LAFS envelope and MUST NOT be validated as one.
 *
 * @task T042
 * @epic T034
 */

import { readFile } from 'node:fs/promises';
import { runEnvelopeConformance, runFlagConformance } from './conformance.js';

interface CliArgs {
  envelopePath?: string;
  flagsPath?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (current === '--envelope' && next) {
      args.envelopePath = next;
      i += 1;
    } else if (current === '--flags' && next) {
      args.flagsPath = next;
      i += 1;
    }
  }
  return args;
}

async function readJson(path: string): Promise<unknown> {
  const content = await readFile(path, 'utf8');
  return JSON.parse(content) as unknown;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const reports: unknown[] = [];

  if (args.envelopePath) {
    const envelope = await readJson(args.envelopePath);
    reports.push({ name: 'envelope', report: runEnvelopeConformance(envelope) });
  }

  if (args.flagsPath) {
    const flags = await readJson(args.flagsPath);
    reports.push({ name: 'flags', report: runFlagConformance(flags as never) });
  }

  if (reports.length === 0) {
    throw new Error('Provide --envelope and/or --flags JSON files.');
  }

  console.log(JSON.stringify({ success: true, reports }, null, 2));
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        success: false,
        error: {
          code: 'E_INTERNAL_UNEXPECTED',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
