/**
 * ADR Frontmatter Validator
 *
 * Reads all .cleo/adrs/*.md files, parses **Bold**: value frontmatter,
 * validates against schemas/adr-frontmatter.schema.json using Ajv,
 * and performs bidirectional cross-checks.
 *
 * Usage: npm run adr:validate
 * Exit 0 = clean, Exit 1 = violations found
 *
 * @see ADR-017 §5.1 for canonical frontmatter spec
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const ADRS_DIR = join(PROJECT_ROOT, '.cleo', 'adrs');
const SCHEMA_PATH = join(PROJECT_ROOT, 'schemas', 'adr-frontmatter.schema.json');

interface ParsedAdr {
  file: string;
  id: string;
  frontmatter: Record<string, string>;
}

interface ValidationError {
  file: string;
  field: string;
  message: string;
}

/** Extract ADR ID from filename: 'ADR-007-domain-consolidation.md' → 'ADR-007' */
function extractAdrId(filename: string): string {
  const match = filename.match(/^(ADR-\d+)/);
  return match ? match[1]! : filename.replace('.md', '');
}

/** Parse **Key**: value frontmatter pattern from markdown */
function parseFrontmatter(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split('\n');

  for (const line of lines) {
    // Stop at first --- separator (body content starts)
    if (line.trim() === '---') break;
    // Match **Key**: value pattern
    const match = line.match(/^\*\*([^*]+)\*\*:\s*(.+)$/);
    if (match) {
      result[match[1]!.trim()] = match[2]!.trim();
    }
  }

  return result;
}

/** Load and parse all ADR files from .cleo/adrs/ (excludes archive/) */
function loadAdrs(): ParsedAdr[] {
  if (!existsSync(ADRS_DIR)) {
    console.error(`ERROR: ADR directory not found: ${ADRS_DIR}`);
    process.exit(1);
  }

  return readdirSync(ADRS_DIR)
    .filter(f => f.endsWith('.md') && f.match(/^ADR-\d+/))
    .sort()
    .map(filename => {
      const filePath = join(ADRS_DIR, filename);
      const content = readFileSync(filePath, 'utf-8');
      return {
        file: `.cleo/adrs/${filename}`,
        id: extractAdrId(filename),
        frontmatter: parseFrontmatter(content),
      };
    });
}

/** Perform bidirectional relationship checks across all ADRs */
function checkBidirectional(adrs: ParsedAdr[]): ValidationError[] {
  const errors: ValidationError[] = [];
  const adrMap = new Map(adrs.map(a => [a.id, a]));

  for (const adr of adrs) {
    const fm = adr.frontmatter;

    // If A supersedes B, B must have Superseded By: A
    if (fm['Supersedes']) {
      const supersededIds = fm['Supersedes'].split(',').map(s => s.trim().replace(/\s+\(.*\)/, ''));
      for (const targetId of supersededIds) {
        if (!targetId.match(/^ADR-\d+$/)) {
          errors.push({ file: adr.file, field: 'Supersedes', message: `Invalid ADR reference format: "${targetId}" (expected ADR-NNN)` });
          continue;
        }
        const target = adrMap.get(targetId);
        if (target && target.frontmatter['Superseded By'] !== adr.id) {
          errors.push({
            file: adr.file,
            field: 'Supersedes',
            message: `${adr.id} supersedes ${targetId}, but ${targetId} is missing "**Superseded By**: ${adr.id}"`,
          });
        }
      }
    }

    // If A amends B, B should have Amended By including A
    if (fm['Amends']) {
      const amendsIds = fm['Amends'].split(',').map(s => s.trim().replace(/\s+\(.*\)/, '').replace(/\s+§.*/, ''));
      for (const targetId of amendsIds) {
        if (!targetId.match(/^ADR-\d+$/)) continue; // Skip free-form text
        const target = adrMap.get(targetId);
        if (target) {
          const amendedBy = target.frontmatter['Amended By'] ?? '';
          if (!amendedBy.includes(adr.id)) {
            errors.push({
              file: adr.file,
              field: 'Amends',
              message: `${adr.id} amends ${targetId}, but ${targetId} is missing "${adr.id}" in "**Amended By**"`,
            });
          }
        }
      }
    }

    // Validate Related Tasks format (T#### pattern)
    if (fm['Related Tasks']) {
      const taskIds = fm['Related Tasks'].split(',').map(s => s.trim());
      for (const taskId of taskIds) {
        if (!taskId.match(/^T\d{3,5}$/)) {
          errors.push({ file: adr.file, field: 'Related Tasks', message: `Invalid task ID format: "${taskId}" (expected T#### or T#####)` });
        }
      }
    }

    // Conditional: accepted ADRs should have Accepted date
    if (fm['Status'] === 'accepted' && !fm['Accepted']) {
      errors.push({ file: adr.file, field: 'Accepted', message: 'Status=accepted requires Accepted date field' });
    }

    // Conditional: superseded ADRs must have Superseded By
    if (fm['Status'] === 'superseded' && !fm['Superseded By']) {
      errors.push({ file: adr.file, field: 'Superseded By', message: 'Status=superseded requires "Superseded By" field' });
    }
  }

  return errors;
}

async function main(): Promise<void> {
  console.log('Validating ADR frontmatter...\n');

  // Load schema
  if (!existsSync(SCHEMA_PATH)) {
    console.error(`ERROR: Schema not found: ${SCHEMA_PATH}`);
    process.exit(1);
  }
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf-8'));
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  // Load ADRs
  const adrs = loadAdrs();
  console.log(`Checking ${adrs.length} ADR files...\n`);

  const errors: ValidationError[] = [];

  // Schema validation
  for (const adr of adrs) {
    const valid = validate(adr.frontmatter);
    if (!valid && validate.errors) {
      for (const err of validate.errors) {
        const field = err.instancePath ? err.instancePath.replace('/', '') : (err.params as Record<string, unknown>)['additionalProperty'] as string ?? 'root';
        errors.push({
          file: adr.file,
          field,
          message: err.message ?? 'Validation error',
        });
      }
    }
  }

  // Bidirectional checks
  const bidirErrors = checkBidirectional(adrs);
  errors.push(...bidirErrors);

  // Report
  if (errors.length === 0) {
    console.log(`All ${adrs.length} ADRs passed validation.\n`);
    process.exit(0);
  } else {
    console.log(`Found ${errors.length} violation(s):\n`);
    for (const err of errors) {
      console.log(`  ${err.file}: [${err.field}] ${err.message}`);
    }
    console.log('');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
