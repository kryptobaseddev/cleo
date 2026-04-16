/**
 * emit-schemas.mjs — JSON Schema emitter for @cleocode/contracts
 *
 * Emits JSON Schema files at packages/contracts/schemas/*.schema.json
 * for LLM agent consumption via zod-to-json-schema.
 *
 * Schemas emitted:
 *   - Task            → task.schema.json          (built from Zod-compatible subset)
 *   - AcceptanceGate  → acceptance-gate.schema.json
 *   - Attachment      → attachment.schema.json
 *   - GateResult      → gate-result.schema.json
 *   - TaskEvidence    → task-evidence.schema.json
 *
 * @epic T760
 * @task T803
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';

// ─── Locate the dist directory (built schemas from compiled output) ───────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemasDir = resolve(__dirname, '..', 'schemas');

// Import schemas from compiled dist (this script runs post-build)
const {
  acceptanceGateSchema,
  acceptanceGateResultSchema,
  attachmentSchema,
  gateResultDetailsSchema,
  taskEvidenceSchema,
} = await import('../dist/index.js');

// ─── Task schema (built manually from field-level schemas) ────────────────────
// Task is a complex interface, not fully Zod-backed. We emit a JSON Schema
// that describes the machine-verifiable subset relevant to LLM tool-use.
const { z } = await import('zod');

const taskSummarySchema = z.object({
  id: z.string().describe('Task identifier (e.g. "T801")'),
  title: z.string().min(1).describe('Short task title'),
  status: z
    .enum(['todo', 'in-progress', 'done', 'blocked', 'cancelled', 'archived'])
    .describe('Current task status'),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional().describe('Task priority'),
  size: z.enum(['small', 'medium', 'large']).optional().describe('Task size estimate'),
  type: z.enum(['epic', 'task', 'subtask']).optional().describe('Task hierarchy type'),
  parentId: z.string().nullable().optional().describe('Parent task ID'),
  acceptance: z
    .array(z.union([z.string().min(1), acceptanceGateSchema]))
    .describe('Acceptance criteria: free-text strings or structured AcceptanceGate objects'),
});

// ─── Schema registry ──────────────────────────────────────────────────────────

const schemaMap = {
  'task.schema.json': {
    schema: taskSummarySchema,
    title: 'Task',
    description: 'CLEO task summary — machine-verifiable fields for LLM tool-use',
  },
  'acceptance-gate.schema.json': {
    schema: acceptanceGateSchema,
    title: 'AcceptanceGate',
    description: 'Machine-verifiable acceptance gate attached to a CLEO task',
  },
  'attachment.schema.json': {
    schema: attachmentSchema,
    title: 'Attachment',
    description: 'Content artifact (file, URL, blob, llms-txt, or llmtxt-doc) attachable to a CLEO owner',
  },
  'gate-result.schema.json': {
    schema: acceptanceGateResultSchema,
    title: 'GateResult',
    description: 'Result of running one acceptance gate — persisted to lifecycle_gate_results',
  },
  'gate-result-details.schema.json': {
    schema: gateResultDetailsSchema,
    title: 'GateResultDetails',
    description: 'Kind-specific detail payload for a GateResult — discriminated by kind',
  },
  'task-evidence.schema.json': {
    schema: taskEvidenceSchema,
    title: 'TaskEvidence',
    description: 'Typed evidence artifact attached to a verification record — discriminated by kind',
  },
};

// ─── Emit ─────────────────────────────────────────────────────────────────────

mkdirSync(schemasDir, { recursive: true });

let emitted = 0;
for (const [filename, { schema, title, description }] of Object.entries(schemaMap)) {
  const jsonSchema = zodToJsonSchema(schema, {
    name: title,
    $refStrategy: 'none', // inline all refs for portability
    markdownDescription: true,
  });

  // Augment top-level metadata
  const output = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title,
    description,
    ...jsonSchema,
  };

  const outPath = resolve(schemasDir, filename);
  writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`  emitted: schemas/${filename}`);
  emitted++;
}

console.log(`\nDone — ${emitted} schema files written to packages/contracts/schemas/`);
